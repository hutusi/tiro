import { gfm } from "@joplin/turndown-plugin-gfm";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { mathTurndownRule, prepareForClipping } from "./dom-prepare.ts";
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
  // Recover math and code languages first — Readability prunes low-text
  // subtrees, and a formula it drops cannot be recovered afterwards. The
  // clone, never the live page: this rewrites the nodes it touches.
  const { hasMath } = prepareForClipping(clone);
  // Snapshot before Readability, which consumes the clone. Serializing always
  // costs less than a second cloneNode, and the fallback needs the prepared
  // DOM as much as the happy path does.
  const preparedBody = clone.body?.innerHTML ?? document.body.innerHTML;
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(clone).parse();
  } catch {
    article = null;
  }

  const readabilityFailed = article?.content == null || article.content === "";
  // Readability resolves relative URLs to absolute ones; the raw-body
  // fallback does not, which is one reason the failure is flagged.
  const html = readabilityFailed ? preparedBody : (article?.content ?? "");

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.use(gfm);
  turndown.addRule("tiroMath", mathTurndownRule);
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
      hasMath,
    },
  };
  chrome.runtime.sendMessage(message).catch(() => {
    // Expected when the popup closed before the result arrived — the
    // receiving end no longer exists and the clip is simply abandoned.
  });
})();
