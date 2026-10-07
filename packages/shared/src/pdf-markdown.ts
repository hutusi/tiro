import { furnitureLines } from "./pdf-furniture.ts";
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
  /** Where the line's last run ends. */
  right: number;
  page: number;
  mono: boolean;
  /** Where each run starts, for spotting columns. */
  columns: number[];
}

/** Join runs into a line, inserting a space only where the page left one. A
 * mark raised above `baseline` keeps its superscript, so a footnote reads
 * `[22].<sup>1</sup>` and an exponent `10<sup>13</sup>`, not `1013`; the site's
 * sanitizer admits `sup`. */
function lineText(
  items: readonly PdfTextItem[],
  bodySize: number,
  baseline: number,
): string {
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
    out +=
      isMark(item, bodySize) && item.y - baseline > LINE_TOLERANCE
        ? // The run's own spaces stay outside the tag: pdf.js hands over "3 ",
          // and the space is the only word break before the next run.
          item.text.replace(/^(\s*)(.*?)(\s*)$/su, "$1<sup>$2</sup>$3")
        : item.text;
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
 * Runs gathered onto shared baselines, within `LINE_TOLERANCE`.
 *
 * The same grouping `toLines` does, and it has to be the same: a row whose
 * cells differ by a fraction of a point is one row to the reader, to the line
 * builder, and so to the test that decides whether a page is rows.
 */
function groupBaselines(
  items: readonly PdfTextItem[],
): Map<number, PdfTextItem[]> {
  const rows = new Map<number, PdfTextItem[]>();
  const anchors: number[] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y)) {
    let anchor = anchors.find((y) => Math.abs(y - item.y) <= LINE_TOLERANCE);
    if (anchor === undefined) {
      anchor = item.y;
      anchors.push(anchor);
      rows.set(anchor, []);
    }
    rows.get(anchor)?.push(item);
  }
  return rows;
}

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
  // Clustered with the tolerance `toLines` groups by, not rounded. Rounding
  // each baseline on its own splits a row whose two cells sit a point apart —
  // one rounds up, the other down — and a table of ten such rows then measured
  // as nought per cent paired, passed the column test, and lost every row.
  const baselines = [...groupBaselines(narrow).values()].map((row) => ({
    left: row.some((i) => i.x + i.width <= best.at),
    right: row.some((i) => i.x >= best.at),
  }));
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
/** What a footnote or reference mark is made of. */
const MARK_TEXT = /^[0-9*†‡§¶]{1,3}$/u;

/** How far above its line's baseline a mark may sit, as a share of the line's
 * size. Measured: the intelligence-explosion paper raises its 8pt marks 4pt
 * over a 10.9pt body. */
const MARK_RAISE = 0.6;

/** A superscript mark: a digit or a dagger, set smaller than the body. */
function isMark(item: PdfTextItem, bodySize: number): boolean {
  return item.size < bodySize - SIZE_STEP && MARK_TEXT.test(item.text.trim());
}

/** Size changes smaller than this are not changes. */
const SIZE_STEP = 0.5;

/**
 * Does `item` belong on the line whose text sits on `baseline`?
 *
 * On the baseline, give or take `LINE_TOLERANCE`. A superscript mark sits
 * higher, by more than that, and was read as a line of its own. Its paragraph
 * then broke around it: the intelligence-explosion paper had a stray "1" or
 * "5" as a paragraph wherever a footnote was cited, and the rest of the
 * sentence opened a new one.
 */
function onLine(
  item: PdfTextItem,
  baseline: PdfTextItem,
  bodySize: number,
): boolean {
  if (item.page !== baseline.page) return false;
  const rise = item.y - baseline.y;
  if (Math.abs(rise) <= LINE_TOLERANCE) return true;
  if (isMark(item, bodySize)) {
    return rise > 0 && rise <= baseline.size * MARK_RAISE;
  }
  // The text after a mark that opened the line, back on the baseline.
  if (isMark(baseline, bodySize)) {
    return rise < 0 && -rise <= item.size * MARK_RAISE;
  }
  return false;
}

function toLines(layout: PdfLayout): Line[] {
  const sorted = inReadingOrder(layout.items, layout.bodySize);
  const lines: Line[] = [];
  let current: PdfTextItem[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const items = [...current].sort((a, b) => a.x - b.x);
    // The text's baseline, not a mark's: a line's y measures the gaps that
    // decide where paragraphs end.
    const body = items.find((i) => !isMark(i, layout.bodySize)) ?? items[0];
    const text = lineText(items, layout.bodySize, body?.y ?? 0);
    if (text !== "") {
      lines.push({
        items,
        text,
        size: Math.max(...items.map((i) => i.size)),
        y: body?.y ?? 0,
        x: items[0]?.x ?? 0,
        right: Math.max(...items.map((i) => i.x + i.width)),
        page: items[0]?.page ?? 1,
        // A line counts as code only if all of its text is: a monospace word
        // inside a sentence is not a code block.
        mono: items.every((i) => i.mono || i.text.trim() === ""),
        columns: items.map((i) => i.x),
      });
    }
    current = [];
  };

  // The run whose baseline the line is on: its first one that is not a mark.
  let baseline: PdfTextItem | undefined;
  for (const item of sorted) {
    if (baseline !== undefined && !onLine(item, baseline, layout.bodySize)) {
      flush();
      baseline = undefined;
    }
    current.push(item);
    if (
      baseline === undefined ||
      (isMark(baseline, layout.bodySize) && !isMark(item, layout.bodySize))
    ) {
      baseline = item;
    }
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

/**
 * How far an OCR text layer's sizes wobble around the body.
 *
 * A scan's invisible text layer reports each word's size as the height of the
 * glyphs OCR found, rounded to a whole point, so one paragraph comes out as a
 * mix of 9 and 10. Measured on a scanned 1973 paper (Tesseract's
 * `GlyphLessFont`): 340 lines at 10pt and 189 at 9, alternating within
 * paragraphs. Every alternation broke a block, and its 259 blocks were
 * paragraphs cut every one to three lines. Typeset documents never came near
 * this: a two-paper sample's only size changes of a point or less were among
 * a diagram's 4-6pt labels.
 */
const BODY_WOBBLE = 1;

/** Is a size change between two lines only the OCR wobble above? Both must
 * sit by the body and neither may be a heading size, so a heading still never
 * shares a block with the paragraph beneath it. */
function wobble(
  a: number,
  b: number,
  bodySize: number,
  headingSizes: readonly number[],
): boolean {
  // To the tenth of a point, as `bodySize` and `headingSizes` key them: the
  // layer reports 9 as 8.99973, a hair more than a point from a 10pt body.
  const tenth = (size: number): number => Math.round(size * 10) / 10;
  const nearBody = (size: number): boolean =>
    Math.abs(tenth(size) - bodySize) <= BODY_WOBBLE &&
    !headingSizes.some((heading) => Math.abs(heading - tenth(size)) <= 0.5);
  return (
    Math.abs(tenth(a) - tenth(b)) <= BODY_WOBBLE && nearBody(a) && nearBody(b)
  );
}

/** A line that closes a sentence, behind any closing quote or bracket. */
const SENTENCE_END = /[.!?:;]["'”’»)\]]*$/u;

/**
 * Does `line` open a paragraph by its indent alone?
 *
 * Typeset text often marks a paragraph with a first-line indent and no extra
 * space, and the gap rule cannot see that. Measured on the vault's PDFs: two
 * LaTeX papers and a 1973 scan all do it, the scan with nothing else. An
 * indent alone is not enough, though. A reference entry or a wrapped legal
 * clause hangs its second line by the same amount. What tells them apart is
 * the line above. A paragraph's last line ends a sentence and stops short of
 * the measure, while a hanging continuation follows a full one.
 *
 * Bounded at four sizes so a jump to the next column, which is also below
 * and to the right, is never read as an indent, and only on the way down.
 */
function opensIndentedParagraph(
  line: Line,
  last: Line,
  blockRight: number,
  bodySize: number,
): boolean {
  if (line.page !== last.page || line.y >= last.y || line.mono) return false;
  const indent = line.x - last.x;
  if (indent < bodySize * 0.8 || indent > bodySize * 4) return false;
  if (BULLET.test(last.text)) return false;
  const measure = Math.max(blockRight, line.right);
  return (
    SENTENCE_END.test(last.text.trim()) && last.right < measure - bodySize * 2
  );
}

/**
 * Does `line` carry on the paragraph the previous page left unfinished?
 *
 * A page break ends a block, and a paragraph that runs over one was cut in
 * two, with a word hyphenated across the break stranded at the end of the
 * first half ("out-", then "pace" on the next page). When the page stops
 * mid-sentence and the next one opens in lowercase, it is the same paragraph.
 *
 * A paragraph, not a list. A numbered endnote that ran over a page took the
 * next page's whole list with it, and `toList` then read the continuation
 * line, back at the margin, as the list's end, flattening every item after it
 * into one paragraph.
 */
function continuesOverPage(
  line: Line,
  last: Line,
  block: readonly Line[],
): boolean {
  return (
    line.page === last.page + 1 &&
    !block.some((held) => BULLET.test(held.text)) &&
    !line.mono &&
    !last.mono &&
    !SENTENCE_END.test(last.text.trim()) &&
    /^\p{Ll}/u.test(line.text)
  );
}

function toBlocks(
  lines: readonly Line[],
  bodySize: number,
  headingSizes: readonly number[],
): Line[][] {
  const leading = lineSpacing(lines, bodySize);
  const blocks: Line[][] = [];
  let block: Line[] = [];
  let blockRight = 0;
  for (const line of lines) {
    const last = block[block.length - 1];
    const broken =
      last !== undefined &&
      ((line.page !== last.page && !continuesOverPage(line, last, block)) ||
        line.mono !== last.mono ||
        // A size change is a structural boundary: a heading never shares a
        // block with the paragraph beneath it.
        (Math.abs(line.size - last.size) > 0.5 &&
          !wobble(line.size, last.size, bodySize, headingSizes)) ||
        last.y - line.y > expectedLeading(last.size, bodySize, leading) ||
        opensIndentedParagraph(line, last, blockRight, bodySize));
    if (broken) {
      blocks.push(block);
      block = [];
      blockRight = 0;
    }
    block.push(line);
    blockRight = Math.max(blockRight, line.right);
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
 * Drop the running headers and footers a document repeats on every page.
 *
 * The flat-text path has done this since ADR 0026; the structured path did not,
 * and a three-page document put the same journal header into the Markdown three
 * times. The rule is `furnitureLines`, which both paths share, applied here to
 * lines rather than page strings because lines are what this path has.
 */
function stripFurnitureLines(lines: readonly Line[], pages: number): Line[] {
  // Every page has an entry, an empty one included, so the share is a share
  // of the whole document.
  const byPage: Line[][] = Array.from({ length: pages }, () => []);
  for (const line of lines) byPage[line.page - 1]?.push(line);
  const drop = furnitureLines(byPage.map((page) => page.map((l) => l.text)));
  const gone = new Set<Line>();
  byPage.forEach((page, i) => {
    for (const index of drop[i] ?? []) {
      const line = page[index];
      if (line !== undefined) gone.add(line);
    }
  });
  return lines.filter((line) => !gone.has(line));
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

  // A heading's level is decided once every block is in, by `headsSomething`.
  const out: { text: string; level: number | null }[] = [];
  const push = (text: string): void => {
    out.push({ text, level: null });
  };
  const lines = stripFurnitureLines(toLines(layout), layout.totalPages);
  for (const block of toBlocks(lines, bodySize, headingSizes)) {
    const first = block[0];
    if (first === undefined) continue;

    if (first.mono) {
      push(fence(block, bodySize));
      continue;
    }

    const level = levelOf(first.size);
    if (level !== null) {
      // Wrapped headings are one heading; the page broke the line, not the
      // author.
      out.push({ text: joinWrapped(block), level });
      continue;
    }

    if (looksTabular(block, bodySize)) {
      push(fence(block, bodySize));
      continue;
    }

    const list = toList(block, bodySize);
    if (list !== null) {
      push(list);
      continue;
    }

    push(joinWrapped(block));
  }
  return `${out
    .map(({ text, level }, i) =>
      level !== null && headsSomething(out, i)
        ? `${"#".repeat(level)} ${text}`
        : text,
    )
    .join("\n\n")
    .trim()}\n`;
}

/**
 * Does the heading at `index` head any text?
 *
 * A heading owns everything up to the next one of its rank or higher. One
 * that owns no body text, only other headings or nothing, heads an empty
 * section, and that is what a paper's front matter looks like set large. The
 * tracker paper set each of its nine authors at 12pt and each affiliation at
 * 10pt, both heading sizes, and came out as eighteen headings between the
 * title and the abstract. Size cannot tell them from a heading. Their
 * arrangement can: a real outline, from part to chapter to section, always
 * reaches text, so every level of it keeps its heading.
 *
 * Read against the levels as first assigned, so demoting one front-matter
 * line does not turn it into text that keeps the one above it a heading.
 */
function headsSomething(
  entries: readonly { level: number | null }[],
  index: number,
): boolean {
  const own = entries[index]?.level;
  if (own === null || own === undefined) return false;
  for (const entry of entries.slice(index + 1)) {
    if (entry.level === null) return true;
    if (entry.level <= own) return false;
  }
  return false;
}
