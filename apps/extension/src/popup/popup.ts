import { buildClipFile } from "../clip.ts";
import { encodeBase64Utf8, findExistingIndex, putFile } from "../github.ts";
import { type ClipResultMessage, isClipResult } from "../messages.ts";
import { isConfigComplete, loadConfig } from "../storage.ts";

const el = {
  status: document.getElementById("status") as HTMLDivElement,
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

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
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

  el.clip.addEventListener("click", () => {
    if (result === null) return;
    void (async (payload) => {
      el.clip.disabled = true;
      setStatus("Clipping…");
      try {
        const file = await buildClipFile({
          url: payload.url,
          title: payload.title,
          markdown: payload.markdown,
          excerpt: payload.excerpt,
          author: payload.author,
          readabilityFailed: payload.readabilityFailed,
          clippedAt: new Date().toISOString(),
        });
        const existing = await findExistingIndex(config, file.slug);
        const path = existing?.path ?? file.path;
        await putFile(config, {
          path,
          contentBase64: encodeBase64Utf8(file.content),
          message: `clip: ${file.title}`,
          ...(existing !== null ? { sha: existing.sha } : {}),
        });
        setStatus(existing !== null ? "Updated existing clip." : "Clipped.");
        el.view.href = `https://github.com/${config.owner}/${config.repo}/blob/${config.branch}/${path}`;
        el.view.hidden = false;
      } catch (error) {
        setStatus(String(error), true);
        el.clip.disabled = false;
      }
    })(result);
  });
}

void main();
