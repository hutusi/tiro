import { gfm } from "@joplin/turndown-plugin-gfm";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { ClipResultMessage } from "./messages.ts";

/**
 * Runs inside the page (isolated world) via chrome.scripting.executeScript.
 * Extracts the article, converts it to Markdown, and messages the result
 * back to the popup — the return value of file-based injection is not a
 * reliable channel, messaging is.
 */
(() => {
  // Readability destructively mutates its input; always parse a clone.
  const clone = document.cloneNode(true) as Document;
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(clone).parse();
  } catch {
    article = null;
  }

  const readabilityFailed = article?.content == null || article.content === "";
  // Readability resolves relative URLs to absolute ones; the raw-body
  // fallback does not, which is one reason the failure is flagged.
  const html = readabilityFailed
    ? document.body.innerHTML
    : (article?.content ?? "");

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.use(gfm);
  const markdown = turndown.turndown(html);

  const message: ClipResultMessage = {
    type: "tiro-clip-result",
    payload: {
      url: location.href,
      title: (article?.title ?? "").trim() || document.title,
      excerpt: (article?.excerpt ?? "").trim(),
      author: (article?.byline ?? "").trim(),
      markdown,
      readabilityFailed,
    },
  };
  chrome.runtime.sendMessage(message).catch(() => {
    // Expected when the popup closed before the result arrived — the
    // receiving end no longer exists and the clip is simply abandoned.
  });
})();
