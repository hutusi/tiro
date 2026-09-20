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

/** A gutter has to be at least this many body widths of empty page. Narrower
 * than that is the space between words or table columns, not between columns
 * of prose. */
const GUTTER_MIN = 2.5;

/** And each side has to hold this share of the page's runs, so one indented
 * block does not read as a column. */
const COLUMN_MIN_SHARE = 0.25;

/**
 * Above this share of shared baselines, the page is rows — a table — and must
 * not be split into columns.
 *
 * The structural difference, after two proxies for it failed. A table *is*
 * rows: every baseline carries a cell on each side, by construction. Two
 * columns of prose are set independently and drift apart within a page or two,
 * because their paragraphs, headings and figures do not line up.
 *
 * Measured rather than chosen. A real two-column paper pairs 16%, 23% and 34%
 * of its baselines across three pages; a table pairs all of them. The gap is
 * wide enough that the threshold is not delicate, which is what the two earlier
 * rules — "cells are short", "the gap is wide" — never had.
 */
const ROW_PAIRED_SHARE = 0.6;

/** A run this much of the page wide spans the columns rather than sitting in
 * one — a banner title, a full-width figure caption. It cannot help locate the
 * gutter, and it must not be allowed to hide one. */
const SPANNING_WIDTH = 0.6;

/**
 * Where a page's columns divide, or null if it has one.
 *
 * Found from the geometry rather than assumed from the draw order. Content
 * order is *usually* reading order — a two-column paper emits the left column
 * and then the right — but nothing requires it, and a generator that draws row
 * by row produced "Left 1 Right 1" on one line, which then read as a table and
 * was fenced. Fencing prose is worse than merely reordering it: `code` is
 * verbatim by contract, so the text would never be translated either.
 *
 * A gutter is a vertical band of page that no run crosses. Runs wide enough to
 * span the columns are excluded from the search, or a banner title would close
 * the gap under itself and hide the division below.
 */
function pageGutter(
  items: readonly PdfTextItem[],
  bodySize: number,
): number | null {
  const narrow = items.filter(
    (item) => item.text.trim() !== "" && item.width > 0,
  );
  // Four is enough to see a gutter once the fill test below is doing the work
  // of telling prose from cells. Eight missed a page holding a title and two
  // lines of each column, which then interleaved.
  if (narrow.length < 4) return null;
  const pageWidth = Math.max(...narrow.map((i) => i.x + i.width));
  const spans = narrow.filter((i) => i.width < pageWidth * SPANNING_WIDTH);
  if (spans.length < 4) return null;

  const ranges = spans
    .map((i) => [i.x, i.x + i.width] as const)
    .sort((a, b) => a[0] - b[0]);
  let reach = ranges[0]?.[1] ?? 0;
  let best: { at: number; width: number } | null = null;
  for (const [start, end] of ranges) {
    if (start - reach > (best?.width ?? 0)) {
      best = { at: (reach + start) / 2, width: start - reach };
    }
    reach = Math.max(reach, end);
  }
  if (best === null || best.width < bodySize * GUTTER_MIN) return null;

  const left = narrow.filter((i) => i.x + i.width <= best.at);
  const right = narrow.filter((i) => i.x >= best.at);
  const share = narrow.length * COLUMN_MIN_SHARE;
  if (left.length < share || right.length < share) return null;

  // And the page must not be rows. A table's fields sit at the same widely
  // spaced x positions as page columns and can hold text just as long, so
  // neither the gap nor the amount in it tells them apart — see
  // ROW_PAIRED_SHARE.
  const sides = new Map<number, { left: boolean; right: boolean }>();
  for (const item of narrow) {
    const y = Math.round(item.y);
    const seen = sides.get(y) ?? { left: false, right: false };
    if (item.x + item.width <= best.at) seen.left = true;
    else if (item.x >= best.at) seen.right = true;
    sides.set(y, seen);
  }
  const baselines = [...sides.values()];
  const paired = baselines.filter((s) => s.left && s.right).length;
  if (baselines.length === 0) return null;
  return paired / baselines.length <= ROW_PAIRED_SHARE ? best.at : null;
}

/**
 * Runs in reading order: each page's columns, left to right, and each column
 * in the order the document emits it.
 *
 * A run crossing the gutter — the title over a two-column paper — belongs with
 * the left column, which is where it is read.
 */
function inReadingOrder(
  items: readonly PdfTextItem[],
  bodySize: number,
): PdfTextItem[] {
  const pages = new Map<number, PdfTextItem[]>();
  for (const item of items) {
    const page = pages.get(item.page) ?? [];
    page.push(item);
    pages.set(item.page, page);
  }
  const out: PdfTextItem[] = [];
  for (const page of [...pages.keys()].sort((a, b) => a - b)) {
    const runs = pages.get(page) ?? [];
    const gutter = pageGutter(runs, bodySize);
    if (gutter === null) {
      out.push(...runs);
      continue;
    }
    out.push(...runs.filter((i) => i.x < gutter));
    out.push(...runs.filter((i) => i.x >= gutter));
  }
  return out;
}

/**
 * Runs into lines, in the order the document emits them.
 *
 * Deliberately *not* sorted by height. A PDF's content stream already carries
 * reading order — for a two-column paper it emits the left column top to
 * bottom and then the right — and sorting by `y` interleaves the two, which is
 * exactly what pdf.js's own `extractText` avoids by leaving the order alone.
 * Sorting produced "Left column first Right column first" on one line and made
 * the page read as nonsense.
 *
 * Only the runs *within* a line are ordered, by x, since a line's pieces can be
 * emitted out of order when the font changes mid-sentence.
 */
function toLines(layout: PdfLayout): Line[] {
  const sorted = inReadingOrder(layout.items, layout.bodySize);
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

/** How much of a document a line must top or tail before it is furniture
 * rather than content — the share `stripRunningFurniture` uses on flat text. */
const FURNITURE_SHARE = 0.6;
const FURNITURE_MAX_CHARS = 100;

/** Page numbers differ by their number and nothing else. */
function furnitureKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\d+/g, "#");
}

/**
 * Drop the running headers and footers a document repeats on every page.
 *
 * The flat-text path has done this since ADR 0026; the structured path did not,
 * and a three-page document put the same journal header into the Markdown three
 * times. Done on lines rather than page strings because that is what this path
 * has, but by the same rule: only the first and last line of a page, only on a
 * document long enough for repetition to mean something, and only when short.
 */
function stripFurnitureLines(lines: readonly Line[], pages: number): Line[] {
  if (pages < 3) return [...lines];
  const first = new Map<number, Line>();
  const last = new Map<number, Line>();
  for (const line of lines) {
    if (!first.has(line.page)) first.set(line.page, line);
    last.set(line.page, line);
  }
  const tally = (edge: Map<number, Line>): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const line of edge.values()) {
      if (line.text.length > FURNITURE_MAX_CHARS) continue;
      const key = furnitureKey(line.text);
      if (key === "") continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const heads = tally(first);
  const feet = tally(last);
  const threshold = pages * FURNITURE_SHARE;
  const drop = new Set<Line>();
  for (const [page, line] of first) {
    if ((heads.get(furnitureKey(line.text)) ?? 0) >= threshold) drop.add(line);
    const foot = last.get(page);
    // A one-line page is its own first and last; dropping it twice is still
    // dropping the page.
    if (
      foot !== undefined &&
      foot !== line &&
      (feet.get(furnitureKey(foot.text)) ?? 0) >= threshold
    ) {
      drop.add(foot);
    }
  }
  return lines.filter((line) => !drop.has(line));
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

  // Every run placed at its own column, not just the first. Collapsing the
  // gaps to single spaces is what a fenced table loses everything to: two
  // aligned columns came out as "Name Value" and "Longer name 2", which is
  // neither a table nor an improvement on one.
  const lines = block.map((line) => {
    let out = "";
    let previous: PdfTextItem | undefined;
    for (const item of line.items) {
      if (item.text.trim() === "") continue;
      const column = Math.max(0, Math.round((item.x - left) / step));
      if (column > out.length) {
        out += " ".repeat(column - out.length);
      } else if (
        previous !== undefined &&
        item.x - (previous.x + previous.width) > 0.1 &&
        !out.endsWith(" ")
      ) {
        // Only where the page actually left a gap. Padding unconditionally put
        // a space between runs that touch, so `foo` in Courier followed by
        // `Bar` in Courier-Bold — one word split by a font change — came out as
        // `foo Bar`.
        out += " ";
      }
      out += item.text.trim();
      previous = item;
    }
    return out.replace(/\s+$/, "");
  });

  // Long enough that nothing inside can close it. A code block containing a
  // line of three backticks otherwise parsed as code, then a paragraph, then
  // more code.
  const longest = lines.reduce((n, line) => {
    const run = line.match(/`+/g)?.reduce((m, r) => Math.max(m, r.length), 0);
    return Math.max(n, run ?? 0);
  }, 0);
  const rail = "`".repeat(Math.max(3, longest + 1));
  return [rail, ...lines, rail].join("\n");
}

/**
 * A block containing bullets, rendered as a list.
 *
 * Split at the bullets rather than demanded of every line. Requiring all of
 * them meant a list lost its formatting the moment one item wrapped onto a
 * second line or the block opened with a sentence introducing it — which is
 * most lists — and the bullets then arrived as literal characters inside a
 * paragraph.
 *
 * Returns null where there is nothing to make a list from, so an ordinary
 * paragraph is not put through this at all.
 */
function toList(block: readonly Line[], bodySize: number): string | null {
  const firstBullet = block.findIndex((line) => BULLET.test(line.text));
  if (firstBullet === -1) return null;

  const parts: string[] = [];
  const lead = block.slice(0, firstBullet);
  if (lead.length > 0) parts.push(joinWrapped(lead));

  const margin = block[firstBullet]?.x ?? 0;
  const items: Line[][] = [];
  const after: Line[] = [];
  for (const line of block.slice(firstBullet)) {
    if (after.length > 0) {
      after.push(line);
      continue;
    }
    if (BULLET.test(line.text) || items.length === 0) {
      items.push([line]);
      continue;
    }
    // A wrapped item hangs under its bullet; a line back at the margin has
    // left the list. Without that, a sentence closing the section was absorbed
    // into the final bullet — "- Second point Conclusion after the list."
    if (line.x > margin + bodySize * 0.5) {
      items[items.length - 1]?.push(line);
    } else {
      after.push(line);
    }
  }
  parts.push(
    items
      .map((item) => `- ${joinWrapped(item).replace(BULLET, "")}`)
      .join("\n"),
  );
  if (after.length > 0) parts.push(joinWrapped(after));
  return parts.join("\n\n");
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
  const lines = stripFurnitureLines(toLines(layout), layout.totalPages);
  for (const block of toBlocks(lines, bodySize)) {
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

    const list = toList(block, bodySize);
    if (list !== null) {
      out.push(list);
      continue;
    }

    out.push(joinWrapped(block));
  }
  return `${out.join("\n\n").trim()}\n`;
}
