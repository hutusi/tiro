import { markdownLinks } from "@tiro/shared";
import type { TranslationCache } from "./cache.ts";

/**
 * What a translated block is checkpointed under: its text, with every place a
 * link or a picture points replaced by a token (ADR 0054).
 *
 * The checkpoint used to be keyed on the block's text exactly, so anything
 * that moved an address cost the block its translation. The image stage moves
 * addresses on every run that downloads a picture — a hotlink becomes
 * `./assets/<hash>` before translation reads the body — and a caption whose
 * picture finally downloaded was sent to the model again for not one changed
 * word: 38 captions in one run of the lead repair.
 *
 * Only where a link points is set aside, never the markup around it. A link
 * gained or lost, emphasis, a code span: those are part of what the
 * translation says, and a block that changed them is translated again.
 *
 * Reuse fills the tokens back in from the block as it stands now, so the
 * translation always points where the source does. A translation is stored
 * this way only when its addresses are exactly the source's, each once; one
 * the model altered, dropped or doubled, or a block naming one address twice,
 * is stored under its exact text as before, and reused only for that text.
 */

const TOKEN_DIGITS = 4;
const MAX_DESTINATIONS = 10 ** TOKEN_DIGITS;
/** Zero-padded for the reason `MATH_TOKEN` is: no token a prefix of another. */
const DESTINATION_TOKEN = (i: number) =>
  `TIRODEST${String(i).padStart(TOKEN_DIGITS, "0")}`;
const TOKEN_MARK = "TIRODEST";
const ANY_TOKEN = /TIRODEST\d{4}/g;

/** Opens a key whose addresses are tokens, so it is never a block's text. */
const SCHEME = "\u0000tiro:destinations\n";

/** An address in raw HTML: a picture's `src`, a link's `href`. */
const HTML_DESTINATION =
  /<(?:a|img|source)\b[^>]*?\s(?:href|src)\s*=\s*(["'])([^"']*)\1/gi;

interface Range {
  start: number;
  end: number;
}

export interface CheckpointKey {
  /** What the checkpoint is read and written by. The block's own text when
   * it points nowhere, which is what every such block was keyed by before. */
  key: string;
  /** The addresses `key` replaced, in order. */
  destinations: string[];
}

export function checkpointKey(text: string): CheckpointKey {
  // A block that already holds a token could not be told from its own key.
  if (text.includes(TOKEN_MARK)) return { key: text, destinations: [] };
  const ranges = destinationRanges(text);
  if (ranges.length === 0 || ranges.length > MAX_DESTINATIONS) {
    return { key: text, destinations: [] };
  }
  let key = SCHEME;
  let cursor = 0;
  const destinations: string[] = [];
  for (const range of ranges) {
    key +=
      text.slice(cursor, range.start) + DESTINATION_TOKEN(destinations.length);
    destinations.push(text.slice(range.start, range.end));
    cursor = range.end;
  }
  return { key: key + text.slice(cursor), destinations };
}

/** The checkpointed translation of `text`, and whether it was found under
 * the exact text, as every checkpoint written before this was. */
export function reuseTranslation(
  cache: TranslationCache,
  text: string,
): { translation: string; exact: boolean } | undefined {
  const keyed = checkpointKey(text);
  if (keyed.key !== text) {
    const filled = filledFrom(cache.get(keyed.key), keyed);
    if (filled !== null) return { translation: filled, exact: false };
  }
  const exact = cache.get(text);
  return exact === undefined ? undefined : { translation: exact, exact: true };
}

/** Checkpoint `translation` as the translation of `text`. */
export function recordTranslation(
  cache: TranslationCache,
  text: string,
  translation: string,
): void {
  const keyed = checkpointKey(text);
  const stored =
    keyed.key === text ? null : tokenized(translation, keyed.destinations);
  if (stored === null) cache.set(text, translation);
  else cache.set(keyed.key, stored);
}

/**
 * Store each entry kept under one of `texts` exactly under that block's new
 * key as well, when it fits one. `retain` later keeps whichever is live.
 *
 * Every checkpoint written before ADR 0054 is keyed by exact text, and the
 * image stage runs before translation: on the run that downloads a hotlinked
 * picture, the caption no longer has the text its entry is keyed by. So the
 * pipeline calls this with the body as it stood before that stage — the last
 * moment the entry can be found — and translation calls it for every block it
 * reuses by exact text.
 */
export function adoptExactEntries(
  cache: TranslationCache,
  texts: readonly string[],
): void {
  for (const text of texts) {
    const keyed = checkpointKey(text);
    if (keyed.key === text) continue;
    const exact = cache.get(text);
    if (exact === undefined) continue;
    const stored = tokenized(exact, keyed.destinations);
    if (stored !== null) cache.set(keyed.key, stored);
  }
}

/**
 * The keys that hold these blocks' translations, for `retain`: the key with
 * tokens when it holds one that fits, otherwise the exact text. A block moved
 * to its new key keeps only that one, so a checkpoint is rewritten once and
 * does not carry every block twice.
 */
export function liveKeys(
  cache: TranslationCache,
  texts: readonly string[],
): string[] {
  return texts.map((text) => {
    const keyed = checkpointKey(text);
    if (keyed.key === text) return text;
    return filledFrom(cache.get(keyed.key), keyed) === null ? text : keyed.key;
  });
}

/** `stored` with its tokens filled from `keyed`, or null when it does not fit:
 * every token once, and no others. */
function filledFrom(
  stored: string | undefined,
  keyed: CheckpointKey,
): string | null {
  if (stored === undefined) return null;
  if ((stored.match(ANY_TOKEN) ?? []).length !== keyed.destinations.length) {
    return null;
  }
  let out = stored;
  for (let i = 0; i < keyed.destinations.length; i++) {
    const token = DESTINATION_TOKEN(i);
    const first = out.indexOf(token);
    if (first === -1 || out.indexOf(token, first + token.length) !== -1) {
      return null;
    }
    // A callback, never the string: `$&` and its kin are replacement syntax.
    out = out.replace(token, () => keyed.destinations[i] ?? "");
  }
  return out;
}

/** `translation` with each address replaced by the token of the source
 * address it equals, or null unless the two name the same addresses, each
 * once. */
function tokenized(
  translation: string,
  destinations: readonly string[],
): string | null {
  if (translation.includes(TOKEN_MARK)) return null;
  const ranges = destinationRanges(translation);
  if (ranges.length !== destinations.length) return null;
  let out = "";
  let cursor = 0;
  const used = new Set<number>();
  for (const range of ranges) {
    const i = destinations.indexOf(translation.slice(range.start, range.end));
    // Unmatched, or a second link to one address: two links the translation
    // may have reordered could not be told apart once the source points them
    // in different places.
    if (i === -1 || used.has(i)) return null;
    used.add(i);
    out += translation.slice(cursor, range.start) + DESTINATION_TOKEN(i);
    cursor = range.end;
  }
  return out + translation.slice(cursor);
}

/**
 * Where each link and picture in `text` points: the destination of every
 * inline link and image, found by the parser (`markdownLinks`), and every
 * `src` and `href` in raw HTML — a table the clipper kept as HTML. Autolinks
 * and bare URLs are their own text, and stay in the key.
 */
function destinationRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const link of markdownLinks(text)) {
    if (link.type !== "link" && link.type !== "image") continue;
    if (link.tail === null) continue;
    const range = inlineDestination(text, link.tail);
    if (range !== null) ranges.push(range);
  }
  for (const match of text.matchAll(HTML_DESTINATION)) {
    const value = match[2] ?? "";
    if (value === "") continue;
    const end = (match.index ?? 0) + match[0].length - 1;
    ranges.push({ start: end - value.length, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges.filter(
    (range, i) => i === 0 || range.start >= (ranges[i - 1]?.end ?? 0),
  );
}

/**
 * The destination inside an inline link's `(…)`: after the opening
 * parenthesis and any space, either `<…>` whole or a run without spaces whose
 * own parentheses balance. A title after it stays in the key — it is words.
 */
function inlineDestination(text: string, tail: Range): Range | null {
  if (text[tail.start] !== "(") return null;
  const close = tail.end - 1;
  let i = tail.start + 1;
  while (i < close && /\s/.test(text[i] ?? "")) i++;
  if (text[i] === "<") {
    const end = text.indexOf(">", i);
    return end === -1 || end >= close ? null : { start: i, end: end + 1 };
  }
  const start = i;
  let depth = 0;
  while (i < close) {
    const c = text[i] ?? "";
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (/\s/.test(c)) break;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    }
    i++;
  }
  return i > start ? { start, end: Math.min(i, close) } : null;
}
