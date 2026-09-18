import { plainText, splitBlocks, textRanges } from "./blocks.ts";

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
 * absent — a delimiter beside `，` or `。` fails for the *other* CommonMark
 * reason (the run is not flanking), which no delimiter can express, and the
 * site handles it in the parser instead.
 */
const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;

/** One `_…_` pair, by source offset of each delimiter. */
interface Pair {
  open: number;
  close: number;
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
 * Whether this pair is one the author meant as emphasis.
 *
 * Two conditions, and both are load-bearing. The span may not begin or end
 * with whitespace, because no emphasis delimiter ever does. And the pair must
 * touch CJK — inside or immediately outside — because "would it parse as
 * emphasis after the swap?" is *not* a sufficient test on its own: `*` works
 * inside a word where `_` does not, so rewriting `snake_case_name` in prose
 * would turn an identifier into italics. Requiring CJK is what separates a
 * delimiter the parser refused from an underscore that was always just an
 * underscore.
 */
function isEmphasis(source: string, pair: Pair): boolean {
  const inner = source.slice(pair.open + 1, pair.close);
  if (inner.length === 0) return false;
  if (/^\s/.test(inner) || /\s$/.test(inner)) return false;
  return (
    CJK.test(inner) ||
    CJK.test(source[pair.open - 1] ?? "") ||
    CJK.test(source[pair.close + 1] ?? "")
  );
}

/** Every `_…_` pair inside one text node's source range. */
function pairsIn(source: string, start: number, end: number): Pair[] {
  const found: Pair[] = [];
  let open = start;
  while (open < end) {
    if (source[open] !== "_" || isEscaped(source, open)) {
      open += 1;
      continue;
    }
    let close = -1;
    for (let i = open + 1; i < end; i += 1) {
      // Emphasis may span lines, but a pair that does is far more likely to be
      // two unrelated underscores in a list or a table than one span, and the
      // swap would join them. One line, like the defect itself.
      if (source[i] === "\n") break;
      if (source[i] === "_" && !isEscaped(source, i)) {
        close = i;
        break;
      }
    }
    if (close === -1) return found;
    const pair = { open, close };
    if (isEmphasis(source, pair)) {
      found.push(pair);
      open = close + 1;
    } else {
      // Not from `close`: a rejected closer can still open the next pair, which
      // is exactly the shape of `a_b_中文_很重要_`.
      open += 1;
    }
  }
  return found;
}

/** Replace the character at each offset. Length-preserving, so a caller may
 * apply pairs one at a time without recomputing the offsets between them. */
function replaceAt(source: string, offsets: readonly number[], with_: string) {
  let out = source;
  for (const offset of offsets) {
    out = out.slice(0, offset) + with_ + out.slice(offset + 1);
  }
  return out;
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
  const offsets = pairs.flatMap((p) => [p.open, p.close]);
  // Descending, so each deletion leaves the offsets before it valid.
  const deleted = [...offsets]
    .sort((a, b) => b - a)
    .reduce((text, at) => text.slice(0, at) + text.slice(at + 1), before);
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
 * snippet are out of reach without any rule of their own.
 *
 * Every rewrite is then checked against the original before it is returned, and
 * checked again one pair at a time if the whole-body swap does not hold, so one
 * pathological span costs that span rather than the article.
 */
export function normalizeCjkEmphasis(markdown: string): string {
  const pairs = textRanges(markdown).flatMap((range) =>
    pairsIn(markdown, range.start, range.end),
  );
  if (pairs.length === 0) return markdown;

  const offsets = pairs.flatMap((p) => [p.open, p.close]);
  const all = replaceAt(markdown, offsets, "*");
  if (isSafe(markdown, all, pairs)) return all;

  let out = markdown;
  for (const pair of pairs) {
    const one = replaceAt(out, [pair.open, pair.close], "*");
    if (isSafe(out, one, [pair])) out = one;
  }
  return out;
}
