import { type ArxivRef, arxivAbsUrl, arxivHtmlUrl } from "@tiro/shared";
import { clipPage } from "./clip-page.ts";
import { hasLatexmlFullText, truncateExcerpt } from "./dom-prepare.ts";
import type { FetchLike } from "./github.ts";
import type { ClipPayload } from "./messages.ts";

/**
 * Clipping an arXiv paper from whichever of its URLs the reader is on.
 *
 * The identity rule in `@tiro/shared` makes `/abs/`, `/pdf/` and `/html/` one
 * article, which on its own would be a trap: `/pdf/` has no readable text at
 * all and `/abs/` is a one-paragraph abstract, so clipping either would
 * *overwrite* a full-text clip with less. Collapsing the identity and always
 * reading the full text are the same change, not two.
 *
 * The fetch happens here rather than in the injected clipper because the tab
 * may be Chrome's PDF viewer, where injection is not something to depend on.
 * That costs a host permission, which is why it is optional and requested from
 * the Clip flow's own user gesture rather than held at install time.
 */

/** The origin pattern the popup asks for, matching `optional_host_permissions`
 * in the manifest. Exported so the two cannot drift. */
export const ARXIV_ORIGIN = "https://arxiv.org/*";

/**
 * Would clipping this payload file a lesser body under a paper's slug?
 *
 * The identity rule makes `/abs/`, `/pdf/` and `/html/` one article, so an
 * abstract page committed now *replaces* a full-text clip of the same paper —
 * and, because the body changed, costs a full re-translation to undo. The Clip
 * button therefore has to stay disabled while a better body is one click away.
 *
 * Keyed on what the document holds rather than on which URL it came from. A
 * reader already looking at `/html/` has the full text in the tab and must not
 * be made to grant a permission to clip the page in front of them; an `/html/`
 * URL that LaTeXML could only stub holds nothing, and a route check would wave
 * it straight through.
 *
 * Pure so it can be tested: the popup that acts on it has no test harness.
 */
export function needsFullTextFetch(
  payload: Pick<ClipPayload, "latexmlFullText">,
  isArxivPaper: boolean,
): boolean {
  return isArxivPaper && !payload.latexmlFullText;
}

/**
 * A body in hand, and where it came from.
 *
 * The popup can hold two: what the injected clipper read from the tab, and what
 * the fetch returned. They are not interchangeable, and neither always wins.
 */
export interface ClipCandidate {
  latexmlFullText: boolean;
  /** True for the body fetched from arxiv.org, false for the tab's own. */
  fromFetch: boolean;
}

/**
 * Should `candidate` replace the body already in hand?
 *
 * The rule the whole feature rests on is "prefer the body that is actually the
 * paper", and until this existed the code said "prefer whatever the fetch
 * returned" — only accidentally the same thing. They come apart when arxiv.org
 * has no usable HTML for a paper but the tab does: ar5iv is a separate
 * deployment of the same converter, so it can render what arxiv.org stubs, and
 * the abstract page would otherwise displace a full text the reader was looking
 * at. (Probing eight papers from 1997 to 2017 found no such divergence today.
 * The rule is written for what it means, not for what reproduces.)
 *
 * On a tie the fetched body wins: it is the canonical one, and it is the only
 * one that knows which version it came from.
 */
export function prefersCandidate(
  current: ClipCandidate | null,
  candidate: ClipCandidate,
): boolean {
  if (current === null) return true;
  if (candidate.latexmlFullText !== current.latexmlFullText) {
    return candidate.latexmlFullText;
  }
  return candidate.fromFetch;
}

/**
 * Is the body in hand the best there is going to be?
 *
 * Clipping a paper commits it under a slug shared by every one of its URL
 * forms, so committing early does not add an article — it *replaces* one, and
 * costs a re-translation to undo. The button therefore waits until either the
 * body already is the paper, or both sources have had their turn.
 *
 * "Had their turn" has to include failing. A tab that cannot be read must still
 * resolve, or a paper whose page will not load would gate the button forever —
 * which is exactly the PDF tab, where script injection is least dependable.
 */
export function clipReady(
  best: ClipCandidate | null,
  isArxivPaper: boolean,
  fetchResolved: boolean,
  tabResolved: boolean,
): boolean {
  if (best === null) return false;
  if (!needsFullTextFetch(best, isArxivPaper)) return true;
  return fetchResolved && tabResolved;
}

export interface ArxivClip {
  payload: ClipPayload;
  /**
   * The URL the body was read from, when that is not the article's own URL —
   * `tiro.source_url`. Absent when the abstract page *is* what was read, since
   * that is already the canonical URL.
   */
  sourceUrl?: string;
}

export interface ArxivFetchDeps {
  fetch: FetchLike;
  /** `new DOMParser().parseFromString(html, "text/html")` in the popup; a
   * happy-dom window in tests. Injected because a service worker has no
   * DOMParser and the sweep has no browser at all. */
  parse: (html: string) => Document;
}

/**
 * Fetch and clip a paper's full text, falling back to its abstract page.
 *
 * Throws only if *both* fetches fail; the caller then has the tab's own clip to
 * fall back on.
 */
export async function clipArxivPaper(
  paper: ArxivRef,
  deps: ArxivFetchDeps,
): Promise<ArxivClip> {
  const htmlUrl = arxivHtmlUrl(paper);
  const absUrl = arxivAbsUrl(paper);

  const full = await tryFetchDocument(htmlUrl, deps);
  // Not every paper has a real HTML rendering. arXiv answers HTTP 200 with a
  // valid `.ltx_document` for a `\includepdf` submission whose whole body is
  // "See pages 1-last of 0_adam_main.pdf" (arxiv.org/html/1412.6980), so the
  // check has to be on content. The abstract page is a fair article in its own
  // right, and its metadata is cleaner than anything scraped.
  if (full !== null && hasLatexmlFullText(full)) {
    prepareFetchedDocument(full, htmlUrl);
    return {
      payload: clipPage(full, absUrl),
      sourceUrl: arxivHtmlUrl({ id: paper.id, ...readVersion(full, paper) }),
    };
  }

  const abstract = await tryFetchDocument(absUrl, deps);
  if (abstract === null) {
    throw new Error(`arXiv did not serve ${paper.id}`);
  }
  prepareFetchedDocument(abstract, absUrl);
  const payload = clipPage(abstract, absUrl);
  return { payload: { ...payload, ...readCitationMetadata(abstract) } };
}

async function tryFetchDocument(
  url: string,
  deps: ArxivFetchDeps,
): Promise<Document | null> {
  let response: Response;
  try {
    response = await deps.fetch(url);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return deps.parse(await response.text());
}

/**
 * Give a fetched document the base its markup was written against.
 *
 * This is the difference between a paper with figures and a paper without any.
 * arXiv writes `src="2404.19756v1/figs/sr.png"`, and a live clip only survives
 * that because Readability absolutizes against `doc.baseURI` — which, for a
 * document built by DOMParser, is the *popup's* URL. The processor downloads
 * `https?://` URLs and silently ignores everything else, so getting this wrong
 * loses every image without erroring anywhere.
 *
 * Both halves are needed. The `<base>` element is what Readability reads, and
 * covers attributes this does not enumerate; rewriting the attributes covers
 * the raw-body path taken when Readability fails, which does no absolutizing at
 * all.
 */
export function prepareFetchedDocument(doc: Document, url: string): void {
  const head = doc.head;
  if (head !== null) {
    const base = doc.createElement("base");
    base.setAttribute("href", url);
    head.insertBefore(base, head.firstChild);
  }
  for (const element of Array.from(doc.querySelectorAll("img, source, a"))) {
    absolutizeAttribute(element, "src", url);
    absolutizeAttribute(element, "href", url);
    absolutizeSrcset(element, url);
  }
}

function absolutizeAttribute(
  element: Element,
  name: string,
  base: string,
): void {
  const value = element.getAttribute(name);
  if (value === null || value === "") return;
  const absolute = resolve(value, base);
  if (absolute !== null) element.setAttribute(name, absolute);
}

/** `srcset` is a comma-separated list of `url descriptor` pairs, so each URL
 * has to be resolved on its own. */
function absolutizeSrcset(element: Element, base: string): void {
  const value = element.getAttribute("srcset");
  if (value === null || value === "") return;
  const rewritten = value
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const [url, ...descriptor] = parts;
      if (url === undefined || url === "") return candidate.trim();
      const absolute = resolve(url, base);
      return [absolute ?? url, ...descriptor].join(" ");
    })
    .join(", ");
  element.setAttribute("srcset", rewritten);
}

function resolve(value: string, base: string): string | null {
  // Leave anything that is not a location alone: `#anchor` is meaningful
  // relative to the article, and `data:`/`javascript:` must not be rewritten
  // into a page URL.
  if (value.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

/**
 * Which version arXiv actually served, read from the `arXiv:<id>vN` line
 * LaTeXML puts in the page header.
 *
 * Matched against this paper's own identifier so a citation of some other
 * paper's v2 cannot answer, and taken from the first match because the header
 * precedes the bibliography.
 */
function readVersion(doc: Document, paper: ArxivRef): { version?: number } {
  const escaped = paper.id.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  const match = new RegExp(`arXiv:${escaped}v(\\d+)`).exec(
    doc.body?.textContent ?? "",
  );
  const version = match?.[1] === undefined ? paper.version : Number(match[1]);
  return version === undefined ? {} : { version };
}

/**
 * Title, authors and abstract from the abstract page's `citation_*` tags.
 *
 * The abstract page is the one arXiv surface that does carry metadata, and it
 * is authoritative — worth preferring over anything Readability infers from the
 * rendered page. Authors are joined with `; ` rather than `, ` because arXiv
 * writes them surname-first (`Liu, Ziming`), and a comma would make the list
 * unreadable.
 */
function readCitationMetadata(doc: Document): Partial<ClipPayload> {
  const metadata: Partial<ClipPayload> = {};
  const title = metaContent(doc, "citation_title");
  if (title !== "") metadata.title = title;
  const authors = Array.from(
    doc.querySelectorAll('meta[name="citation_author"]'),
  )
    .map((node) => (node.getAttribute("content") ?? "").trim())
    .filter((name) => name !== "");
  if (authors.length > 0) metadata.author = authors.join("; ");
  const abstract = metaContent(doc, "citation_abstract");
  if (abstract !== "") metadata.excerpt = truncateExcerpt(abstract);
  return metadata;
}

function metaContent(doc: Document, name: string): string {
  const node = doc.querySelector(`meta[name="${name}"]`);
  return (node?.getAttribute("content") ?? "").replace(/\s+/g, " ").trim();
}
