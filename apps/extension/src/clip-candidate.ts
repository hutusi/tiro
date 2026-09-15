import type { ClipPayload } from "./messages.ts";

/**
 * Choosing between two bodies for one article.
 *
 * Both publisher rules create the same trap. Collapsing several URLs onto one
 * identity means a clip does not *add* an article, it **replaces** one — so a
 * lesser body committed while a better one is a click away overwrites the
 * better, and costs a full re-translation to undo. An arXiv abstract page
 * displaces a paper's full text; a `github.com` blob page, whose markdown is
 * GitHub's rendering run back through Turndown, displaces the file itself.
 *
 * Written once rather than per publisher because the rule is not about either
 * of them: prefer the body that *is* the document, and until that is settled,
 * do not let the button commit.
 */

/**
 * A body in hand, and where it came from.
 *
 * The popup can hold two: what the injected clipper read from the tab, and what
 * the fetch returned. They are not interchangeable, and neither always wins.
 */
export interface ClipCandidate {
  /**
   * The body is the document itself, not a page about it or a rendering of it.
   *
   * Keyed on what the body holds rather than on which URL it came from. A
   * reader already on `raw.githubusercontent.com` or on arXiv's `/html/` has
   * the document in the tab and must not be made to grant a permission to clip
   * what is in front of them; and an `/html/` URL that LaTeXML could only stub
   * holds nothing, which a route check would wave straight through.
   */
  isSource: boolean;
  /** True for the body the fetch returned, false for the tab's own. */
  fromFetch: boolean;
}

/**
 * Should `candidate` replace the body already in hand?
 *
 * The rule is "prefer the body that is actually the document", and an earlier
 * version said "prefer whatever the fetch returned" — only accidentally the
 * same thing. They come apart when the fetch cannot produce the document but
 * the tab holds it: ar5iv is a separate deployment of arXiv's converter, so it
 * renders papers arxiv.org stubs.
 *
 * On a tie the fetched body wins: it is the canonical one, and it is the only
 * one that knows which version or ref it came from.
 */
export function prefersCandidate(
  current: ClipCandidate | null,
  candidate: ClipCandidate,
): boolean {
  if (current === null) return true;
  if (candidate.isSource !== current.isSource) return candidate.isSource;
  return candidate.fromFetch;
}

/**
 * Would clipping this body file a lesser one under the document's slug?
 *
 * `fetchAvailable` says this URL has a better source to offer at all — it is a
 * paper, or a markdown file on GitHub. Nothing is owed when the body in hand is
 * already the document.
 */
export function needsFetch(
  candidate: ClipCandidate,
  fetchAvailable: boolean,
): boolean {
  return fetchAvailable && !candidate.isSource;
}

/**
 * Is the body in hand the best there is going to be?
 *
 * "Had their turn" has to include failing. A tab that cannot be read must still
 * resolve, or a document whose page will not load would gate the button
 * forever — which is exactly a PDF tab, where script injection is least
 * dependable.
 */
export function clipReady(
  best: ClipCandidate | null,
  fetchAvailable: boolean,
  fetchResolved: boolean,
  tabResolved: boolean,
): boolean {
  if (best === null) return false;
  if (!needsFetch(best, fetchAvailable)) return true;
  return fetchResolved && tabResolved;
}

/** Whether a payload is the document itself — the one question each publisher
 * answers with its own field, and the only place that mapping lives. */
export function isSourceBody(payload: ClipPayload): boolean {
  return payload.latexmlFullText || payload.markdownSource;
}
