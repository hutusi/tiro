import { normalizeTags, TAG_LIMIT } from "@tiro/shared";

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
 * `TAG_LIMIT` of them.
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
): string[] {
  // Filtered before the cap, so a reply that leads with tags this drops still
  // gets its full allowance from the rest.
  const all = normalizeTags(offered, aliases, Number.POSITIVE_INFINITY);
  const dropped = all.filter((tag) => !isEnglishTag(tag));
  if (dropped.length > 0) {
    log(`dropped non-English tag(s): ${dropped.join(", ")}`);
  }
  return all.filter(isEnglishTag).slice(0, TAG_LIMIT);
}
