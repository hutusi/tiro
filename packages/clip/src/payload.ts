/** Everything one clip produces. Named separately from the message so the
 * sweep script can hold a clip without inventing a message around it. */
export interface ClipPayload {
  url: string;
  title: string;
  excerpt: string;
  author: string;
  markdown: string;
  readabilityFailed: boolean;
  hasMath: boolean;
  /** The tab is Chrome's PDF viewer, not an article. There is no text to
   * clip and no way to get any, so the popup refuses rather than committing
   * an empty article. */
  pdfViewer: boolean;
  /** The document carries a real LaTeXML paper, not a page about one. False
   * for an abstract page, a PDF, and for the stub arXiv serves when it could
   * not convert a submission. */
  latexmlFullText: boolean;
  /** The body is a markdown file carried verbatim, rather than markdown
   * converted from a rendering of one. False for a `github.com` blob page,
   * which is a rendering — which is what tells the popup a better body is
   * still one fetch away. */
  markdownSource: boolean;
  /**
   * The figures the page draws with script, and the charts it draws as
   * `<svg>`, that reached the article, each by its index among the page's
   * figures and orphan charts (`figureHosts`; ADR 0039, ADR 0044) — what the
   * popup can offer to capture. Absent where no page was clipped: a PDF, a markdown
   * file, a Hacker News thread.
   */
  scriptFigures?: number[];
  /** The snapshots the article shows, by id: exactly the files a commit has
   * to carry beside it. */
  snapshots?: string[];
  /**
   * The article's lead that Readability left out and the clip recovered — its
   * dek and lead picture as markdown, already at the start of `markdown`
   * (ADR 0052). What a repair adds to an article saved before the lead was
   * recovered, without touching the rest of it (ADR 0053). Empty or absent
   * when there was none to recover.
   */
  lead?: string;
  /**
   * The page's description of itself, from its `<meta>`: `og:description`,
   * then `description`, then `twitter:description`, whitespace collapsed.
   * What a saved site shows beside its introduction (ADR 0055) — unlike
   * `excerpt`, which is Readability's guess at the article's opening and is
   * empty for exactly the pages a site is for. Absent where no page was
   * clipped, and empty when the page says nothing.
   */
  description?: string;
}
