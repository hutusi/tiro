import { normalizeTags, TAG_LIMIT, tagKey } from "@tiro/shared";

/** Tags outside the vocabulary one article may add (ADR 0033). */
export const MAX_NEW_TAGS = 2;
/** The fewest tags the cap on new ones may leave an article with. */
export const MIN_TAGS = 3;
/** A tag joins the vocabulary once this many articles carry it. */
export const VOCABULARY_MIN_ARTICLES = 2;
/** The most tags offered to the model, most used first. */
export const VOCABULARY_LIMIT = 150;

/** Scripts that mark a tag as not English. Latin with accents is English
 * enough for a tag (`café`, `gödel`); these are what the vault held
 * alongside an English twin (`ai安全` beside `ai safety`). */
const NON_ENGLISH =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function isEnglishTag(tag: string): boolean {
  return !NON_ENGLISH.test(tag);
}

/**
 * The tags the processor writes for what the model offered (ADR 0033): in
 * canonical form, put through the vault's aliases, English only, and at most
 * `TAG_LIMIT` of them — and, once the vault has a vocabulary, no more than
 * `MAX_NEW_TAGS` from outside it.
 *
 * Policy, not form, and applied to model output only — tags already in an
 * article, kept because a run had nothing better, are only normalized. English
 * because the owner chose one language for the vocabulary: a Chinese article's
 * topics are the same topics, and a second spelling of each in another script
 * is exactly the split this exists to stop. A dropped tag is logged, so a model
 * that ignores the instruction shows in the run log rather than as an article
 * with too few tags.
 */
export function writableTags(
  offered: readonly string[],
  aliases: ReadonlyMap<string, string | null>,
  log: (message: string) => void = () => {},
  vocabulary: Iterable<string> = [],
): string[] {
  // By key, so the model's `Git` is the vocabulary's tag and written the way
  // the vault spells it (ADR 0035).
  const spelling = new Map<string, string>();
  for (const tag of vocabulary) spelling.set(tagKey(tag), tag);
  // Filtered before the cap, so a reply that leads with tags this drops still
  // gets its full allowance from the rest.
  const all = normalizeTags(offered, aliases, Number.POSITIVE_INFINITY).map(
    (tag) => spelling.get(tag.toLowerCase()) ?? tag,
  );
  const dropped = all.filter((tag) => !isEnglishTag(tag));
  if (dropped.length > 0) {
    log(`dropped non-English tag(s): ${dropped.join(", ")}`);
  }
  const english = all.filter(isEnglishTag);
  // A vault with no vocabulary yet has nothing to reuse; every tag is new.
  if (spelling.size === 0) return english.slice(0, TAG_LIMIT);

  // At most MAX_NEW_TAGS coined per article, so the vocabulary grows by
  // what recurs rather than by every model's passing phrasing — but never at
  // the cost of an article left with fewer than MIN_TAGS.
  const kept: string[] = [];
  const spare: string[] = [];
  let coined = 0;
  for (const tag of english) {
    if (kept.length === TAG_LIMIT) break;
    if (spelling.has(tag.toLowerCase())) {
      kept.push(tag);
    } else if (coined < MAX_NEW_TAGS) {
      kept.push(tag);
      coined += 1;
    } else {
      spare.push(tag);
    }
  }
  while (kept.length < MIN_TAGS && spare.length > 0) {
    kept.push(spare.shift() as string);
  }
  if (spare.length > 0) {
    log(
      `left out new tag(s) past the ${MAX_NEW_TAGS} allowed: ${spare.join(", ")}`,
    );
  }
  return kept;
}

/**
 * The vault's vocabulary: every tag at least `VOCABULARY_MIN_ARTICLES`
 * articles carry, in canonical form and through the aliases, English only,
 * most used first and cut to `VOCABULARY_LIMIT`.
 *
 * Built from the vault itself rather than kept in a file, so it needs no
 * upkeep and follows what the vault is actually about. Only tags that recur
 * count: a tag on one article names nothing another has in common with it,
 * and offering the model the long tail would teach it the tail. An article is
 * counted once per tag, however it spelled it — case included — and each tag
 * is offered in the spelling most of the vault uses (`spellingOf`), which an
 * alias settles outright.
 */
export function buildVocabulary(
  tagLists: Iterable<readonly string[]>,
  aliases: ReadonlyMap<string, string | null>,
): string[] {
  const counts = new Map<string, number>();
  const spellings = new Map<string, Map<string, number>>();
  for (const list of tagLists) {
    for (const tag of normalizeTags(list, aliases, Number.POSITIVE_INFINITY)) {
      if (!isEnglishTag(tag)) continue;
      const key = tag.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const written = spellings.get(key) ?? new Map<string, number>();
      written.set(tag, (written.get(tag) ?? 0) + 1);
      spellings.set(key, written);
    }
  }
  return [...counts]
    .filter(([, count]) => count >= VOCABULARY_MIN_ARTICLES)
    .sort(([a, ca], [b, cb]) => cb - ca || codePointOrder(a, b))
    .slice(0, VOCABULARY_LIMIT)
    .map(([key]) => spellingOf(spellings.get(key) ?? new Map([[key, 1]])));
}

/** The spelling most articles use, ties to the first in code-point order, so
 * the answer never depends on the order the vault was read in. */
export function spellingOf(written: ReadonlyMap<string, number>): string {
  let best = "";
  let most = 0;
  for (const [tag, n] of written) {
    if (n > most || (n === most && codePointOrder(tag, best) < 0)) {
      best = tag;
      most = n;
    }
  }
  return best;
}

function codePointOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
