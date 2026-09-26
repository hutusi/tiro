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
}
