import { Readability } from "@mozilla/readability";
import { parseGitHubMarkdownUrl } from "@tiro/shared";
import {
  excerptWithoutVideos,
  foldFiguresIn,
  hasLatexmlFullText,
  placeAnchorsIn,
  prepareForClipping,
  readLatexmlMetadata,
  restoreCodeLanguagesIn,
  videosAsPostersIn,
} from "./dom-prepare.ts";
import { htmlToMarkdown } from "./markdown.ts";
import type { ClipPayload } from "./payload.ts";
import {
  normalizeSourceMarkdown,
  plainTextMarkdownSource,
} from "./plain-markdown.ts";

/**
 * Turn a page into the article Tiro stores. The whole clip, in one place.
 *
 * Split out of `clipper.ts` so that nothing has to *re-implement* this order
 * to exercise it. The order is the load-bearing part — preparation before
 * Readability so a formula it prunes is already recovered (ADR 0003), folding
 * after it so the fold cannot change what Readability selected on (ADR 0011) —
 * and it was previously written out again in the sweep script and in three test
 * helpers. Every one of those was a copy that could drift from the clipper
 * while still passing, and a sweep that clips differently from the extension
 * reports on a pipeline nobody ships.
 *
 * Takes the document it should read rather than reaching for a global, and
 * returns the payload rather than sending it: the extension's messaging is the
 * one part of a clip that cannot run outside a page.
 *
 * Two document shapes leave before any of that order runs. Chrome's PDF viewer
 * has no body to read at all, and goes to `clipPdfViewer`. A markdown file
 * Chrome is showing as text is already the thing being converted *to*, and goes
 * to `clipMarkdownFile` below.
 *
 * Mutates `doc`. Readability consumes what it parses, so callers with a live
 * page must pass a clone.
 */
export function clipPage(doc: Document, url: string): ClipPayload {
  // Asked before anything rewrites the DOM: the answer is about the document
  // that arrived, and `unwrapMediaWrappers` is entitled to remove the embed
  // the older viewer's shell is recognised by.
  if (isPdfViewerDocument(doc)) return clipPdfViewer(doc, url);
  // Asked for the same reason, and answered first: this document is not a page
  // that happens to contain markdown, it *is* a markdown file, and every step
  // below would spend its effort converting something that needs no conversion.
  // `prepareForClipping` in particular would synthesize a `<code>` inside the
  // viewer's `<pre>` and hand Turndown one fence around the whole document.
  const source = plainTextMarkdownSource(doc, url);
  if (source !== null) return clipMarkdownFile(source, url);
  // Recover math and code languages first — Readability prunes low-text
  // subtrees, and a formula it drops cannot be recovered afterwards.
  prepareForClipping(doc);
  // Before Readability, which consumes the document — and after preparation, so
  // a formula in a title or abstract is already a marker rather than MathML.
  const latexml = readLatexmlMetadata(doc);
  // Whether this document *is* the paper, rather than a page about it. The
  // popup needs it to decide whether clipping the tab would file a lesser body
  // under a paper's canonical slug — see `needsFullTextFetch`.
  const latexmlFullText = hasLatexmlFullText(doc);
  // Snapshot before Readability, which consumes the document. Serializing
  // always costs less than a second cloneNode, and the fallback needs the
  // prepared DOM as much as the happy path does.
  const preparedBody = doc.body?.innerHTML ?? "";
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(doc).parse();
  } catch {
    article = null;
  }

  const readabilityFailed = article?.content == null || article.content === "";
  // Readability resolves relative URLs to absolute ones; the raw-body
  // fallback does not, which is one reason the failure is flagged.
  const extracted = readabilityFailed ? preparedBody : (article?.content ?? "");
  // Figures fold only now: doing it before Readability replaces the elements
  // carrying the attributes it selects on, which republished hidden images
  // (ADR 0011, foldFiguresIn). Fence languages are restored here for the
  // mirror-image reason: Readability strips the class Turndown reads them
  // from, so they cross it on a `data-*` marker and become a class again once
  // it is out of the way.
  // Anchors are placed between the two: a `<figure id>` resolves to its
  // caption, and folding then carries the anchor into the caption half of the
  // paragraph it builds, where the picture is still the first thing in it.
  // Videos become linked posters before any of it, so that a video's figure is
  // an image figure by the time the fold looks (videosAsPostersIn).
  const html = foldFiguresIn(
    placeAnchorsIn(
      restoreCodeLanguagesIn(videosAsPostersIn(extracted, doc, url), doc),
      doc,
    ),
    doc,
  );

  // hasMath comes from the HTML actually being converted, so a formula
  // Readability discarded with the page furniture cannot set the flag.
  const { markdown, hasMath } = htmlToMarkdown(html);

  // LaTeXML wins where it answered, because it read the paper's own markup
  // while Readability guessed from rendered text. These pages carry no <meta>
  // at all, so its byline heuristic scrapes the author block — affiliations,
  // `†thanks:` notes and all.
  return {
    url,
    title: latexml?.title ?? ((article?.title ?? "").trim() || doc.title),
    excerpt:
      latexml?.excerpt ??
      excerptWithoutVideos(
        article?.excerpt ?? "",
        article?.content ?? "",
        doc,
      ).trim(),
    author: latexml?.author ?? (article?.byline ?? "").trim(),
    markdown,
    readabilityFailed,
    hasMath,
    pdfViewer: false,
    latexmlFullText,
    markdownSource: false,
  };
}

/**
 * The clip of a tab showing Chrome's PDF viewer: an identity and a name.
 *
 * Nothing else is in reach — the text is drawn by a viewer the DOM cannot see —
 * so the popup commits a stub and the processor builds the body from the
 * document's text layer (ADR 0026). Readability is not asked: whatever it made
 * of the shell would be discarded, and the flags describing it would be claims
 * about text nothing here has seen.
 *
 * Named after the file rather than left to fall back to the host. The viewer's
 * document carries no title — `document.title` is empty on Chrome's current
 * viewer, whatever the PDF's own `/Title` says — and the host is what every PDF
 * from one site would then share. The processor replaces this with the
 * document's `/Title` once it has the bytes, treating the file name as the
 * placeholder it is.
 */
function clipPdfViewer(doc: Document, url: string): ClipPayload {
  return {
    url,
    title: doc.title.trim() || fileStem(url),
    excerpt: "",
    author: "",
    markdown: "",
    readabilityFailed: false,
    hasMath: false,
    pdfViewer: true,
    latexmlFullText: false,
    markdownSource: false,
  };
}

/**
 * The document types Chrome's PDF viewer renders — what `navigator.mimeTypes`
 * lists while the viewer is enabled. With it disabled a PDF downloads, and
 * there is no tab to clip at all.
 */
const PDF_VIEWER_TYPES = new Set(["application/pdf", "text/pdf"]);

/**
 * True when the document is Chrome's PDF viewer rather than a page.
 *
 * The bytes are rendered by a viewer the DOM cannot see, so nothing here can
 * extract that text — and a clip that does not know it is looking at one
 * commits an empty article with `readability_failed: true`.
 *
 * Asked of the content type first, because the shell's shape is Chrome's to
 * change and it has. The out-of-process viewer (Chrome 154, measured
 * 2026-10-03) leaves no `<embed>` in the DOM at all: the head links the
 * viewer's own `pdf_embedder.css` and the body holds whatever other extensions
 * injected. The shape test below never matched it, and every web PDF clipped on
 * that Chrome went into the vault empty. The type is the response's, carried by
 * the clone `clipper.ts` hands over (checked in Chrome), and a page that merely
 * embeds a PDF is `text/html` — so the attachment cases the shape test guards
 * stay pages without any help.
 *
 * The shape is still asked, for the viewer that came before: it rewrote the
 * response into an HTML shell whose body is a single
 * `<embed type="application/pdf">`, typed `text/html`, so there the shape is the
 * only signal. Described by shape as well as emptiness, because emptiness alone
 * is not the viewer: a poster or a figure gallery can carry a PDF attachment and
 * almost no prose, and refusing that would lose a clip the pipeline handles
 * fine.
 */
export function isPdfViewerDocument(doc: Document): boolean {
  if (PDF_VIEWER_TYPES.has(doc.contentType)) return true;
  const embed = doc.querySelector(
    'embed[type="application/pdf"], object[type="application/pdf"]',
  );
  if (embed === null) return false;
  // The shell puts the embed straight in the body; one nested inside an article
  // is a page carrying an attachment.
  if (embed.parentElement !== doc.body) return false;
  // And nothing beside it says anything. Written as "no sibling carries text"
  // rather than "the embed is the body's only child", because another
  // extension's injected element is a sibling this never sees coming — that
  // exact count is what silently stopped markdown clipping working. A heading
  // beside the embed still fails, which is the case the test below is for.
  const beside = Array.from(doc.body?.children ?? []).filter(
    (element) => element !== embed,
  );
  if (beside.some((element) => (element.textContent ?? "").trim() !== "")) {
    return false;
  }
  // Still asked, and not redundant: a bare text node beside the embed is not an
  // element and so appears in neither `children` nor the scan above.
  const text = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length < 200;
}

/**
 * Clip a markdown file from its bytes, skipping the HTML pipeline entirely.
 *
 * The other entry point, and the one thing `clipPage` delegates rather than
 * does: the same file reaches Tiro either as the `<pre>` of a tab on
 * `raw.githubusercontent.com` or as text fetched for a `github.com` blob page,
 * and those must produce the same article.
 *
 * `baseUrl` is where the bytes live and `url` is where the article is filed —
 * different for a blob, on purpose. A repo-relative image resolved against the
 * blob page would point at an HTML page; against the raw URL it points at the
 * image.
 *
 * `readabilityFailed` is false because Readability was never asked, and what
 * the flag warns a reader about — a raw body whose relative URLs were never
 * absolutized — is precisely what this path does absolutize. `hasMath` stays
 * unset: the flag promises that every literal `$` in prose was escaped, and
 * that promise is kept by a Turndown escape hook this path does not run, so
 * claiming it would turn "$5 to $10" into a formula. `$$…$$` still renders,
 * for every article, flag or no flag.
 */
export function clipMarkdownFile(
  text: string,
  url: string,
  baseUrl: string = url,
): ClipPayload {
  const source = normalizeSourceMarkdown(text, baseUrl);
  return {
    url,
    title: source.title ?? fallbackTitle(url),
    excerpt: source.excerpt,
    // A file names no byline. Readability's heuristic scrapes one out of
    // rendered prose, and there is no rendered prose here to be wrong about.
    author: "",
    markdown: source.markdown,
    readabilityFailed: false,
    hasMath: false,
    pdfViewer: false,
    latexmlFullText: false,
    markdownSource: true,
  };
}

/**
 * What to call a file that names no title of its own.
 *
 * Anything but the hostname, which is what the clipper fell back to and what
 * put `raw.githubusercontent.com` on an article in the vault. A repository's
 * README is the repository as far as a title goes; every other file is worth
 * naming.
 */
function fallbackTitle(url: string): string {
  const stem = fileStem(url);
  const doc = parseGitHubMarkdownUrl(url);
  if (doc === null) return stem;
  const repo = `${doc.owner}/${doc.repo}`;
  return /^readme$/i.test(stem) ? repo : `${repo}: ${stem}`;
}

/**
 * The last path segment of `url`, decoded, without its extension — what a clip
 * is named when the document names nothing. Exported because the processor has
 * to recognise exactly this name as a placeholder (`isPlaceholderTitle`).
 */
export function fileStem(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "";
  }
  const segments = pathname.split("/").filter((part) => part !== "");
  const name = segments[segments.length - 1] ?? "";
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // A malformed escape is not worth losing the title over.
  }
  return decoded.replace(/\.[^.]*$/, "");
}
