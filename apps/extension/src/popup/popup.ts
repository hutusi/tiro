import { slugForUrl } from "@tiro/shared";
import { buildClipFile } from "../clip.ts";
import { describeClipError } from "../errors.ts";
import { encodeBase64Utf8, findExistingIndex, putFile } from "../github.ts";
import { type ClipResultMessage, isClipResult } from "../messages.ts";
import {
  acceptDisclosure,
  hasClipped,
  isConfigComplete,
  loadConfig,
  loadDisclosure,
  needsDisclosure,
  recordClip,
} from "../storage.ts";

const el = {
  status: document.getElementById("status") as HTMLDivElement,
  already: document.getElementById("already") as HTMLDivElement,
  disclosure: document.getElementById("disclosure") as HTMLDivElement,
  accept: document.getElementById("accept") as HTMLButtonElement,
  preview: document.getElementById("preview") as HTMLDivElement,
  title: document.getElementById("article-title") as HTMLDivElement,
  meta: document.getElementById("article-meta") as HTMLDivElement,
  warning: document.getElementById("warning") as HTMLDivElement,
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
  const config = await loadConfig();
  const configured = isConfigComplete(config);
  if (!configured) {
    setStatus("Set your GitHub repository and token in Settings first.", true);
  }

  let result: ClipResultMessage["payload"] | null = null;

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isClipResult(message)) return;
    result = message.payload;
    el.preview.hidden = false;
    el.title.textContent = result.title;
    const words = result.markdown.split(/\s+/).filter(Boolean).length;
    el.meta.textContent = `${new URL(result.url).hostname} · ${words} words`;
    el.warning.hidden = !result.readabilityFailed;
    if (configured) {
      el.clip.disabled = false;
      setStatus("Ready to clip.");
    }
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    tab?.id === undefined ||
    tab.url === undefined ||
    !/^https?:/.test(tab.url)
  ) {
    setStatus("This page cannot be clipped.", true);
    return;
  }
  const tabId = tab.id;
  const tabUrl = tab.url;

  // Best-effort hint from the local clip record — no network involved, so it
  // needs no disclosure and runs even before acceptance. The clip flow's own
  // GitHub lookup stays the authority on overwrite-vs-create.
  void slugForUrl(tabUrl)
    .then(hasClipped)
    .then((clipped) => {
      el.already.hidden = !clipped;
    })
    .catch(() => {});

  async function extract(): Promise<void> {
    if (configured) setStatus("Reading page…");
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["clipper.js"],
      });
    } catch (error) {
      setStatus(`Cannot read this page: ${String(error)}`, true);
      return;
    }

    // executeScript resolves when injection starts, not when the clipper
    // messages back; if the clipper dies mid-run the popup would otherwise sit
    // on "Reading page…" forever.
    setTimeout(() => {
      if (result === null) {
        setStatus(
          "The page did not produce a clip. Reload it and try again.",
          true,
        );
      }
    }, 10_000);
  }

  el.clip.addEventListener("click", () => {
    if (result === null) return;
    void (async (payload) => {
      el.clip.disabled = true;
      setStatus("Clipping…");
      try {
        const clippedAt = new Date().toISOString();
        const file = await buildClipFile({
          url: payload.url,
          title: payload.title,
          markdown: payload.markdown,
          excerpt: payload.excerpt,
          author: payload.author,
          readabilityFailed: payload.readabilityFailed,
          clippedAt,
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
        setStatus(existing !== null ? "Updated existing clip." : "Clipped.");
        el.view.href = `https://github.com/${config.owner}/${config.repo}/blob/${config.branch}/${path}`;
        el.view.hidden = false;
        await recordClip(file.slug, clippedAt);
      } catch (error) {
        console.error("clip failed:", error);
        setStatus(describeClipError(error), true);
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
          await extract();
        })();
      },
      { once: true },
    );
    return;
  }

  await extract();
}

void main();
