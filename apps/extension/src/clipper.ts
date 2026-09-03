import { clipPage } from "./clip-page.ts";
import type { ClipResultMessage } from "./messages.ts";

/**
 * Runs inside the page (isolated world) via chrome.scripting.executeScript.
 * Extracts the article, converts it to Markdown, and messages the result
 * back to the popup — the return value of file-based injection is not a
 * reliable channel, messaging is.
 *
 * Deliberately thin. Everything a clip actually does lives in `clipPage`,
 * where the sweep script and the tests reach it too; what is left here is the
 * part that only works inside a page.
 */
(() => {
  // Readability destructively mutates its input; always parse a clone. The
  // title falls back to the live document's, since the clone is consumed.
  const clone = document.cloneNode(true) as Document;
  const payload = clipPage(clone, location.href);
  const message: ClipResultMessage = {
    type: "tiro-clip-result",
    payload: { ...payload, title: payload.title || document.title },
  };
  chrome.runtime.sendMessage(message).catch(() => {
    // Expected when the popup closed before the result arrived — the
    // receiving end no longer exists and the clip is simply abandoned.
  });
})();
