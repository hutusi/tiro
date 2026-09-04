import { Readability } from "@mozilla/readability";
import {
  foldFiguresIn,
  prepareForClipping,
  readLatexmlMetadata,
  restoreCodeLanguagesIn,
} from "./dom-prepare.ts";
import { htmlToMarkdown } from "./markdown.ts";
import type { ClipPayload } from "./messages.ts";

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
 * Mutates `doc`. Readability consumes what it parses, so callers with a live
 * page must pass a clone.
 */
export function clipPage(doc: Document, url: string): ClipPayload {
  // Asked before anything rewrites the DOM: the answer is about the document
  // that arrived, and `unwrapMediaWrappers` is entitled to remove the embed
  // this looks for.
  const pdfViewer = isPdfViewerDocument(doc);
  // Recover math and code languages first — Readability prunes low-text
  // subtrees, and a formula it drops cannot be recovered afterwards.
  prepareForClipping(doc);
  // Before Readability, which consumes the document — and after preparation, so
  // a formula in a title or abstract is already a marker rather than MathML.
  const latexml = readLatexmlMetadata(doc);
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
  const html = foldFiguresIn(restoreCodeLanguagesIn(extracted, doc), doc);

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
    excerpt: latexml?.excerpt ?? (article?.excerpt ?? "").trim(),
    author: latexml?.author ?? (article?.byline ?? "").trim(),
    markdown,
    readabilityFailed,
    hasMath,
    pdfViewer,
  };
}

/**
 * True when the document is Chrome's PDF viewer rather than a page.
 *
 * Chrome serves `https://…/paper.pdf` as an HTML shell whose body is a single
 * `<embed type="application/pdf">`; the bytes are rendered by a plugin the DOM
 * cannot see. Nothing here can extract that text, and until this existed the
 * popup happily committed the resulting empty article with
 * `readability_failed: true` — the scheme guard only ever checked for http(s).
 *
 * The text-length test is what keeps an ordinary article that happens to embed
 * a PDF from being refused: the viewer shell has no prose at all.
 */
export function isPdfViewerDocument(doc: Document): boolean {
  const embed = doc.querySelector(
    'embed[type="application/pdf"], object[type="application/pdf"]',
  );
  if (embed === null) return false;
  const text = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length < 200;
}
