import {
  cellWallOffsets,
  emphasisStarts,
  flowRanges,
  opensEmphasisAt,
  plainText,
  splitBlocks,
  textRanges,
} from "./blocks.ts";

/**
 * CommonMark will not read `_` as an emphasis delimiter between two word
 * characters, so that `snake_case_name` stays one word. CJK ideographs are
 * word characters by that definition — they are neither whitespace nor
 * Unicode punctuation — and Chinese prose has no spaces to separate them, so
 * `细节_真的_很重要` is literally two underscores on the page.
 *
 * `*` carries no such rule: `细节*真的*很重要` is emphasis. The delimiters mean
 * the same thing everywhere else, which is what makes swapping one for the
 * other a repair rather than an edit.
 *
 * Hiragana, Katakana and Hangul are here with Han because the rule is about
 * scripts without word separators, not about Chinese: a Japanese or Korean
 * translation would break identically. Fullwidth punctuation is deliberately
 * absent — it is not a word character, so it never triggers the intraword
 * rule; a delimiter beside `，` or `。` fails for the *other* CommonMark reason
 * (the run is not flanking), which no delimiter can express, and the site
 * handles it in the parser instead.
 */
const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;

/** The longest delimiter run this repairs: `_`, `__` and `___` are emphasis,
 * strong, and both — past that CommonMark's own reading gets ambiguous, and a
 * run that long in prose is far more likely to be a rule or a table. */
const MAX_RUN = 3;

/** One `_…_` span, by the source offset and length of each delimiter run. */
interface Pair {
  open: number;
  close: number;
  /** Characters in each run — 1 for `_x_`, 2 for `__x__`. Both runs are this
   * long, because a repair that changed the run length would change what the
   * span means. */
  length: number;
}

/**
 * Whether the character at `offset` is escaped — an odd number of backslashes
 * in front of it. `\_` is a literal underscore the author asked for, and
 * `\\_` is a literal backslash followed by a delimiter.
 */
function isEscaped(source: string, offset: number): boolean {
  let slashes = 0;
  for (let i = offset - 1; i >= 0 && source[i] === "\\"; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/**
 * The whole character on either side of `offset` — a code point, not a UTF-16
 * code unit.
 *
 * `source[offset - 1]` is half a surrogate pair for anything outside the BMP,
 * and CJK reaches well outside it: Extension B onwards holds the rare
 * characters that turn up in names. `𠮷_强调_8` read its neighbour as a lone
 * surrogate, concluded there was no CJK beside the delimiter, and left the
 * span broken. Spreading a two-unit slice iterates by code point, which
 * reassembles a pair and leaves an ordinary character alone.
 *
 * Their *lengths* stay in code units on purpose — the parser reports offsets
 * that way, so the probe below counts in the same currency.
 */
function charBefore(source: string, offset: number): string {
  return [...source.slice(Math.max(0, offset - 2), offset)].at(-1) ?? "";
}

function charAfter(source: string, offset: number): string {
  return [...source.slice(offset, offset + 2)].at(0) ?? "";
}

/**
 * Whether this character ends a line.
 *
 * CommonMark counts a bare `\r` as a line ending, and markdown written that
 * way reaches here intact — the processor's repair pass normalizes CRLF and
 * leaves CR-only bodies alone, having nothing to pair the `\r` with. Testing
 * for `\n` alone let a span cross a line in exactly those documents, which is
 * the one thing the one-line rule exists to stop.
 */
function isLineEnd(char: string | undefined): boolean {
  return char === "\n" || char === "\r";
}

/** Length of the run of underscores starting at `offset`, bounded by `end`. */
function runLength(source: string, offset: number, end: number): number {
  let length = 0;
  while (offset + length < end && source[offset + length] === "_") length += 1;
  return length;
}

/**
 * Whether the span would be emphasis if the CJK letters beside it were spaces
 * — that is, whether CJK adjacency is the *only* reason the parser refused it.
 *
 * One character on each side is the whole context: CommonMark's flanking rules
 * read the character immediately before the opening run and immediately after
 * the closing one, and nothing further out. The `a`/`b` around it only stop a
 * neighbour from being read as a line-start construct — `#`, `>`, `-` all mean
 * something at the beginning of a line and nothing in the middle of one.
 */
function curedByCjk(source: string, pair: Pair): boolean {
  const neighbour = (char: string): string =>
    char === "" || char === "\n" || CJK.test(char) ? " " : char;
  const left = neighbour(charBefore(source, pair.open));
  const right = neighbour(charAfter(source, pair.close + pair.length));
  const inner = source.slice(pair.open + pair.length, pair.close);
  const run = "_".repeat(pair.length);
  return opensEmphasisAt(
    `a${left}${run}${inner}${run}${right}b`,
    1 + left.length,
  );
}

/**
 * Whether this span is one the author meant as emphasis.
 *
 * **This repair only ever cures CJK adjacency**, so a span with no CJK letter
 * immediately outside either delimiter is not its business, whatever else is
 * wrong with it. That is the first condition, and it is what tells
 * `my_报告_draft` — an identifier, Latin on both sides — from `细节_真的_很重要`.
 *
 * Given that, two ways for the adjacency to be the whole story:
 *
 * - **CJK inside the delimiters** means the span is CJK text, which no
 *   identifier is a fragment of. This is the ordinary case, and it has to be
 *   decided here rather than by the probe — `不会_少于_8个月` is emphasis even
 *   though the `8` after it is a word character, because the obstacle is the
 *   CJK letter on the *inside* edge, which no substitution outside can lift.
 * - **Otherwise** the content is Latin and could belong to an identifier, so
 *   ask the probe: `一个_tick_（时刻）` is emphasis and `中文_file_name` is not,
 *   and what separates them is CommonMark's own intraword rule read on the
 *   Latin side — punctuation after the closing run in the first, a word
 *   character in the second.
 *
 * The whitespace check stays in front of all of it. No emphasis delimiter is
 * preceded or followed by a space, and the CJK clause would otherwise accept
 * `_ 中文 _`.
 */
function isEmphasis(source: string, pair: Pair): boolean {
  const inner = source.slice(pair.open + pair.length, pair.close);
  if (inner.length === 0) return false;
  if (/^\s/.test(inner) || /\s$/.test(inner)) return false;
  const before = charBefore(source, pair.open);
  const after = charAfter(source, pair.close + pair.length);
  if (!CJK.test(before) && !CJK.test(after)) return false;
  return CJK.test(inner) || curedByCjk(source, pair);
}

/**
 * The source with everything outside a text node blanked out.
 *
 * A span's two delimiters need not sit in the same text node: emphasis that
 * wraps a link — `_[New York Times](url)_` — keeps one delimiter at the end of
 * the paragraph's text and the other at the start of the text after it, with
 * the link node between them, and a scan that never left one node could not
 * pair them at all. Blanking the gaps rather than skipping them lets a single
 * linear pass do it, while keeping the property the whole repair rests on:
 * every delimiter it rewrites is one the parser left inside a text node.
 *
 * Newlines survive the blanking, because the one-line rule has to see a break
 * wherever it falls — inside a link title as much as in the prose. A cell wall
 * becomes a break for the same reason: two cells are never one span, and
 * treating every pair of underscores in a wide table as a candidate made the
 * verification reject them one at a time, a full reparse each. Which `|` is a
 * wall is the parser's answer, not a guess about the character — one in a code
 * span, in a destination, or escaped inside a cell is ordinary text, and
 * stopping a span at it refused real repairs.
 */
function textOnly(
  source: string,
  ranges: readonly { start: number; end: number }[],
  walls: ReadonlySet<number>,
): string {
  const blank = (text: string, from: number): string =>
    text.replace(/[^\r\n]/g, (char, index: number) =>
      char === "|" && walls.has(from + index) ? "\n" : "\u0000",
    );
  const parts: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      parts.push(blank(source.slice(cursor, range.start), cursor));
    }
    parts.push(source.slice(range.start, Math.max(cursor, range.end)));
    cursor = Math.max(cursor, range.end);
  }
  return parts.join("") + blank(source.slice(cursor), cursor);
}

/**
 * Whether the run at `offset` opens a span of its own, nearer than the one
 * being considered and inside the same text node.
 *
 * A stray underscore reaching across an inline node can otherwise swallow the
 * *opener* of the span that follows it: in `中文_file[链接](url)中文_真的_文字`
 * the first underscore pairs with the second, which leaves `_真的_` broken and
 * italicises text nobody marked. Nothing downstream can tell that apart — the
 * rendered text is the same either way — so it has to be decided here, by
 * giving the nearer, same-node reading priority.
 *
 * Same node only, and one step only. Within a node, pairing left to right is
 * what `细节_真的_很重要_确实_如此` needs, and looking ahead there would pair
 * `_很重要_` and strand the two ends.
 */
function opensNearerSpan(
  source: string,
  scannable: string,
  offset: number,
  length: number,
): boolean {
  for (let i = offset + length; i < scannable.length; i += 1) {
    // The node ends at the first blanked character, and a break ends the line.
    if (scannable[i] === "\u0000" || isLineEnd(scannable[i])) return false;
    if (scannable[i] !== "_" || isEscaped(scannable, i)) continue;
    if (runLength(scannable, i, scannable.length) !== length) return false;
    return isEmphasis(source, { open: offset, close: i, length });
  }
  return false;
}

/**
 * Every `_…_` span in the document.
 *
 * `scannable` is where the delimiters are read from — the blanked source, so
 * an underscore outside a text node is invisible and a run cannot grow past
 * the node that holds it. Everything *about* a span is read from `source`,
 * because the characters flanking it and the content between them are what
 * CommonMark sees, gaps included.
 */
function pairsIn(source: string, scannable: string): Pair[] {
  // Underscores the parser already spent on a span of its own. Blanking cannot
  // distinguish those from an `a_b` inside a link destination — both sit
  // outside every text node — and the difference decides whether a pair is a
  // repair or a re-bracketing.
  const spent = emphasisStarts(source).filter((at) => source[at] === "_");
  // The innermost link or image label an offset sits in, or null for the
  // ordinary flow. Two spans can only be in each other's way when they share
  // one: what a label holds is bracketed by the label, from both directions.
  const flows = flowRanges(source);
  const flowOf = (at: number): { start: number; end: number } | null => {
    let innermost: { start: number; end: number } | null = null;
    for (const flow of flows) {
      if (at < flow.start || at >= flow.end) continue;
      if (innermost === null || flow.start > innermost.start) innermost = flow;
    }
    return innermost;
  };
  const found: Pair[] = [];
  let open = 0;
  while (open < scannable.length) {
    if (scannable[open] !== "_" || isEscaped(scannable, open)) {
      open += 1;
      continue;
    }
    // Runs are matched whole. Reading `中文__强调__文字` as a `_` pair with an
    // underscore either side of it rewrote the inner two and left the outer
    // two standing — italics with stray underscores, where the author wrote
    // strong emphasis.
    const length = runLength(scannable, open, scannable.length);
    let close = -1;
    for (let i = open + length; i < scannable.length; i += 1) {
      // Emphasis may span lines, but a span that does is far more likely to be
      // two unrelated underscores in a list or a table than one span, and the
      // swap would join them. One line, like the defect itself.
      if (isLineEnd(scannable[i])) break;
      if (scannable[i] === "_" && !isEscaped(scannable, i)) {
        // Only a run of the same length closes this one. A different length is
        // a shape CommonMark reads by splitting runs, which is more than a
        // delimiter swap can faithfully reproduce.
        close = runLength(scannable, i, scannable.length) === length ? i : -1;
        break;
      }
    }
    // Not `return`: an underscore with no partner on its line says nothing
    // about the rest of the document, and abandoning the scan there hid every
    // repairable span on the lines after it.
    if (close === -1 || length > MAX_RUN) {
      open += length;
      continue;
    }
    // Crossing an inline node is what makes a wrong pairing possible, so the
    // check is paid only there: within a node the greedy reading is the right
    // one, and has been all along.
    // A span the parser built between these two is its reading of the same
    // delimiters — `_"a"_，而_"b"_是指_"c"_` pairs its inner four and strands
    // the outer two, and joining those outer two would emphasise the entire
    // sentence instead of the three phrases the author marked.
    const flow = flowOf(open);
    // A pair that starts inside a label and ends outside it is not a span at
    // all — emphasis cannot straddle the bracket — and a span the parser built
    // in the same flow is its reading of these same delimiters.
    if (
      flowOf(close) !== flow ||
      spent.some((at) => at > open && at < close && flowOf(at) === flow)
    ) {
      open += length;
      continue;
    }
    if (
      scannable.slice(open, close).includes("\u0000") &&
      opensNearerSpan(source, scannable, close, length)
    ) {
      open += length;
      continue;
    }
    const pair = { open, close, length };
    if (isEmphasis(source, pair)) {
      found.push(pair);
      open = close + length;
    } else {
      // Only past the opening run: a rejected closer can still open the next
      // span, which is exactly the shape of `a_b_中文_很重要_`.
      open += length;
    }
  }
  return found;
}

/** The delimiter runs of these spans, in descending source order so that
 * editing one leaves the offsets of the rest valid. */
function runsOf(pairs: readonly Pair[]): { at: number; length: number }[] {
  return pairs
    .flatMap((pair) => [
      { at: pair.open, length: pair.length },
      { at: pair.close, length: pair.length },
    ])
    .sort((a, b) => b.at - a.at);
}

/** Swap every delimiter for `*`. Length-preserving, so a caller may apply
 * spans one at a time without recomputing the offsets between them. */
function swapped(source: string, pairs: readonly Pair[]): string {
  return runsOf(pairs).reduce(
    (text, run) =>
      text.slice(0, run.at) +
      "*".repeat(run.length) +
      text.slice(run.at + run.length),
    source,
  );
}

/**
 * Whether `after` differs from `before` in nothing but these delimiters.
 *
 * Deleting the underscores cannot create markup, so the deleted text is what
 * the page *should* read once the swap works; comparing the rendered text of
 * the two pins that the new `*` paired with its partner and not with some
 * literal asterisk further along. The block check is the alignment contract:
 * a swap that changed a block's type or count would cost the article its
 * side-by-side rendering (ADR 0003).
 */
function isSafe(before: string, after: string, pairs: readonly Pair[]) {
  const deleted = runsOf(pairs).reduce(
    (text, run) => text.slice(0, run.at) + text.slice(run.at + run.length),
    before,
  );
  if (plainText(deleted) !== plainText(after)) return false;
  const original = splitBlocks(before);
  const rewritten = splitBlocks(after);
  if (original.length !== rewritten.length) return false;
  return original.every((block, i) => block.type === rewritten[i]?.type);
}

/**
 * Rewrite emphasis CommonMark cannot read next to CJK — `_中文_` — into the
 * delimiter that works everywhere: `*中文*`.
 *
 * Parser-driven, not a scan over the source, and that is the whole safety
 * argument: an underscore that survives into an mdast `text` node is by
 * construction a delimiter the parser refused, and the text nodes are the only
 * place this may touch. Inline code, fenced code, math, raw HTML and link
 * destinations are not text nodes, so `https://example.com/a_b_c` and a shell
 * snippet are out of reach without any rule of their own. A span may *enclose*
 * one of those — `_[New York Times](url)_` is emphasis wrapping a link — so
 * the two delimiters need not share a text node, only be in one.
 *
 * Every rewrite is then checked against the original before it is returned, and
 * checked again one span at a time if the whole-body swap does not hold, so one
 * pathological span costs that span rather than the article.
 */
export function normalizeCjkEmphasis(markdown: string): string {
  const pairs = pairsIn(
    markdown,
    textOnly(
      markdown,
      textRanges(markdown),
      new Set(cellWallOffsets(markdown)),
    ),
  );
  if (pairs.length === 0) return markdown;

  const all = swapped(markdown, pairs);
  if (isSafe(markdown, all, pairs)) return all;

  let out = markdown;
  for (const pair of pairs) {
    const one = swapped(out, [pair]);
    if (isSafe(out, one, [pair])) out = one;
  }
  return out;
}
