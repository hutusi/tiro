/**
 * Reading time for the list meta and the reader's title block, derived at
 * build time — the contract carries no such field, and a number that can be
 * recomputed from the body has no business in the frontmatter.
 *
 * CJK text has no word boundaries, so it is counted per character at a
 * characters-per-minute rate; everything else is counted in words. Code and
 * markdown syntax are counted as read — a fenced block takes time too — and
 * the result is rounded to whole minutes with a floor of one.
 */
export const LATIN_WPM = 250;
export const CJK_CPM = 400;

// Hiragana, katakana, CJK unified (incl. ext A), CJK compatibility, hangul.
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/gu;
// A run of letters/digits, allowing the joiners a word carries inside it.
const WORD = /[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu;

export function readingMinutes(body: string): number {
  const cjk = body.match(CJK)?.length ?? 0;
  const words = body.replace(CJK, " ").match(WORD)?.length ?? 0;
  return Math.max(1, Math.round(words / LATIN_WPM + cjk / CJK_CPM));
}
