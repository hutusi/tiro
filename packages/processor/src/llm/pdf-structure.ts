import { DeadlineExceededError } from "../deadline.ts";
import type { ChatFn } from "./client.ts";

/**
 * Turning a PDF's extracted text back into Markdown.
 *
 * The extraction stage produces reading-order text with line breaks wherever
 * the page had them, hyphenated words split across those breaks, and no
 * structure at all — a heading looks exactly like a sentence. This asks the
 * model for the structure back, and then checks that is what it did.
 *
 * The checks are the point. A model asked to restructure prose will sometimes
 * summarize it instead, and a summary that arrives as clean Markdown is
 * indistinguishable from success by inspection. So the result is measured
 * against its input, and a batch that fails falls back to the extracted text
 * rather than to whatever came back — ADR 0026's shape, and the same trade
 * `max_block_chars` already makes for translation: one unformatted batch beats
 * a batch that quietly says something else.
 */

/** Chars of extracted text per request. Pages are never split across requests,
 * so a single page larger than this is sent alone. */
const DEFAULT_BATCH_CHARS = 12_000;

/** How much of the input's alphanumeric content must survive.
 *
 * Rejoining hyphenated line breaks is the only thing that legitimately removes
 * characters, and it removes very few, so a batch that comes back much shorter
 * did not restructure — it summarized. Set well below what hyphen-joining costs
 * and well above what summarizing leaves. */
const MIN_RETENTION = 0.85;

/** And the other direction: a model that pads or invents. Markdown syntax and
 * paragraph breaks add a little, never half again. */
const MAX_GROWTH = 1.3;

/** A Markdown table's delimiter row. Its presence means the model rebuilt a
 * table out of extracted lines, which ADR 0026 clause 5 forbids: a blank cell
 * and an absent cell are the same bytes in a text layer, so a rebuilt row is a
 * guess that reads as data. */
const MD_TABLE_DELIMITER = /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/m;

const SYSTEM_PROMPT = `You restore structure to text extracted from a PDF. You are not an editor, a summarizer, or a typesetter.

Do:
- Rejoin words split by a hyphen at a line break ("mo-\\nments" becomes "moments").
- Join lines that belong to the same paragraph, and separate paragraphs with a blank line.
- Mark headings with #, ##, ### as their wording warrants.
- Keep lists as Markdown lists when the text is plainly a list.

Do not:
- Do not build Markdown tables. Leave tabular lines exactly as they are, one per line.
- Do not convert equations to LaTeX or any other notation. Leave them as the text you were given.
- Do not omit, summarize, shorten, reword, correct or add anything. Every word you were given must appear in your answer.
- Do not add a preamble, a title you invented, or any commentary.

Reply with the Markdown and nothing else.`;

export interface PdfStructureOptions {
  chat: ChatFn;
  model: string;
  /** Pages in reading order, furniture already stripped. */
  pages: string[];
  batchChars?: number;
  /** Attempts per batch before falling back to the extracted text. */
  maxAttempts?: number;
  /**
   * Asked before each batch, and free to throw.
   *
   * The stage cannot police its own budget from in here — it does not know
   * whether time ran out on the run or on the stage, and those want different
   * outcomes — so the caller decides and this just stops.
   */
  check?: (needMs: number, what: string) => void;
  log?: (message: string) => void;
}

export interface PdfStructureResult {
  markdown: string;
  batches: number;
  /** Batches kept as extracted text because no attempt passed the checks. */
  fallbacks: number;
}

/** Alphanumeric content only, so Markdown syntax and whitespace changes do not
 * register as content changes. */
function contentLength(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/** Group pages into requests without ever splitting one.
 *
 * A page is the boundary the source actually has, and it is where the
 * artifacts are — a paragraph broken across a page break is a real thing the
 * model should see whole rather than a seam this code invents. */
export function batchPages(pages: string[], batchChars: number): string[] {
  const batches: string[] = [];
  let current = "";
  for (const page of pages) {
    if (current !== "" && current.length + page.length > batchChars) {
      batches.push(current);
      current = "";
    }
    current = current === "" ? page : `${current}\n${page}`;
  }
  if (current.trim() !== "") batches.push(current);
  return batches;
}

/** Why a reply was refused, or null if it passed. Exported for the tests, which
 * is the only way to assert each guard independently of a model. */
export function rejectReason(input: string, reply: string): string | null {
  const answer = reply.trim();
  if (answer === "") return "empty reply";
  if (MD_TABLE_DELIMITER.test(answer)) return "rebuilt a markdown table";
  const before = contentLength(input);
  const after = contentLength(answer);
  if (before === 0) return null;
  const ratio = after / before;
  if (ratio < MIN_RETENTION) {
    return `dropped content (kept ${Math.round(ratio * 100)}%)`;
  }
  if (ratio > MAX_GROWTH) {
    return `added content (grew to ${Math.round(ratio * 100)}%)`;
  }
  return null;
}

/** Restore Markdown structure across a PDF's pages. */
export async function restorePdfStructure(
  options: PdfStructureOptions,
): Promise<PdfStructureResult> {
  const {
    chat,
    model,
    pages,
    batchChars = DEFAULT_BATCH_CHARS,
    maxAttempts = 2,
    check = () => {},
    log = () => {},
  } = options;

  const batches = batchPages(pages, batchChars);
  const out: string[] = [];
  let fallbacks = 0;

  for (const [index, batch] of batches.entries()) {
    // Before the request rather than after: a batch started with no budget
    // left is one the chat client will refuse anyway, and stopping here leaves
    // the batches already done for the caller to keep.
    check(0, `pdf batch ${index + 1} of ${batches.length}`);
    let restored: string | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let reply: string;
      try {
        reply = await chat({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: batch },
          ],
          // Restructuring has one right answer; sampling only invents.
          temperature: 0,
        });
      } catch (error) {
        // A blown budget is not a batch that failed, and treating it as one is
        // how a run that ran out of time produced a finished-looking article
        // made mostly of fallbacks. It has to reach the pipeline, which defers
        // the article with its work saved (invariant 8).
        if (error instanceof DeadlineExceededError) throw error;
        log(
          `pdf batch ${index + 1} attempt ${attempt} failed: ${String(error)}`,
        );
        continue;
      }
      const reason = rejectReason(batch, reply);
      if (reason === null) {
        restored = reply.trim();
        break;
      }
      log(`pdf batch ${index + 1} attempt ${attempt} rejected: ${reason}`);
    }
    if (restored === null) {
      fallbacks += 1;
      // The extracted text, unformatted but whole. Worse to read and honest
      // about what it is, which is the right side of ADR 0023's asymmetry.
      out.push(batch.trim());
    } else {
      out.push(restored);
    }
  }

  if (fallbacks > 0) {
    log(
      `${fallbacks} of ${batches.length} pdf batch(es) kept as extracted text`,
    );
  }
  return { markdown: out.join("\n\n"), batches: batches.length, fallbacks };
}
