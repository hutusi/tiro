import {
  type PdfLayout,
  type PdfTextItem,
  readPdfLayout,
} from "./pdf-layout.ts";

// One import for every consumer: the subpath is where anything touching pdf.js
// lives, and splitting it across three specifiers would only invite the barrel
// to grow a re-export that invariant 6 forbids.
export * from "./pdf-layout.ts";
export * from "./pdf-markdown.ts";

/**
 * Reading a PDF's text layer, and judging whether it has one.
 *
 * A **subpath export**, deliberately not part of the barrel. Invariant 6 keeps
 * `@tiro/shared`'s root browser-safe because the extension bundles it, and
 * pdf.js is 1.7 MB — reachable from the root it would land in the clipper,
 * which is a single-file classic script with no code splitting (ADR 0005).
 * Behind `@tiro/shared/pdf` it is imported only where it is wanted, and the
 * extension can reach it through a lazy `import()` that costs its options page
 * nothing until someone picks a file.
 *
 * Shared rather than duplicated because two consumers now need the same
 * judgement: the processor, which downloads a PDF the vault names, and the
 * extension, which reads one off the user's disk. A density gate implemented
 * twice is a density gate that drifts, and the copy not being reviewed is the
 * one that lets a scan through — the same argument that put the SSRF guards in
 * `net-fetch.ts`.
 *
 * What stays with the processor is acquisition: fetching bytes over the
 * network, and the guards that make that safe.
 */

/**
 * How a document's pages survive the trip through the vault.
 *
 * An import extracts on one machine and restructures on another, so the page
 * boundaries have to travel with the text — `stripRunningFurniture` and the
 * batching are both page-aware, and a body flattened to one string has thrown
 * that away. A form feed is the character that already means this, it does not
 * occur in prose, and markdown treats it as whitespace, so a body that is
 * never converted still reads correctly.
 */
export const PDF_PAGE_SEPARATOR = "\f";

/** Pages back out of a body that was stored with separators. Text with none is
 * one page, which is the right answer for a document of one. */
export function splitPdfPages(body: string): string[] {
  return body.split(PDF_PAGE_SEPARATOR);
}

/** Pages into a body, ready to be committed. */
export function joinPdfPages(pages: readonly string[]): string {
  return pages.join(PDF_PAGE_SEPARATOR);
}

export interface PdfTextOptions {
  maxPages: number;
  /** The scanned-PDF gate. Averaged across the document rather than demanded of
   * every page, so a paper carrying full-page figures still passes. */
  minCharsPerPage: number;
  /** Fraction of pages that must carry text at all — the other half of that
   * gate. See `extractPdfText`. */
  minPageCoverage: number;
}

/**
 * Characters below which a page carries nothing.
 *
 * Not a fraction of `minCharsPerPage`: that knob is about how dense a document
 * is on average, and this one is the difference between a page with words on it
 * and a page with a stray running number. A scanned page extracts to nothing at
 * all, so the bar only has to clear debris.
 */
const PAGE_TEXT_FLOOR = 20;

export interface PdfText {
  /** One entry per page, in reading order. */
  pages: string[];
  /** The same document read structurally — fonts, sizes, positions. Carried so
   * a caller can build Markdown from it without parsing the bytes again, which
   * is impossible anyway once pdf.js has detached them. */
  layout: PdfLayout;
  totalPages: number;
  /** Non-whitespace characters found, the number the gate was applied to. */
  chars: number;
}

/**
 * Read a PDF's text layer, or refuse the document.
 *
 * **Consumes `bytes`.** pdf.js takes ownership of the underlying ArrayBuffer
 * and detaches it, so after this returns the caller's view has length 0. That
 * is fine for the one flow there is — fetch, read, drop, keep the Markdown —
 * and copying 25 MB to defend a caller that does not exist would cost every
 * article. Anything that needs the bytes afterwards must pass a copy.
 *
 * Refuses rather than returns something thin, because every caller downstream
 * would have to make the same judgement with less information. The two
 * refusals are different failures wearing the same shape:
 *
 * - **Too many pages.** Extraction is cheap per page but the structure pass
 *   that follows is not, and a 600-page book would spend a whole run's budget
 *   on one article. Refused rather than truncated: half a document filed as the
 *   whole one is the silent kind of wrong, and nothing downstream could tell.
 * - **Too little text.** A scanned page is an image and carries no text layer,
 *   so it extracts to roughly nothing. Letting it through would produce an
 *   empty body — exactly the empty article the clipper refuses on a PDF tab
 *   today. OCR is out of scope (ADR 0026), so the honest answer is no.
 *
 * That second one is asked twice, because either question alone is wrong.
 * Density averaged over the document tolerates the full-page figures a real
 * paper carries — but an average is a sum, so one dense page among nine scanned
 * ones clears a per-page bar comfortably, and the article would be filed as a
 * whole document while holding a tenth of it. Coverage alone would refuse the
 * figure-heavy paper the average exists to admit. Together they say what is
 * actually meant: enough text overall, spread across enough of the document.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  options: PdfTextOptions,
): Promise<PdfText> {
  const { minCharsPerPage, minPageCoverage } = options;

  // One parse, not two. pdf.js detaches the buffer it is handed, so reading
  // the layout and then extracting text would need a copy of every byte — and
  // the flat text is derivable from the layout anyway, which keeps the two
  // paths reading the same document rather than two parses of it.
  const layout = await readPdfLayout(bytes, options);
  const { totalPages } = layout;
  const pages = pdfPages(layout);

  // Whitespace collapsed before counting, so a page of hard-wrapped blanks
  // cannot pass a gate meant to measure content.
  const chars = pages.reduce(
    (total, page) => total + page.replace(/\s+/g, " ").trim().length,
    0,
  );
  const perPage = totalPages === 0 ? 0 : chars / totalPages;
  if (perPage < minCharsPerPage) {
    throw new Error(
      `no usable text layer: ${Math.round(perPage)} chars/page across ${totalPages} page(s), below ${minCharsPerPage} — a scanned PDF needs OCR, which Tiro does not do`,
    );
  }

  const withText = pages.filter(
    (page) => page.replace(/\s+/g, " ").trim().length >= PAGE_TEXT_FLOOR,
  ).length;
  const coverage = totalPages === 0 ? 0 : withText / totalPages;
  if (coverage < minPageCoverage) {
    throw new Error(
      `text layer covers only ${withText} of ${totalPages} page(s), below ${Math.round(minPageCoverage * 100)}% — the rest is probably scanned, and OCR is out of scope`,
    );
  }

  return { pages, totalPages, chars, layout };
}

/**
 * The flat, one-string-per-page reading of a layout.
 *
 * What `extractText` would have produced, rebuilt from the runs so that a
 * document is parsed once. Lines are broken where the page broke them, which
 * is what the furniture strip and the density gates both expect to see.
 */
export function pdfPages(layout: PdfLayout): string[] {
  const pages: string[] = Array.from({ length: layout.totalPages }, () => "");
  let previous: PdfTextItem | undefined;
  for (const item of layout.items) {
    const index = item.page - 1;
    if (previous !== undefined && previous.page === item.page) {
      const sameLine = Math.abs(previous.y - item.y) <= 2;
      pages[index] += sameLine ? "" : "\n";
    }
    pages[index] += item.text;
    previous = item;
  }
  return pages;
}

/** A page's running header or footer, normalised so that "Page 3 of 15" and
 * "Page 4 of 15" are recognised as the same furniture. Digit runs become `#`
 * for that reason; nothing else about the line is touched, so two genuinely
 * different lines never collide. */
function furnitureKey(line: string): string {
  return line.replace(/\s+/g, " ").trim().replace(/\d+/g, "#");
}

/** How much of the document a line must appear on before it is furniture
 * rather than content. Below this a repeated line is more likely a section
 * label that happens to recur. */
const FURNITURE_SHARE = 0.6;

/** Longer than this and it is a sentence that repeated, not a running head. */
const FURNITURE_MAX_CHARS = 100;

/**
 * Drop the running headers and footers a PDF repeats on every page.
 *
 * Done here, deterministically, rather than asked of the model. The model
 * would have to be told to delete things, and a model licensed to delete
 * deletes more than furniture — whereas "this exact line, modulo its page
 * number, appears at the top of eleven of fifteen pages" is a fact the text
 * already contains. It is also the artifact that most reliably survives
 * extraction: `Published as a conference paper at ICLR 2015` on all fifteen.
 *
 * Deliberately narrow. Only the first and last non-empty line of a page are
 * candidates, only on documents long enough for repetition to mean something,
 * and only when the line is short. A false positive costs one line of content,
 * so the rule errs toward leaving things alone.
 */
export function stripRunningFurniture(pages: string[]): string[] {
  // Two pages repeating a line is a coincidence; the share below cannot
  // distinguish furniture from content until there are a few pages.
  if (pages.length < 3) return pages;

  const split = pages.map((page) => page.split("\n"));
  const firstIndex = split.map((lines) =>
    lines.findIndex((line) => line.trim() !== ""),
  );
  const lastIndex = split.map((lines) => {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if ((lines[i] ?? "").trim() !== "") return i;
    }
    return -1;
  });

  const tally = (indexes: number[]): Map<string, number> => {
    const counts = new Map<string, number>();
    indexes.forEach((index, page) => {
      if (index < 0) return;
      const line = split[page]?.[index] ?? "";
      if (line.trim().length > FURNITURE_MAX_CHARS) return;
      const key = furnitureKey(line);
      if (key === "") return;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  };

  const threshold = pages.length * FURNITURE_SHARE;
  const headers = tally(firstIndex);
  const footers = tally(lastIndex);

  return split.map((lines, page) => {
    const drop = new Set<number>();
    const head = firstIndex[page] ?? -1;
    const foot = lastIndex[page] ?? -1;
    if (
      head >= 0 &&
      (headers.get(furnitureKey(lines[head] ?? "")) ?? 0) >= threshold
    ) {
      drop.add(head);
    }
    // A one-line page would otherwise have its only line counted as both a
    // header and a footer, and dropping it twice is still dropping the page.
    if (
      foot >= 0 &&
      foot !== head &&
      (footers.get(furnitureKey(lines[foot] ?? "")) ?? 0) >= threshold
    ) {
      drop.add(foot);
    }
    return lines.filter((_, i) => !drop.has(i)).join("\n");
  });
}
