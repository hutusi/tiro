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

/** How much of a long clip is read first, cut at a blank line, before the
 * whole of it: an ordinary article passes the threshold well inside it. */
const PREFIX_CHARS = 16_000;

/** A link reference or footnote definition, `[x]: …` or `[^x]: …`. */
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

let last: { markdown: string; enough: number; count: number } | null = null;

/**
 * How much readable text a clip holds, in characters, whitespace folded: its
 * `readableText`, which leaves out pictures, addresses and markup, and keeps
 * code and the text inside raw HTML.
 *
 * What the popup measures a page against `THIN_PAGE_CHARS` with, to offer
 * saving it as a site instead (ADR 0055). Not the Markdown's own length: a
 * tool's page can be a few labels and a dozen image links, and the links'
 * addresses are not something anyone reads.
 *
 * Parsing is not free — about 50 ms for a 50 KB clip, half a second for
 * 500 KB — and the popup asks on every render, so the answer for the last
 * clip is kept. When `enough` is given, a long clip's first `PREFIX_CHARS`,
 * cut at a blank line, are counted alone, and if they already reach it, that
 * count is the answer: some number at least `enough`, not the exact total.
 * A prefix cut there never reads more than the whole does — every construct
 * that spans a blank line reads the same either side of it — except a
 * reference whose definition lies past the cut, which reads as its own
 * brackets. So a clip with a definition after the cut is read whole.
 *
 * The parser's worst case is far slower than its usual pace: a single
 * paragraph of hundreds of kilobytes of unmatched brackets takes seconds,
 * even escaped. That is the parser the processor and the site already run on
 * every clip, so nothing a page can do here is new; it is paid once per clip,
 * and a parse that throws reads as the whole Markdown — Clip first, as it was
 * before there was a choice.
 */
export function readableChars(
  markdown: string,
  enough = Number.POSITIVE_INFINITY,
): number {
  if (last !== null && last.markdown === markdown && last.enough === enough) {
    return last.count;
  }
  const count = measure(markdown, enough);
  last = { markdown, enough, count };
  return count;
}

function measure(markdown: string, enough: number): number {
  try {
    if (markdown.length > PREFIX_CHARS && Number.isFinite(enough)) {
      const cut = markdown.lastIndexOf("\n\n", PREFIX_CHARS);
      if (cut > 0 && !DEFINITION.test(markdown.slice(cut))) {
        const count = readableText(markdown.slice(0, cut)).length;
        if (count >= enough) return count;
      }
    }
    return readableText(markdown).length;
  } catch {
    // A stack overflow on thousands of nested quotes, say. The render must
    // not fail over a hint.
    return markdown.length;
  }
}
