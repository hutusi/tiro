// Clipping is driven entirely by the popup, which injects the clipper on
// demand (ADR 0005); the worker holds only work that must happen when no UI is
// open. Today that is two jobs, both about what the synced settings leave
// behind on a machine nobody is looking at (ADR 0022): keeping this machine's
// local copy current, so switching sync off elsewhere leaves it with the
// settings it had rather than whatever it last happened to read; and clearing
// synced settings that outlived the switch being turned off, so "sync is off"
// converges on "no token in sync".
//
// And, since collections (ADR 0029), the one writer of the collection queue:
// the popup messages toggles here rather than writing storage from a second
// realm, and closing the popup — its port disconnecting — is the cue to flush.
//
// And, since saved links (ADR 0034), "Clip link" in the context menu on any
// link: one file into the vault's inbox, which the next processing run turns
// into an article. The one thing the worker sends without the popup open, and
// only on that click.
import { flushNow, recordToggle } from "./collections-worker.ts";
import { getLocale, type Messages, messages } from "./i18n.ts";
import { type LinkSave, saveLink } from "./link-save.ts";
import { isCollectionMessage, POPUP_PORT } from "./messages.ts";
import {
  loadConfig,
  loadDisclosure,
  mirrorSyncedChange,
  needsDisclosure,
  reconcileDisabledSync,
} from "./storage.ts";

const LINK_MENU = "tiro-clip-link";

/** (Re)create the menu in the reader's language. On install and on every
 * start, so a language changed in Settings reaches it by the next start;
 * removed first, because creating an id that exists is an error. */
async function createLinkMenu(): Promise<void> {
  const m = messages(await getLocale());
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: LINK_MENU,
    title: m.linkMenu,
    contexts: ["link"],
  });
}

/** How a save went, on the toolbar button of the tab it came from: a badge
 * for a few seconds, and the reason as its tooltip. No notification — that
 * would be another permission for a line of text. */
async function showLinkSave(
  tabId: number | undefined,
  outcome: LinkSave,
  m: Messages,
): Promise<void> {
  const target = tabId === undefined ? {} : { tabId };
  const [text, color, title] =
    outcome.kind === "saved"
      ? ["✓", "#2f7d4f", m.linkSaved(outcome.url)]
      : outcome.kind === "exists"
        ? ["✓", "#6b6b6b", m.linkExists(outcome.url)]
        : outcome.kind === "failed"
          ? ["!", "#b3261e", m.linkFailed(outcome.error)]
          : [
              "!",
              "#b3261e",
              outcome.reason === "not-a-link"
                ? m.linkNotALink
                : outcome.reason === "unconfigured"
                  ? m.linkUnconfigured
                  : m.linkNoDisclosure,
            ];
  await chrome.action.setBadgeBackgroundColor({ ...target, color });
  await chrome.action.setBadgeText({ ...target, text });
  await chrome.action.setTitle({ ...target, title });
  // Back to the manifest's own title, not to "": an empty title is a
  // tooltip with nothing in it, not the default.
  const defaultTitle = chrome.runtime.getManifest().action?.default_title ?? "";
  setTimeout(() => {
    void chrome.action.setBadgeText({ ...target, text: "" });
    void chrome.action.setTitle({ ...target, title: defaultTitle });
  }, 6000);
}

chrome.runtime.onInstalled.addListener(() => {
  void createLinkMenu().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  void createLinkMenu().catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== LINK_MENU || info.linkUrl === undefined) return;
  const linkUrl = info.linkUrl;
  void (async () => {
    const m = messages(await getLocale());
    const outcome = await saveLink(linkUrl, {
      config: await loadConfig(),
      disclosed: !needsDisclosure(await loadDisclosure()),
    });
    await showLinkSave(tab?.id, outcome, m);
  })().catch(() => {});
});

// Registered at the top level, synchronously: MV3 only wakes a stopped service
// worker for listeners added that way, and a listener attached later would
// simply never fire.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  // Neither is worth an unhandled rejection in the worker: the read path
  // mirrors too, and the reconcile runs again on the next machine to see the
  // switch go off.
  void mirrorSyncedChange(changes).catch(() => {});
  void reconcileDisabledSync(changes).catch(() => {});
});

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse) => {
    // From an extension page — the popup — and nothing else. A content script
    // runs inside a web page, and a page must not be able to queue edits to the
    // owner's vault.
    if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return;
    if (!isCollectionMessage(message)) return;
    const work =
      message.type === "tiro-collection-flush"
        ? flushNow()
        : recordToggle(message).then(() => null);
    work.then(
      (result) => sendResponse({ ok: true, result }),
      (error: unknown) => sendResponse({ ok: false, error: String(error) }),
    );
    // Keeps the channel open for the asynchronous response.
    return true;
  },
);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== POPUP_PORT) return;
  // The popup closed. Whatever it queued goes now — a failure is recorded for
  // the next popup to show, and the queue is kept for the next flush.
  port.onDisconnect.addListener(() => {
    void flushNow().catch(() => {});
  });
});
