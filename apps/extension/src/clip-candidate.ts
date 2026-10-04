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
 * What a publisher's rule promises about this tab.
 *
 * `degradesToTab` is the half that is not about waiting. Where the tab's own
 * body is a fair article under the shared slug, a fetch that cannot happen
 * costs a fuller body and nothing else — an arXiv abstract page is the paper's
 * canonical URL, and clipping it is a real article. Where it is not, no amount
 * of waiting makes it one: GitHub's blob page is a rendering of the file, filed
 * under the file's own slug, so committing it replaces the file's clip rather
 * than adding one.
 *
 * The flag and the identity rule are driven by the same parser, which is what
 * makes the gate airtight: `available` is false for a github.com URL exactly
 * when `canonicalizeUrl` declines to collapse it, and a clip that collapses
 * onto nothing overwrites nothing.
 */
export interface FetchPolicy {
  /** This URL has a better source to offer at all. */
  available: boolean;
  /** If the fetch does not deliver, is the tab's own body still worth
   * committing under this slug? */
  degradesToTab: boolean;
}

/** An ordinary page: no better source, so nothing to wait for and nothing to
 * refuse. */
export const NO_FETCH: FetchPolicy = { available: false, degradesToTab: true };

/**
 * Would clipping this body file a lesser one under the document's slug?
 *
 * Nothing is owed when the body in hand is already the document.
 */
export function needsFetch(
  candidate: ClipCandidate,
  policy: FetchPolicy,
): boolean {
  return policy.available && !candidate.isSource;
}

/**
 * Is the body in hand the best there is going to be?
 *
 * "Had their turn" has to include failing. A tab that cannot be read must still
 * resolve, or a document whose page will not load would gate the button
 * forever — which is exactly a PDF tab, where script injection is least
 * dependable. But that argument only reaches as far as bodies worth
 * committing: where the tab's is not one, settling is not an answer.
 */
export function clipReady(
  best: ClipCandidate | null,
  policy: FetchPolicy,
  fetchResolved: boolean,
  tabResolved: boolean,
): boolean {
  if (best === null) return false;
  if (!needsFetch(best, policy)) return true;
  if (!policy.degradesToTab) return false;
  return fetchResolved && tabResolved;
}

/**
 * Has this tab run out of ways to produce its document?
 *
 * The third state. "Not ready" alone cannot tell waiting from refused, and the
 * popup has to say which — one is a spinner, the other is a dead end with a
 * way around it.
 *
 * Deliberately blind to `tabResolved`: once the fetch has answered without the
 * document, nothing the tab can still say changes the answer, because a tab
 * body that *were* the document would set `isSource` and falsify the last line
 * on its own. `best` may be null — a fetch that failed before the tab reported
 * is already out of ways, and the answer must not flicker when the rendering
 * finally arrives.
 */
export function clipRefused(
  best: ClipCandidate | null,
  policy: FetchPolicy,
  fetchResolved: boolean,
): boolean {
  if (!policy.available || policy.degradesToTab) return false;
  if (!fetchResolved) return false;
  return best === null || !best.isSource;
}

/** Whether a payload is the document itself — the one question each publisher
 * answers with its own field, and the only place that mapping lives. */
export function isSourceBody(payload: ClipPayload): boolean {
  return payload.latexmlFullText || payload.markdownSource;
}

/**
 * Would committing this payload file an article with nothing in it?
 *
 * A PDF stub is empty on purpose — the processor builds its body (ADR 0026) —
 * so it is the one empty payload worth committing. Any other is a tab the
 * clipper could not read, whatever it believed it was reading: when Chrome's
 * PDF viewer stopped matching the shape `isPdfViewerDocument` looked for, four
 * PDFs were committed as empty articles over a week, each titled with its host,
 * and the processor dutifully summarized nothing. Refusing here is what turns
 * the next such miss into a message in the popup instead of a silent article.
 */
export function hasNothingToClip(payload: ClipPayload): boolean {
  return !payload.pdfViewer && payload.markdown.trim() === "";
}

/**
 * Should the popup refuse `best` — the body arbitration chose — as empty?
 *
 * Asked of the winner, not of each body as it arrives, because emptiness is
 * not a property of one source. A fetched body can be empty too: a markdown
 * file on GitHub holding only whitespace comes back as the document itself,
 * which `clipReady` opens the button for without looking inside, and
 * committing it would replace that file's clip with nothing.
 *
 * Not while a fetch can still replace an empty tab body. Then the publisher's
 * offer is the thing to show — the button is already shut by `clipReady` —
 * and the refusal comes only once the fetch has had its turn and left nothing
 * better.
 */
export function refusesAsEmpty(
  best: ClipPayload | null,
  policy: FetchPolicy,
  fetchResolved: boolean,
): boolean {
  if (best === null || !hasNothingToClip(best)) return false;
  return !policy.available || fetchResolved;
}
