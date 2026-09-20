import { type ArticleFrontmatter, isLocalDocument } from "@tiro/shared";
import {
  extractPdfText,
  type PdfTextOptions,
  pdfMarkdown,
  splitPdfPages,
  stripRunningFurniture,
} from "@tiro/shared/pdf";
import { type Deadline, StageTimeoutError } from "./deadline.ts";
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

/**
 * Where a PDF article's body is going to come from.
 *
 * Three answers, and they are irreducible — the text is fetched, or it is
 * already sitting in the body waiting to be structured, or the body *is* the
 * article and there is nothing to do. Every question the stage asks about a
 * PDF is one of these three wearing different clothes, and asking them
 * separately is what let three rounds of review find the same class of bug:
 * a marker read for something it does not mean, a stamp applied to both paths
 * when it belonged to one, a checkpoint loaded before anyone knew it was
 * needed.
 *
 * So it is decided once, by name, in front of the work.
 */
export type PdfSource =
  /** A URL the processor can fetch. Content addressing alone tells an
   * unchanged re-clip from a changed document, so the checkpoint needs no
   * stamp. */
  | { readonly kind: "download"; readonly url: string }
  /** An import: the body holds extracted text with its pages separated. Its
   * checkpoint is stamped, because a re-import writes byte-identical text and
   * content addressing cannot tell "try again" from "carry on". */
  | { readonly kind: "extracted"; readonly stamp: string }
  /** An import that has already been converted. Its bytes were never in the
   * vault, so there is nothing to re-derive and no checkpoint to consult. */
  | { readonly kind: "converted" };

/**
 * Which of the three applies to this article.
 *
 * `pdf_unstructured` rather than `processed_at`: the second looks like it
 * answers the same question and does not, because `markPending` clears it when
 * a forced run is deferred and leaves the finished body behind (ADR 0027).
 */
export function pdfSource(
  frontmatter: Pick<ArticleFrontmatter, "url" | "clipped_at" | "tiro">,
): PdfSource {
  const url = frontmatter.tiro.source_url ?? frontmatter.url;
  if (!isLocalDocument(url)) return { kind: "download", url };
  return frontmatter.tiro.pdf_unstructured === true
    ? { kind: "extracted", stamp: frontmatter.clipped_at }
    : { kind: "converted" };
}

/** What the structure pass needs, with nothing about fetching bytes. */
export interface PdfRestructureOptions {
  chat: ChatFn;
  model: string;
  batchChars?: number;
  /** Bounds this stage: `pdf.stage_timeout_ms`. */
  stageTimeoutMs: number;
  /** The run's budget. Separate from the stage's, because the two mean
   * different things when they expire — see `stageGuard`. */
  deadline: Deadline;
  cache?: PdfStructureOptions["cache"];
  requestMs?: number;
  log?: (message: string) => void;
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
  /** `llm.timeout_ms` — what one model call may cost, demanded of the budget
   * before a batch is started. */
  requestMs?: number;
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
        throw new StageTimeoutError("pdf", what);
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
    requestMs,
    log = () => {},
    ...rest
  } = options;
  const guard = stageGuard(stageTimeoutMs, deadline);

  guard.check(0, "fetching the PDF");
  let bytes: Uint8Array;
  try {
    bytes = await fetchPdf({ ...rest, stageTimeoutMs: guard.remainingMs() });
  } catch (error) {
    // The fetch is given whatever is left of the run, so a run that expires
    // mid-download aborts it — and `AbortSignal.timeout` raises a TimeoutError
    // whether the clock that ran out was the run's, the stage's, or this
    // document's own. Booked as a fault, that reports a routine end-of-budget
    // stop as a broken article. Re-reading the clock is what tells them apart;
    // `check` throws the right kind, and falls through when the download
    // simply failed.
    guard.check(0, "fetching the PDF");
    throw error;
  }

  // Extraction is the one CPU-bound step here and a long document is not free,
  // so the clock is read across it too rather than only around the network.
  guard.check(0, "reading the text layer");
  const { pages, totalPages, chars, layout } = await extractPdfText(
    bytes,
    rest,
  );
  log(`pdf: ${totalPages} page(s), ${chars} chars of text layer`);

  // Read again on the way out, not only on the way in. Extraction is the one
  // step here that can spend real time on its own — pdf.js is woken per page —
  // so a document that entered with budget can leave without it, and returning
  // a finished body then reports a run that overran as one that did not.
  guard.check(0, "building the article");

  // Where the document's own typography says what its structure is, that is
  // the answer — and a better one than a model inferring it from wording
  // (ADR 0028). It also costs nothing and cannot invent anything.
  if (layout.legible) {
    log(
      `pdf: structure read from the layout (${layout.headingSizes.length} heading level(s)); no model call`,
    );
    return { markdown: pdfMarkdown(layout), totalPages, fallbacks: 0 };
  }

  log("pdf: no legible layout; restoring structure with the model");
  return restructure(stripRunningFurniture(pages), { ...options, guard });
}

/**
 * Build an article body from text that was extracted somewhere else.
 *
 * The import path (ADR 0027). A document read off the owner's disk cannot be
 * fetched from CI, so the extension extracts it, applies the gates while it
 * still has a person to tell, strips the furniture while it still has pages,
 * and commits the text. Only the structure pass is left, and it is the same
 * one — the difference between the two paths is where the text came from, and
 * nothing after this point can tell.
 *
 * Pages are recovered from the separators the import wrote, because batching
 * is page-aware and a body flattened to one string would be sent as a single
 * enormous request.
 */
export async function restructurePdfText(
  body: string,
  options: PdfRestructureOptions,
): Promise<PdfConversion> {
  const guard = stageGuard(options.stageTimeoutMs, options.deadline);
  const pages = splitPdfPages(body);
  options.log?.(`pdf: restructuring ${pages.length} extracted page(s)`);
  return restructure(pages, { ...options, guard });
}

/** The half both paths share: the model pass, and the clocks around it. */
async function restructure(
  pages: string[],
  options: PdfRestructureOptions & { guard: ReturnType<typeof stageGuard> },
): Promise<PdfConversion> {
  const {
    chat,
    model,
    batchChars,
    cache,
    requestMs,
    guard,
    log = () => {},
  } = options;
  const { markdown, batches, fallbacks } = await restorePdfStructure({
    chat,
    model,
    pages,
    ...(batchChars !== undefined ? { batchChars } : {}),
    check: guard.check,
    // The cap has to reach inside a single chat() call as well. The client
    // retries within one call and knows only the run's deadline, so a batch
    // admitted with budget to spare could still return long after the stage
    // was over — the check before it cannot bound what happens after it.
    remainingMs: guard.remainingMs,
    ...(cache !== undefined ? { cache } : {}),
    ...(requestMs !== undefined ? { requestMs } : {}),
    log,
  });
  log(
    `pdf: ${batches} batch(es) restored, ${fallbacks} kept as extracted text`,
  );
  return { markdown, totalPages: pages.length, fallbacks };
}
