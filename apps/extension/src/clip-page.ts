import { Readability } from "@mozilla/readability";
import { foldFiguresIn, prepareForClipping } from "./dom-prepare.ts";
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
  // Recover math and code languages first — Readability prunes low-text
  // subtrees, and a formula it drops cannot be recovered afterwards.
  prepareForClipping(doc);
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
  // (ADR 0011, foldFiguresIn).
  const html = foldFiguresIn(extracted, doc);

  // hasMath comes from the HTML actually being converted, so a formula
  // Readability discarded with the page furniture cannot set the flag.
  const { markdown, hasMath } = htmlToMarkdown(html);

  return {
    url,
    title: (article?.title ?? "").trim() || doc.title,
    excerpt: (article?.excerpt ?? "").trim(),
    author: (article?.byline ?? "").trim(),
    markdown,
    readabilityFailed,
    hasMath,
  };
}
