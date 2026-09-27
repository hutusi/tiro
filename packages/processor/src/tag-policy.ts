import { normalizeTags, TAG_LIMIT, tagKey } from "@tiro/shared";

/** Tags outside the vocabulary one article may add (ADR 0033). Three since
 * ADR 0035: two cut a niche article's defining topic, and a vault that values
 * specific tags can afford one more. */
export const MAX_NEW_TAGS = 3;
/** The fewest tags the cap on new ones may leave an article with. */
export const MIN_TAGS = 3;
/** A tag joins the vocabulary once this many articles carry it. */
export const VOCABULARY_MIN_ARTICLES = 2;
/** The most tags offered to the model, most used first. */
export const VOCABULARY_LIMIT = 150;

/** Kana and hangul: a tag in either is in neither of the vault's languages
 * (ADR 0035). Japanese kanji and traditional characters are Han, and pass —
 * only an alias can tell them from Simplified Chinese. */
const FOREIGN_SCRIPT =
  /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function inVaultScripts(tag: string): boolean {
  return !FOREIGN_SCRIPT.test(tag);
}

const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;

/**
 * Whether a tag, as respelled, is still in the form ADR 0033 wrote — Latin
 * letters, no Chinese, all lowercase — with nothing saying that is how the
 * vault spells it (ADR 0035). Every tag the vault held before Chinese-first
 * tags looks like this, so it is how the vocabulary tells an English tag the
 * vault chose (`Git`, `LLM`, `npm: npm` in the aliases) from one it has not
 * decided on yet, and keeps the second out: offered as "reuse exactly as
 * written", it would pull every new article back to English.
 */
export function undecided(
  tag: string,
  aliases: ReadonlyMap<string, string | null>,
): boolean {
  return (
    !HAN.test(tag) &&
    LATIN.test(tag) &&
    tag === tag.toLowerCase() &&
    aliases.get(tag) !== tag
  );
}

/**
 * Tags as the vault spells them: normalized, through the aliases, and each
 * vocabulary tag in the vocabulary's spelling, by key. The one respelling
 * every writer uses — a run, a retag, an excerpt run keeping old tags — so
 * none of them writes `git` where the vault has `Git`. Not cut to a limit.
 */
export function respell(
  tags: readonly string[],
  aliases: ReadonlyMap<string, string | null>,
  vocabulary: Iterable<string> = [],
): string[] {
  const spelling = new Map<string, string>();
  for (const tag of vocabulary) spelling.set(tagKey(tag), tag);
  return normalizeTags(tags, aliases, Number.POSITIVE_INFINITY).map(
    (tag) => spelling.get(tag.toLowerCase()) ?? tag,
  );
}

export interface TagLimits {
  /** Tags from outside the vocabulary that may be added. `MAX_NEW_TAGS`
   * unless the caller is translating tags rather than coining them. */
  maxNew?: number;
  /** The article's tags before this: a topic it already carries is not new,
   * so reprocessing an article never prunes it. */
  current?: readonly string[];
}

/**
 * The tags the processor writes for what the model offered (ADR 0033, ADR
 * 0035): respelled as the vault spells them, none in kana or hangul, at most
 * `TAG_LIMIT` of them — and, once the vault has a vocabulary, no more than
 * `maxNew` it does not already hold.
 *
 * Policy, not form, and applied to model output only — tags already in an
 * article, kept because a run had nothing better, are only respelled. A
 * dropped tag is logged, so a model that ignores the instruction shows in the
 * run log rather than as an article with too few tags.
 */
export function writableTags(
  offered: readonly string[],
  aliases: ReadonlyMap<string, string | null>,
  log: (message: string) => void = () => {},
  vocabulary: Iterable<string> = [],
  { maxNew = MAX_NEW_TAGS, current = [] }: TagLimits = {},
): string[] {
  const listed = [...vocabulary];
  // Filtered before the cap, so a reply that leads with tags this drops still
  // gets its full allowance from the rest.
  const all = respell(offered, aliases, listed);
  const dropped = all.filter((tag) => !inVaultScripts(tag));
  if (dropped.length > 0) {
    log(`dropped tag(s) in neither Chinese nor English: ${dropped.join(", ")}`);
  }
  const usable = all.filter(inVaultScripts);
  // A vault with no vocabulary yet has nothing to reuse; every tag is new.
  if (listed.length === 0) return usable.slice(0, TAG_LIMIT);

  const known = new Set(
    [...listed, ...respell(current, aliases)].map((tag) => tag.toLowerCase()),
  );
  // At most `maxNew` coined per article, so the vocabulary grows by what
  // recurs rather than by every model's passing phrasing — but never at the
  // cost of an article left with fewer than MIN_TAGS.
  const kept: string[] = [];
  const spare: string[] = [];
  let coined = 0;
  for (const tag of usable) {
    if (kept.length === TAG_LIMIT) break;
    if (known.has(tag.toLowerCase())) {
      kept.push(tag);
    } else if (coined < maxNew) {
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
    log(`left out new tag(s) past the ${maxNew} allowed: ${spare.join(", ")}`);
  }
  return kept;
}

/**
 * The vault's vocabulary: every tag at least `VOCABULARY_MIN_ARTICLES`
 * articles carry, in canonical form and through the aliases, most used first
 * and cut to `VOCABULARY_LIMIT` — leaving out a tag in kana or hangul, and one
 * still `undecided`, which would offer the model the English the vault is
 * moving away from (ADR 0035).
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
      if (!inVaultScripts(tag) || undecided(tag, aliases)) continue;
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

/**
 * The `undecided` tags the vault's articles carry, with how many carry each,
 * most first: the list an alias table is drafted from, and — once two
 * articles share one — what `retag` refuses to start over (ADR 0035).
 */
export function undecidedTags(
  tagLists: Iterable<readonly string[]>,
  aliases: ReadonlyMap<string, string | null>,
): { tag: string; articles: number }[] {
  const counts = new Map<string, number>();
  for (const list of tagLists) {
    for (const tag of respell(list, aliases)) {
      if (undecided(tag, aliases)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort(([a, ca], [b, cb]) => cb - ca || codePointOrder(a, b))
    .map(([tag, articles]) => ({ tag, articles }));
}
