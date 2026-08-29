/** Word count for the popup's preview meta. A plain whitespace split
 * undercounts CJK prose — Chinese has no spaces, so a whole paragraph would
 * read as one word. Han and kana characters count one each (the usual
 * convention); the rest counts by whitespace-separated runs. Keyed off the
 * article's own text, never the UI locale — the clipped page's language is
 * independent of the popup's. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

export function countWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text
    .replace(CJK, " ")
    .split(/\s+/)
    // Tokens with no letter or digit are punctuation left standing alone
    // (，。after the replace, markdown's — or ## markers), not words.
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  return cjk + rest;
}
