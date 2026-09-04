/**
 * Publisher-canonical URL rewriting — the one place identity is allowed to be
 * site-specific.
 *
 * `normalizeUrl` is deliberately host-agnostic and deliberately a *blocklist*
 * (see `slug.ts`): it never guesses which part of a URL identifies content,
 * because guessing wrong merges two pages into one and loses an article. This
 * module is the narrow exception, and it earns it by not guessing. arXiv
 * publishes one paper at `/abs/<id>`, `/pdf/<id>` and `/html/<id>`, each
 * optionally versioned, across several hosts — and says so itself: the abs page
 * serves `<link rel="canonical" href="https://arxiv.org/abs/2404.19756">`,
 * versionless. Following that is adopting the publisher's identity, not
 * inventing one.
 *
 * The safety comes from the grammar. A rewrite happens only when the host is a
 * known arXiv host AND the first path segment is a known paper route AND the
 * rest matches an arXiv identifier exactly. `/list/cs.AI/recent` and
 * `/a/liu_z_1` are arXiv URLs that are not papers, and they pass through
 * untouched.
 */

/** Hosts that serve the same arXiv corpus. `ar5iv` is the LaTeXML renderer
 * arXiv's own `/html/` route grew out of, and it addresses papers by the same
 * identifier. */
const ARXIV_HOSTS = new Set([
  "arxiv.org",
  "www.arxiv.org",
  "export.arxiv.org",
  "browse.arxiv.org",
  "ar5iv.org",
  "www.ar5iv.org",
  "ar5iv.labs.arxiv.org",
]);

/** First path segment of a route that addresses a paper. Every other arXiv
 * route — listings, author pages, search — is left alone. */
const ARXIV_PAPER_ROUTES = new Set([
  "abs",
  "pdf",
  "html",
  "format",
  "ps",
  "src",
  "e-print",
]);

/** Post-2007 identifier: `2404.19756`, five digits since 2015. */
const NEW_STYLE_ID = /^(\d{4}\.\d{4,5})(?:v(\d+))?$/;

/**
 * Pre-2007 identifier: `<archive>[.<subject class>]/<YYMMNNN>`, e.g.
 * `hep-th/9901001`, `math.GT/0309136`, `cond-mat.stat-mech/0309136`. Both the
 * archive and the subject class can contain a dash, which is why neither is
 * `[a-z]+`.
 */
const OLD_STYLE_ID = /^([a-z][a-z-]*)(?:\.[a-z][a-z-]*)?\/(\d{7})(?:v(\d+))?$/i;

export interface ArxivRef {
  /** Canonical identifier: version stripped, and for a pre-2007 id the subject
   * class dropped — which is what arxiv.org itself redirects to
   * (`/abs/math.GT/0309136` → `/abs/math/0309136`). */
  id: string;
  /** The version the URL named, if it named one. Not part of the identity —
   * kept so a fetch can ask for the exact version the reader was looking at. */
  version?: number;
}

/**
 * Read an arXiv paper reference out of any of its URL forms, or `null` if the
 * URL is not one.
 */
export function parseArxivUrl(rawUrl: string): ArxivRef | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!ARXIV_HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split("/").filter((part) => part !== "");
  if (segments.length < 2) return null;
  const [route, ...rest] = segments;
  if (route === undefined || !ARXIV_PAPER_ROUTES.has(route.toLowerCase())) {
    return null;
  }

  // A pre-2007 identifier spans two path segments (`hep-th/9901001`), so the
  // whole tail is rejoined before matching rather than read segment by segment.
  // `/pdf/2404.19756v1.pdf` is the same paper as `/pdf/2404.19756v1`.
  const tail = rest.join("/").replace(/\.pdf$/i, "");

  const newStyle = NEW_STYLE_ID.exec(tail);
  if (newStyle?.[1] !== undefined) {
    return ref(newStyle[1], newStyle[2]);
  }
  const oldStyle = OLD_STYLE_ID.exec(tail);
  if (oldStyle?.[1] !== undefined && oldStyle[2] !== undefined) {
    return ref(`${oldStyle[1].toLowerCase()}/${oldStyle[2]}`, oldStyle[3]);
  }
  return null;
}

function ref(id: string, version: string | undefined): ArxivRef {
  return version === undefined ? { id } : { id, version: Number(version) };
}

/** The paper's identity: arXiv's own canonical link, versionless. */
export function arxivAbsUrl(paper: ArxivRef): string {
  return `https://arxiv.org/abs/${paper.id}`;
}

/**
 * Where the paper's full text lives. Keeps the version when the reader named
 * one, so clipping `/abs/…v1` stores the v1 body rather than whatever is
 * current; versionless resolves to the latest, which is what a bare `/abs/`
 * URL asked for.
 */
export function arxivHtmlUrl(paper: ArxivRef): string {
  const version = paper.version === undefined ? "" : `v${paper.version}`;
  return `https://arxiv.org/html/${paper.id}${version}`;
}

/**
 * Rewrite a URL to its publisher-canonical form, or return it unchanged.
 *
 * arXiv is the only rule today. A second publisher goes here rather than into
 * `normalizeUrl`, so the generic normalizer stays host-agnostic and the list of
 * places identity can be decided stays at one.
 */
export function canonicalizeUrl(rawUrl: string): string {
  const paper = parseArxivUrl(rawUrl);
  return paper === null ? rawUrl : arxivAbsUrl(paper);
}
