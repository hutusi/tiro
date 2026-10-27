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

/** A link's or picture's destination group, `(…)`. The clipper escapes `(`
 * and `)` in an address (`inlineLinkRule`), and Markdown allows them balanced,
 * so a group runs past both — stopping at the first `)` left the rest of a
 * Wikipedia-style `…_(disambiguation)/…` address counted as text. */
const DESTINATION = String.raw`\((?:\\.|[^()\\]|\([^()]*\))*\)`;
/** A picture, alt text and all. Turndown escapes `[` and `]` in an alt, so
 * escapes are part of it and an unescaped `[` is not: stopping there keeps a
 * failed match from running on past the next `![`, which made a run of
 * unclosed ones quadratic (50,000 took 3 s). */
const PICTURE = new RegExp(
  String.raw`!\[(?:\\.|[^[\]\\])*\]${DESTINATION}`,
  "g",
);
const LINK_TARGET = new RegExp(String.raw`\]${DESTINATION}`, "g");

/**
 * How much readable text a clip holds, in characters: the Markdown with its
 * pictures, link targets, HTML tags and markup taken out, whitespace folded.
 *
 * What the popup measures a page against `THIN_PAGE_CHARS` with, to offer
 * saving it as a site instead (ADR 0055). Not the Markdown's own length: a
 * tool's page can be a few labels and a dozen image links, and the links'
 * addresses are not something anyone reads.
 */
export function readableChars(markdown: string): number {
  return markdown
    .replace(PICTURE, " ")
    .replace(LINK_TARGET, "]")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`~|[\]-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}
