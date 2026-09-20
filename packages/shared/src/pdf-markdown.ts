import type { PdfLayout, PdfTextItem } from "./pdf-layout.ts";

/**
 * Building Markdown from a PDF's layout (ADR 0028).
 *
 * Deterministic, which is the point: the structure is *in* the document, and
 * reading it is not a judgement a model has to make. What cannot be read this
 * way — figures, mathematics — is not invented here either.
 */

/** Runs whose baselines are this close are on the same line. Superscripts and
 * the odd font switch drift a little without starting a new one. */
const LINE_TOLERANCE = 2;

/** A gap wider than this many multiples of the document's own line spacing
 * ends a block. Against *measured* spacing rather than the font size, because
 * leading is a decision the document made and not one derivable from the type:
 * an 11pt body set on 28pt leading broke every single line into its own
 * paragraph when this was a multiple of the size.
 *
 * And the margin is narrower than it looks. The guide separates its lines by
 * 20pt and its paragraphs by 28 — a ratio of 1.4 — so a threshold set at 1.45
 * of the measured leading ran every paragraph on a page into one. There is
 * usually one step between the two, not an order of magnitude. */
const BLOCK_GAP = 1.25;

/** Fallback where a document has too few lines to measure — a multiple of the
 * body size, which is what leading usually is. */
const DEFAULT_LEADING = 1.6;

/** An x-gap this many times the body size reads as a column boundary rather
 * than a word space. */
const COLUMN_GAP = 1.5;

/** Lines sharing this many column starts, this many times over, are tabular. */
const TABLE_MIN_COLUMNS = 2;
const TABLE_MIN_ROWS = 2;

interface Line {
  items: PdfTextItem[];
  text: string;
  /** The largest size on the line — a heading is not demoted by a footnote
   * marker sharing its baseline. */
  size: number;
  y: number;
  x: number;
  page: number;
  mono: boolean;
  /** Where each run starts, for spotting columns. */
  columns: number[];
}

/** Join runs into a line, inserting a space only where the page left one. */
function lineText(items: readonly PdfTextItem[], bodySize: number): string {
  let out = "";
  let previous: PdfTextItem | undefined;
  for (const item of items) {
    if (previous !== undefined) {
      const gap = item.x - (previous.x + previous.width);
      // A run that merely continues the previous one is concatenated: pdf.js
      // splits at font changes, and `dif` + `ferent` must not become two words.
      if (
        gap > bodySize * 0.12 &&
        !out.endsWith(" ") &&
        !item.text.startsWith(" ")
      ) {
        out += " ";
      }
    }
    out += item.text;
    previous = item;
  }
  return out.replace(/\s+/g, " ").trim();
}

function toLines(layout: PdfLayout): Line[] {
  const sorted = [...layout.items].sort(
    (a, b) => a.page - b.page || b.y - a.y || a.x - b.x,
  );
  const lines: Line[] = [];
  let current: PdfTextItem[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const items = [...current].sort((a, b) => a.x - b.x);
    const text = lineText(items, layout.bodySize);
    if (text !== "") {
      lines.push({
        items,
        text,
        size: Math.max(...items.map((i) => i.size)),
        y: items[0]?.y ?? 0,
        x: items[0]?.x ?? 0,
        page: items[0]?.page ?? 1,
        // A line counts as code only if all of its text is: a monospace word
        // inside a sentence is not a code block.
        mono: items.every((i) => i.mono || i.text.trim() === ""),
        columns: items.map((i) => i.x),
      });
    }
    current = [];
  };

  for (const item of sorted) {
    const head = current[0];
    if (
      head !== undefined &&
      (item.page !== head.page || Math.abs(item.y - head.y) > LINE_TOLERANCE)
    ) {
      flush();
    }
    current.push(item);
  }
  flush();
  return lines;
}

/**
 * The gap this document puts between consecutive lines of a paragraph.
 *
 * The most common gap, not the mean: a mean is dragged upwards by the space
 * around headings and between blocks, which are the very things being looked
 * for. Rounded to the point so that near-identical leading counts once.
 */
function lineSpacing(lines: readonly Line[], bodySize: number): number {
  const gaps = new Map<number, number>();
  for (let i = 1; i < lines.length; i += 1) {
    const previous = lines[i - 1];
    const line = lines[i];
    if (previous === undefined || line === undefined) continue;
    if (previous.page !== line.page) continue;
    const gap = Math.round(previous.y - line.y);
    if (gap <= 0 || gap > bodySize * 4) continue;
    gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }
  const common = [...gaps.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return common ?? bodySize * DEFAULT_LEADING;
}

/**
 * How far apart two lines of this size may sit and still be one block.
 *
 * Scaled to the line's own size, because leading is: a 20pt title set 28pt
 * apart is tightly packed, while an 11pt body 28pt apart has a paragraph break
 * in it. Measured against the body's leading alone, a two-line title came out
 * as two separate headings.
 */
function expectedLeading(
  size: number,
  bodySize: number,
  leading: number,
): number {
  const scale = bodySize > 0 ? Math.max(1, size / bodySize) : 1;
  return leading * scale * BLOCK_GAP;
}

function toBlocks(lines: readonly Line[], bodySize: number): Line[][] {
  const leading = lineSpacing(lines, bodySize);
  const blocks: Line[][] = [];
  let block: Line[] = [];
  for (const line of lines) {
    const last = block[block.length - 1];
    const broken =
      last !== undefined &&
      (line.page !== last.page ||
        line.mono !== last.mono ||
        // A size change is a structural boundary: a heading never shares a
        // block with the paragraph beneath it.
        Math.abs(line.size - last.size) > 0.5 ||
        last.y - line.y > expectedLeading(last.size, bodySize, leading));
    if (broken) {
      blocks.push(block);
      block = [];
    }
    block.push(line);
  }
  if (block.length > 0) blocks.push(block);
  return blocks;
}

/** Rejoin a word the page broke across a line, and otherwise join with a
 * space. A hyphen before a lowercase letter is a break; one before a capital
 * or a digit is a real hyphen in a name or a range. */
function joinWrapped(lines: readonly Line[]): string {
  let out = "";
  for (const line of lines) {
    if (out === "") {
      out = line.text;
      continue;
    }
    if (/[a-z]-$/.test(out) && /^[a-z]/.test(line.text)) {
      out = `${out.slice(0, -1)}${line.text}`;
    } else {
      out += ` ${line.text}`;
    }
  }
  return out;
}

const BULLET = /^\s*([•·▪◦‣–—*-]|\d+[.)])\s+/;

/** Do these lines line up in columns? Tabular blocks are fenced rather than
 * rebuilt — ADR 0028 clause 7. */
function looksTabular(lines: readonly Line[], bodySize: number): boolean {
  if (lines.length < TABLE_MIN_ROWS) return false;
  const starts = lines.map((line) => {
    const columns: number[] = [];
    let previous: PdfTextItem | undefined;
    for (const item of line.items) {
      if (
        previous === undefined ||
        item.x - (previous.x + previous.width) > bodySize * COLUMN_GAP
      ) {
        columns.push(Math.round(item.x));
      }
      previous = item;
    }
    return columns;
  });
  if (!starts.every((c) => c.length >= TABLE_MIN_COLUMNS)) return false;
  // The same columns, row after row — one ragged line is not a table.
  const first = starts[0] ?? [];
  return starts.every(
    (columns) =>
      columns.length === first.length &&
      columns.every((x, i) => Math.abs(x - (first[i] ?? 0)) <= bodySize),
  );
}

/**
 * A fenced block that keeps its indentation.
 *
 * Code without indentation is still code, but it is markedly worse to read, and
 * the offsets are right there in the runs. Measured against the block's own
 * left edge rather than the page's, so a whole block set in from the margin
 * does not arrive drowning in leading spaces.
 */
function fence(block: readonly Line[], bodySize: number): string {
  const left = Math.min(...block.map((line) => line.x));
  // A monospace character advances about six tenths of its size — the figure
  // both fixed-width faces in the measured documents came out at.
  const step = Math.max(1, bodySize * 0.6);
  const lines = block.map((line) => {
    const indent = Math.max(0, Math.round((line.x - left) / step));
    return `${" ".repeat(indent)}${line.text}`;
  });
  return ["```", ...lines, "```"].join("\n");
}

/**
 * Markdown for a document whose layout could be read.
 *
 * Call only when `layout.legible`; on anything else this produces confident
 * nonsense, and the flat-text path with its model pass is the better answer.
 */
export function pdfMarkdown(layout: PdfLayout): string {
  const { bodySize, headingSizes } = layout;
  const levelOf = (size: number): number | null => {
    const index = headingSizes.findIndex((s) => Math.abs(s - size) <= 0.5);
    return index === -1 ? null : Math.min(index + 1, 3);
  };

  const out: string[] = [];
  for (const block of toBlocks(toLines(layout), bodySize)) {
    const first = block[0];
    if (first === undefined) continue;

    if (first.mono) {
      out.push(fence(block, bodySize));
      continue;
    }

    const level = levelOf(first.size);
    if (level !== null) {
      // Wrapped headings are one heading; the page broke the line, not the
      // author.
      out.push(`${"#".repeat(level)} ${joinWrapped(block)}`);
      continue;
    }

    if (looksTabular(block, bodySize)) {
      out.push(fence(block, bodySize));
      continue;
    }

    if (block.every((line) => BULLET.test(line.text))) {
      out.push(
        block.map((line) => `- ${line.text.replace(BULLET, "")}`).join("\n"),
      );
      continue;
    }

    out.push(joinWrapped(block));
  }
  return `${out.join("\n\n").trim()}\n`;
}
