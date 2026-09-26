/**
 * The one form a tag is written in (ADR 0033).
 *
 * Tags are the model's, so they arrive in whatever spelling it picked that
 * day: `Open-Source`, `open source`, `open_source`. The site already merges
 * some of those onto one page (`tagSlug`), but not underscores, and it shows
 * each article's own spelling on its chips. This is where every spelling of
 * a tag becomes one before it is written, so the vault holds a vocabulary
 * instead of a pile of variants.
 *
 * Form only. Which tags are *allowed* — English, how many new ones a run may
 * coin — is the processor's policy, applied to what the model writes; a tag
 * a person wrote, or one already in the vault, is only ever normalized here.
 */

/** At most this many tags per article: the prompt asks for 3 to 6. */
export const TAG_LIMIT = 6;

/** Characters trimmed off the ends of a tag: whitespace, the `#` a model
 * sometimes prefixes, and quotes. Sentence punctuation goes from the end only,
 * since a leading dot can be the tag (`.name tld`). */
const LEADING = /^[\s#"'“”‘’`]+/u;
const TRAILING = /[\s"'“”‘’`.,;:!?]+$/u;

/**
 * A tag in canonical form: NFKC, lowercase, words separated by single spaces.
 *
 * A hyphen becomes a space — `open-source` and `open source` are one tag —
 * except where it sits beside a digit, which is where it is part of a name
 * (`gpt-4`, `utf-8`, `l2-cache`) rather than a join between words. Other inner
 * punctuation is kept: `c++`, `c#`, `node.js`, `ci/cd` and `async/await` mean
 * something by it. The result can be empty, which callers drop.
 *
 * Idempotent: normalizing a normalized tag changes nothing.
 */
export function normalizeTag(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_]+/gu, " ")
    .replace(/(?<!\d)-+(?!\d)/gu, " ")
    .replace(LEADING, "")
    .replace(TRAILING, "")
    .replace(/ {2,}/g, " ");
}

/** A tag's alias map with both sides normalized, so a `tiro.yml` entry
 * matches however it — or the tag it names — was spelled. `null` drops the
 * tag. One hop: an alias's target is not looked up again. */
export function tagAliases(
  aliases: Readonly<Record<string, string | null>> = {},
): ReadonlyMap<string, string | null> {
  const map = new Map<string, string | null>();
  for (const [from, to] of Object.entries(aliases)) {
    const key = normalizeTag(from);
    if (key === "") continue;
    map.set(key, to === null ? null : normalizeTag(to));
  }
  return map;
}

/**
 * An article's tags in canonical form: each normalized and put through the
 * aliases, empties and duplicates dropped, first spelling's position kept,
 * and cut to `limit` — `TAG_LIMIT` unless a caller filters further first.
 */
export function normalizeTags(
  tags: readonly string[],
  aliases: ReadonlyMap<string, string | null> = new Map(),
  limit: number = TAG_LIMIT,
): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    if (out.length >= limit) break;
    const normal = normalizeTag(raw);
    const tag = aliases.has(normal) ? aliases.get(normal) : normal;
    if (tag === null || tag === undefined || tag === "") continue;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}
