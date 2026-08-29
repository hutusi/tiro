import { slugForUrl } from "@tiro/shared";
import { buildClipFile } from "../clip.ts";
import { describeClipError } from "../errors.ts";
import { encodeBase64Utf8, findExistingIndex, putFile } from "../github.ts";
import { formatClipDate, getLocale, messages } from "../i18n.ts";
import { type ClipResultMessage, isClipResult } from "../messages.ts";
import {
  acceptDisclosure,
  isConfigComplete,
  lastClippedAt,
  loadConfig,
  loadDisclosure,
  needsDisclosure,
  recordClip,
} from "../storage.ts";
import { countWords } from "../words.ts";

const el = {
  status: document.getElementById("status") as HTMLDivElement,
  disclosure: document.getElementById("disclosure") as HTMLDivElement,
  disclosureTitle: document.getElementById(
    "disclosure-title",
  ) as HTMLHeadingElement,
  disclosureBody1: document.getElementById(
    "disclosure-body-1",
  ) as HTMLParagraphElement,
  disclosureBody2: document.getElementById(
    "disclosure-body-2",
  ) as HTMLParagraphElement,
  accept: document.getElementById("accept") as HTMLButtonElement,
  preview: document.getElementById("preview") as HTMLDivElement,
  title: document.getElementById("article-title") as HTMLDivElement,
  meta: document.getElementById("article-meta") as HTMLDivElement,
  warning: document.getElementById("warning") as HTMLDivElement,
  notice: document.getElementById("notice") as HTMLDivElement,
  clip: document.getElementById("clip") as HTMLButtonElement,
  view: document.getElementById("view") as HTMLAnchorElement,
  options: document.getElementById("options") as HTMLButtonElement,
};

function setStatus(message: string, isError = false): void {
  el.status.textContent = message;
  el.status.classList.toggle("error", isError);
}

el.options.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

async function main(): Promise<void> {
  const [config, locale] = await Promise.all([loadConfig(), getLocale()]);
  const m = messages(locale);

  // The HTML ships English defaults; localizing up front keeps the swap to a
  // single early paint instead of text changing under the user later.
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  el.disclosureTitle.textContent = m.disclosureTitle;
  el.disclosureBody1.textContent = m.disclosureBody1;
  el.disclosureBody2.textContent = m.disclosureBody2;
  el.accept.textContent = m.disclosureAccept;
  el.warning.textContent = m.warningReadability;
  el.notice.textContent = m.noticePreview;
  el.clip.textContent = m.clipButton;
  el.view.textContent = m.viewInVault;
  el.options.textContent = m.settingsLink;

  const configured = isConfigComplete(config);
  if (!configured) {
    setStatus(m.settingsFirst, true);
  }

  let result: ClipResultMessage["payload"] | null = null;
  let clippedAt: string | null = null;

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isClipResult(message)) return;
    result = message.payload;
    el.preview.hidden = false;
    el.title.textContent = result.title;
    el.meta.textContent = m.articleMeta(
      new URL(result.url).hostname,
      countWords(result.markdown),
    );
    el.warning.hidden = !result.readabilityFailed;
    if (configured) {
      el.clip.disabled = false;
      if (clippedAt !== null) {
        setStatus(m.alreadyClipped(formatClipDate(locale, clippedAt)));
        el.clip.textContent = m.reclipButton;
      } else {
        setStatus(m.readyToClip);
      }
    }
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    tab?.id === undefined ||
    tab.url === undefined ||
    !/^https?:/.test(tab.url)
  ) {
    setStatus(m.cannotClip, true);
    return;
  }
  const tabId = tab.id;
  const tabUrl = tab.url;

  async function extract(): Promise<void> {
    if (configured) setStatus(m.readingPage);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["clipper.js"],
      });
    } catch (error) {
      setStatus(m.cannotRead(String(error)), true);
      return;
    }

    // executeScript resolves when injection starts, not when the clipper
    // messages back; if the clipper dies mid-run the popup would otherwise sit
    // on "Reading page…" forever.
    setTimeout(() => {
      if (result === null) {
        setStatus(m.noClipResult, true);
      }
    }, 10_000);
  }

  // Best-effort state from the local clip record. Slug derivation and the
  // lookup are both local, but they still wait for an accepted disclosure so
  // the popup does nothing at all before consent. Awaiting the lookup before
  // extraction means the clip-result listener always sees it settled. The
  // clip flow's own GitHub lookup stays the authority on overwrite-vs-create.
  async function prepare(): Promise<void> {
    try {
      clippedAt = await lastClippedAt(config, await slugForUrl(tabUrl));
    } catch {
      clippedAt = null;
    }
    await extract();
  }

  el.clip.addEventListener("click", () => {
    if (result === null) return;
    void (async (payload) => {
      el.clip.disabled = true;
      setStatus(m.clipping);
      try {
        const nowIso = new Date().toISOString();
        const file = await buildClipFile({
          url: payload.url,
          title: payload.title,
          markdown: payload.markdown,
          excerpt: payload.excerpt,
          author: payload.author,
          readabilityFailed: payload.readabilityFailed,
          clippedAt: nowIso,
        });
        // The flat layout makes file.path deterministic; the lookup only
        // supplies the sha that turns the PUT into an overwrite.
        const existing = await findExistingIndex(config, file.slug);
        const path = file.path;
        await putFile(config, {
          path,
          contentBase64: encodeBase64Utf8(file.content),
          message: `clip: ${file.title}`,
          ...(existing !== null ? { sha: existing.sha } : {}),
        });
        setStatus(existing !== null ? m.updatedExisting : m.clipped);
        el.view.href = `https://github.com/${config.owner}/${config.repo}/blob/${config.branch}/${path}`;
        el.view.hidden = false;
        try {
          await recordClip(config, file.slug, nowIso);
        } catch {
          // The commit already succeeded; losing the hint record must not
          // relabel the clip as failed.
        }
      } catch (error) {
        console.error("clip failed:", error);
        setStatus(describeClipError(error, m), true);
        el.clip.disabled = false;
      }
    })(result);
  });

  // The page is read to build the preview, which happens before the Clip
  // click — so the disclosure has to gate the extraction itself, not the
  // upload. A store listing or privacy page does not satisfy this; the consent
  // has to be in the product UI and has to be an explicit action.
  if (needsDisclosure(await loadDisclosure())) {
    el.disclosure.hidden = false;
    // Hide the (disabled) clip button meanwhile, so the panel's Continue is the
    // only button on screen and cannot be mistaken for it.
    el.clip.hidden = true;
    el.accept.addEventListener(
      "click",
      () => {
        void (async () => {
          await acceptDisclosure(new Date().toISOString());
          el.disclosure.hidden = true;
          el.clip.hidden = false;
          await prepare();
        })();
      },
      { once: true },
    );
    return;
  }

  await prepare();
}

void main();
