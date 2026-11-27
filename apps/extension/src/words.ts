import { readableText } from "@tiro/shared";

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

/** How much of a clip is read: its opening, cut at the last line break in
 * its second half, else the last space there, else the limit itself. A line
 * break splits nothing on a page of short lines, a gallery's say. But a
 * paragraph is one line and Chinese has no spaces, so the last break can lie
 * right after a heading: cutting there read a 17 KB transcript as its
 * 10-character title. */
const OPENING_CHARS = 16_000;

let last: { markdown: string; count: number } | null = null;

/**
 * How much readable text a clip's opening holds, in characters, whitespace
 * folded: the `readableText` of its first `OPENING_CHARS`, which leaves out
 * pictures, addresses and markup, and keeps code and the text inside raw HTML.
 *
 * What the popup measures a page against `THIN_PAGE_CHARS` with, to offer
 * saving it as a site instead (ADR 0055). Not the Markdown's own length: a
 * tool's page can be a few labels and a dozen image links, and the links'
 * addresses are not something anyone reads.
 *
 * **Only the opening, by design.** The answer picks which of two buttons
 * leads, both always shown, and the popup asks before it can paint them. The
 * parser is not linear — a 155 KB table takes 1.3 s, where 16 KB of an
 * ordinary page, a table included, takes about 50 ms — so the whole clip is
 * never read. An article passes the threshold long before 16 KB; a page
 * whose opening is all pictures has the text after them judged missing, a
 * reference whose definition lies past the cut reads as its own brackets, and
 * a construct the cut splits reads as text. Each costs one click on the other
 * button, which is the price of a popup that never waits on a long page.
 *
 * The popup asks on every render, so the answer for the last clip is kept.
 */
export function readableChars(markdown: string): number {
  if (last !== null && last.markdown === markdown) return last.count;
  const count = measure(markdown);
  last = { markdown, count };
  return count;
}

function measure(markdown: string): number {
  if (markdown.length <= OPENING_CHARS) return readableText(markdown).length;
  const half = OPENING_CHARS / 2;
  const line = markdown.lastIndexOf("\n", OPENING_CHARS);
  const space = markdown.lastIndexOf(" ", OPENING_CHARS);
  const cut = line > half ? line : space > half ? space : OPENING_CHARS;
  return readableText(markdown.slice(0, cut)).length;
}
