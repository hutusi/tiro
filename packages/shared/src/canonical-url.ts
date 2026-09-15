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
 *
 * GitHub is the second rule, and it earns the exception the same way: one file
 * is served at `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` and
 * presented at `github.com/<owner>/<repo>/blob/<ref>/<path>`, and `<ref>` may
 * be spelled either `main` or `refs/heads/main`. That is the publisher's own
 * addressing, not an inference from resemblance.
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

/** Hosts that present a repository's files as pages. */
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** The host that serves a repository's file *bytes*. Kept apart from the
 * hosts above because its paths have no route segment at all — the ref follows
 * the repository directly. */
const GITHUB_RAW_HOSTS = new Set(["raw.githubusercontent.com"]);

/** Third path segment of a github.com route that addresses one file's
 * contents. Every other route — `tree` for a directory, and issues, pulls,
 * releases, commits — is left alone. */
const GITHUB_FILE_ROUTES = new Set(["blob", "raw"]);

/** Ways a ref may be spelled in front of itself. Stripping these is what makes
 * `refs/heads/main` and `main` one article rather than two. */
const GITHUB_REF_PREFIXES: readonly (readonly string[])[] = [
  ["refs", "heads"],
  ["refs", "tags"],
];

/** Extensions this rule claims. `.mdx` is deliberately absent: it is JSX, and
 * clipping it as markdown would store something that never rendered. */
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"];

/** GitHub's grammar for an owner or repository name. */
const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;

export interface GitHubDocRef {
  owner: string;
  repo: string;
  /**
   * `<ref>/<path…>`, carried whole and never split.
   *
   * A branch name may contain slashes, so nothing offline can say where the
   * ref ends and the path begins: `o/r/feature/x/README.md` is both `feature`
   * + `x/README.md` and `feature/x` + `README.md`, and only the repository
   * knows which. The rule never has to know. Every URL form of one file puts
   * the *same* tail behind a different prefix, so rewriting the prefix alone
   * collapses them all — without a guess that could merge two files.
   */
  tail: string[];
}

/**
 * Read a GitHub markdown file reference out of any of its URL forms, or `null`
 * if the URL is not one.
 *
 * The markdown gate is not squeamishness about other files — it is ADR 0013's
 * fifth clause. Identity and content acquisition move together: claiming that
 * two URLs are one article is only safe where the clipper can actually read
 * the file behind them, and a `.py` blob page today yields GitHub's virtualized
 * code viewer, which holds only the lines currently scrolled into view.
 */
export function parseGitHubMarkdownUrl(rawUrl: string): GitHubDocRef | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const servesBytes = GITHUB_RAW_HOSTS.has(host);
  if (!servesBytes && !GITHUB_HOSTS.has(host)) return null;

  const segments = url.pathname.split("/").filter((part) => part !== "");
  const [owner, repo, ...rest] = segments;
  if (owner === undefined || repo === undefined) return null;
  if (!isGitHubName(owner) || !isGitHubName(repo)) return null;

  const routed = servesBytes ? rest : fileRouteTail(rest);
  if (routed === null) return null;
  // Applied to both hosts: `github.com/o/r/blob/refs/heads/main/F.md` resolves
  // too, and leaving it unstripped here would file it apart from the same
  // file's every other form.
  const tail = stripRefPrefix(routed);
  // A ref and at least one path segment. Anything shorter addresses the
  // repository, not a file in it.
  if (tail.length < 2) return null;
  if (!isMarkdownFile(tail[tail.length - 1] ?? "")) return null;
  return { owner, repo, tail };
}

function fileRouteTail(rest: string[]): string[] | null {
  const [route, ...tail] = rest;
  if (route === undefined || !GITHUB_FILE_ROUTES.has(route.toLowerCase())) {
    return null;
  }
  return tail;
}

function stripRefPrefix(segments: string[]): string[] {
  for (const prefix of GITHUB_REF_PREFIXES) {
    if (prefix.every((part, i) => segments[i]?.toLowerCase() === part)) {
      return segments.slice(prefix.length);
    }
  }
  return segments;
}

function isGitHubName(segment: string): boolean {
  // `GITHUB_NAME` admits a dot, so the dot segments have to go separately —
  // a URL cannot carry them literally, but it can carry them encoded.
  if (segment === "." || segment === "..") return false;
  return GITHUB_NAME.test(segment);
}

function isMarkdownFile(segment: string): boolean {
  const name = segment.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * True when a URL addresses a markdown file.
 *
 * Lives here, beside the rule that uses the same list, because the clipper
 * asks the same question of hosts this module has never heard of — a `.md`
 * served as plain text by GitLab, Codeberg or anyone else. Two copies of the
 * list would drift, and the drift would be invisible: a file clipped as
 * markdown from one host and as a code block from another.
 */
export function isMarkdownUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const segments = url.pathname.split("/");
  return isMarkdownFile(segments[segments.length - 1] ?? "");
}

/**
 * The file's identity: the page GitHub presents it on.
 *
 * The blob page rather than the raw bytes because that is what "read the
 * original" should open — rendered, with the repository around it. Rebuilt
 * from parts, so a `?plain=1` that `normalizeUrl`'s tracking blocklist has no
 * reason to know about does not fork the identity.
 */
export function githubBlobUrl(doc: GitHubDocRef): string {
  return `https://github.com/${doc.owner}/${doc.repo}/blob/${doc.tail.join("/")}`;
}

/** Where the file's bytes live — what the clipper reads, and the base that
 * makes a repo-relative image in it resolve to an image. */
export function githubRawUrl(doc: GitHubDocRef): string {
  return `https://raw.githubusercontent.com/${doc.owner}/${doc.repo}/${doc.tail.join("/")}`;
}

/**
 * Rewrite a URL to its publisher-canonical form, or return it unchanged.
 *
 * Two rules today, arXiv and GitHub. A third publisher goes here rather than
 * into `normalizeUrl`, so the generic normalizer stays host-agnostic and the
 * list of places identity can be decided stays at one. The rules cannot
 * collide: each is gated on its own hosts before it looks at anything else.
 */
export function canonicalizeUrl(rawUrl: string): string {
  const paper = parseArxivUrl(rawUrl);
  if (paper !== null) return arxivAbsUrl(paper);
  const doc = parseGitHubMarkdownUrl(rawUrl);
  if (doc !== null) return githubBlobUrl(doc);
  return rawUrl;
}
