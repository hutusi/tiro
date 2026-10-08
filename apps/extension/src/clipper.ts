import { clipPage } from "@tiro/clip";
import type { FigureScope } from "./figure-scout.ts";
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
  const scope = globalThis as unknown as FigureScope;
  // The page's figures, listed just before the clone so the two lists line
  // up one to one: `clipPage` counts the clone's, and a payload's
  // `scriptFigures` index this list. Kept for the scout, which frames the
  // live elements a capture was offered for (ADR 0039).
  const figures: Element[] = Array.from(document.querySelectorAll("figure"));
  // A capture's re-clip: the popup left the pictures to show, keyed by the
  // *previous* run's list. Matched by element rather than by index, so a figure
  // the page added, removed or re-rendered since cannot put one figure's
  // picture over another's caption — a re-rendered figure is simply not found,
  // and stays a link.
  const request = scope.__tiroSnapshotRequest;
  delete scope.__tiroSnapshotRequest;
  const snapshots = new Map<number, string>();
  for (const [index, id] of request?.figures ?? []) {
    const element = scope.__tiroFigures?.[index];
    const at = element === undefined ? -1 : figures.indexOf(element);
    if (at >= 0) snapshots.set(at, id);
  }
  scope.__tiroFigures = figures;
  // Readability destructively mutates its input; always parse a clone. The
  // title falls back to the live document's, since the clone is consumed.
  const clone = document.cloneNode(true) as Document;
  const payload = clipPage(clone, location.href, { snapshots });
  const message: ClipResultMessage = {
    type: "tiro-clip-result",
    payload: { ...payload, title: payload.title || document.title },
    clipperCommit: __CLIPPER_COMMIT__,
    ...(request !== undefined ? { requestId: request.requestId } : {}),
  };
  chrome.runtime.sendMessage(message).catch(() => {
    // Expected when the popup closed before the result arrived — the
    // receiving end no longer exists and the clip is simply abandoned.
  });
})();
