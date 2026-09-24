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
import { flushNow, recordToggle } from "./collections-worker.ts";
import { isCollectionMessage, POPUP_PORT } from "./messages.ts";
import { mirrorSyncedChange, reconcileDisabledSync } from "./storage.ts";

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
