import { extractText, getDocumentProxy } from "unpdf";
import type { Deadline } from "./deadline.ts";
import type { ChatFn, FetchLike } from "./llm/client.ts";
import {
  type PdfStructureOptions,
  restorePdfStructure,
} from "./llm/pdf-structure.ts";
import {
  fetchChecked,
  type ResolveHost,
  readBodyCapped,
  resolveViaDns,
  USER_AGENT,
} from "./net-fetch.ts";

/**
 * Turning a clipped PDF stub into text the structure pass can work on.
 *
 * The extension cannot read a PDF — Chrome renders it in a plugin the DOM does
 * not see — so it records a stub and this stage fetches the document itself
 * (ADR 0026). Nothing binary is kept: the bytes are downloaded, read, and
 * dropped, and the vault stores only what comes out the far end.
 *
 * Every refusal here is deliberate and none of them fails the run. A stage that
 * throws leaves `tiro.processed_at` absent, which is precisely "still pending"
 * (invariant 3), so a PDF that cannot be read today can be read by a later
 * version without anything being re-clipped.
 */

/** What a PDF has to claim to be before 25 MB of it is pulled down.
 *
 * `application/octet-stream` is on the list because it is what a plain file
 * download is routinely served as, and refusing it would refuse real documents.
 * That laxity is affordable only because `PDF_MAGIC` below is checked against
 * the bytes themselves — the content type decides whether to spend the
 * download, the magic bytes decide whether it was a PDF. */
const PDF_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/x-pdf",
  "application/octet-stream",
  "binary/octet-stream",
]);

/** Every PDF begins with this, by specification. The authoritative test: a
 * content type is a claim by the server, this is a fact about the file. */
const PDF_MAGIC = "%PDF-";

export interface PdfFetchOptions {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  /** Bounds the whole stage, so a slow server cannot outrun the run's budget
   * (invariant 8). Re-read per redirect hop, like the image stage. */
  stageTimeoutMs: number;
  fetchImpl?: FetchLike;
  resolveHost?: ResolveHost;
  /** Test escape hatch: fixture servers listen on localhost. */
  allowPrivateHosts?: boolean;
}

/** Download a PDF under the same guards the image stage uses. */
export async function fetchPdf(options: PdfFetchOptions): Promise<Uint8Array> {
  const {
    url,
    maxBytes,
    timeoutMs,
    stageTimeoutMs,
    fetchImpl = fetch,
    resolveHost = resolveViaDns,
    allowPrivateHosts = false,
  } = options;

  const deadline = Date.now() + stageTimeoutMs;
  const res = await fetchChecked(
    url,
    {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(Math.min(timeoutMs, stageTimeoutMs)),
    },
    fetchImpl,
    allowPrivateHosts,
    resolveHost,
    () => Math.min(timeoutMs, Math.max(0, deadline - Date.now())),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentType = res.headers.get("content-type");
  const media = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!PDF_CONTENT_TYPES.has(media)) {
    throw new Error(`not a PDF: ${contentType ?? "no content type"}`);
  }
  // Checked before the body is read so an oversized document costs one request
  // rather than one download. A server that omits or lies about it is caught by
  // readBodyCapped, which stops mid-stream.
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error(`too large: ${declared} bytes`);

  const bytes = await readBodyCapped(res, maxBytes);
  const magic = new TextDecoder().decode(bytes.slice(0, PDF_MAGIC.length));
  if (magic !== PDF_MAGIC) {
    throw new Error(`not a PDF: begins ${JSON.stringify(magic)}`);
  }
  return bytes;
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
  const { maxPages, minCharsPerPage, minPageCoverage } = options;

  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    doc = await getDocumentProxy(bytes);
  } catch (error) {
    throw new Error(`cannot read the PDF: ${String(error)}`);
  }
  // Asked before any text is pulled: the page count is in the catalogue, so
  // refusing here costs nothing, while extracting first would spend the work
  // this gate exists to avoid.
  if (doc.numPages > maxPages) {
    throw new Error(`too many pages: ${doc.numPages} (cap ${maxPages})`);
  }

  const { totalPages, text } = await extractText(doc, { mergePages: false });
  const pages = (text as string[]).map((page) => page ?? "");

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

  return { pages, totalPages, chars };
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

export interface PdfConversionOptions
  extends Omit<PdfFetchOptions, "stageTimeoutMs">,
    PdfTextOptions {
  chat: ChatFn;
  model: string;
  batchChars?: number;
  /** Bounds this stage: `pdf.stage_timeout_ms`. */
  stageTimeoutMs: number;
  /** The run's budget. Separate from the stage's, because the two mean
   * different things when they expire — see `stageGuard`. */
  deadline: Deadline;
  /** Checkpoint for restored batches, so a long PDF makes progress across
   * runs instead of restarting at page one. */
  cache?: PdfStructureOptions["cache"];
  log?: (message: string) => void;
}

/**
 * Two clocks, two outcomes.
 *
 * The run's budget expiring is an orderly stop: the pipeline defers the article
 * and everything the run achieved still gets committed, so it must surface as a
 * `DeadlineExceededError` and nothing here may turn it into anything else. The
 * stage's own cap expiring is a fault about this document — a server trickling
 * bytes, a pathological page count — and leaves the article pending as a
 * failure rather than reporting the run as late.
 *
 * The run is checked first, which is what keeps the two apart once both have
 * expired: the budget is the one that has to be believed.
 */
function stageGuard(stageTimeoutMs: number, run: Deadline) {
  const endsAt = Date.now() + stageTimeoutMs;
  return {
    remainingMs: () =>
      Math.max(0, Math.min(endsAt - Date.now(), run.remainingMs())),
    check(needMs: number, what: string): void {
      run.check(needMs, what);
      if (endsAt - Date.now() < needMs) {
        throw new Error(`pdf stage timed out before ${what}`);
      }
    },
  };
}

export interface PdfConversion {
  markdown: string;
  totalPages: number;
  /** Batches kept as extracted text because the model's reply failed its
   * checks. Above zero the article is readable but unformatted in places. */
  fallbacks: number;
}

/**
 * Fetch a PDF and return the Markdown body for its article.
 *
 * The whole conversion in one call, because every step is useless without the
 * others and a caller choosing among them would only be choosing how to get it
 * wrong. Any refusal throws — a non-public host, a document that is not a PDF,
 * too many pages, no text layer — and throwing is the correct outcome: the
 * pipeline's per-article catch leaves `tiro.processed_at` absent, so the
 * article stays pending and a later run tries again (invariant 7).
 *
 * Note this is the one stage whose input is not in the vault. Re-processing
 * re-downloads, and a source that has since 404'd cannot be reprocessed at all
 * — the article keeps the Markdown it already has (ADR 0026).
 */
export async function convertPdf(
  options: PdfConversionOptions,
): Promise<PdfConversion> {
  const {
    chat,
    model,
    batchChars,
    stageTimeoutMs,
    deadline,
    cache,
    log = () => {},
    ...rest
  } = options;
  const guard = stageGuard(stageTimeoutMs, deadline);

  guard.check(0, "fetching the PDF");
  const bytes = await fetchPdf({
    ...rest,
    stageTimeoutMs: guard.remainingMs(),
  });

  // Extraction is the one CPU-bound step here and a long document is not free,
  // so the clock is read across it too rather than only around the network.
  guard.check(0, "reading the text layer");
  const { pages, totalPages, chars } = await extractPdfText(bytes, rest);
  log(`pdf: ${totalPages} page(s), ${chars} chars of text layer`);

  const { markdown, batches, fallbacks } = await restorePdfStructure({
    chat,
    model,
    pages: stripRunningFurniture(pages),
    ...(batchChars !== undefined ? { batchChars } : {}),
    check: guard.check,
    ...(cache !== undefined ? { cache } : {}),
    log,
  });
  log(
    `pdf: ${batches} batch(es) restored, ${fallbacks} kept as extracted text`,
  );
  return { markdown, totalPages, fallbacks };
}
