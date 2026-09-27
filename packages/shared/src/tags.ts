/**
 * The one form a tag is written in (ADR 0033, ADR 0035).
 *
 * Tags are the model's, so they arrive in whatever spelling it picked that
 * day: `Open-Source`, `open source`, `open_source`, `AI 安全`. The site already
 * merges some of those onto one page (`tagSlug`), but it shows each article's
 * own spelling on its chips. This is where every spelling of a tag becomes one
 * before it is written, so the vault holds a vocabulary instead of a pile of
 * variants.
 *
 * Two things, kept apart. A tag's *form* (`normalizeTag`) is how it is
 * written, case included — `AI安全`, `Git`, `强化学习`. Its *key* (`tagKey`) is
 * the form without case, and is what every comparison uses: two spellings
 * that differ only in case are one tag, which the vault spells one way.
 *
 * Form only. Which tags are *allowed* — which language, how many new ones a
 * run may coin — is the processor's policy, applied to what the model writes;
 * a tag a person wrote, or one already in the vault, is only ever normalized
 * here.
 */

/** At most this many tags per article: the prompt asks for 3 to 6. */
export const TAG_LIMIT = 6;

/** Characters trimmed off the ends of a tag: whitespace, the `#` a model
 * sometimes prefixes, and quotes, Chinese ones included. Sentence punctuation
 * goes from the end only, since a leading dot can be the tag (`.name tld`).
 * NFKC already folds the full-width `，；：！？` to these; `。` and `、` it
 * leaves alone, so they are named. */
const LEADING = /^[\s#"'“”‘’`「『]+/u;
const TRAILING = /[\s"'“”‘’`」』.,;:!?。、]+$/u;

/** Whitespace, underscores or hyphens beside a Chinese character. Chinese is
 * not written with spaces between words, and a Chinese word beside a Latin
 * one takes none either in a tag: `AI 安全`, `AI-安全` and `AI安全` are one
 * tag, and two pages if this were left to chance. Han only — Korean does put
 * spaces between words. */
const HAN_GAP = /(?<=\p{Script=Han})[\s_-]+|[\s_-]+(?=\p{Script=Han})/gu;

/**
 * A tag in canonical form: NFKC, words of Latin script separated by single
 * spaces, none beside a Chinese character. Case is kept — `AI安全`, `Git` —
 * and compared away by `tagKey`.
 *
 * A hyphen between Latin words becomes a space — `open-source` and
 * `open source` are one tag — except where it sits beside a digit, which is
 * where it is part of a name (`GPT-4`, `utf-8`, `l2-cache`) rather than a join
 * between words. Gaps beside a Chinese character go first, so `GPT-4 发布` and
 * `GPT-4-发布` both become `GPT-4发布`. Other inner punctuation is kept: `C++`,
 * `C#`, `node.js`, `CI/CD` and `async/await` mean something by it. The result
 * can be empty, which callers drop.
 *
 * Idempotent: normalizing a normalized tag changes nothing.
 */
export function normalizeTag(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(HAN_GAP, "")
    .replace(/[\s_]+/gu, " ")
    .replace(/(?<!\d)-+(?!\d)/gu, " ")
    .replace(LEADING, "")
    .replace(TRAILING, "")
    .replace(/ {2,}/g, " ");
}

/**
 * The identity of a tag: its canonical form without case. `AI安全` and
 * `ai安全` are one tag, and so are `Git` and `git`; every comparison — an
 * alias, a duplicate, the vocabulary — is made on this, while what is written
 * is the vault's own spelling.
 */
export function tagKey(raw: string): string {
  return normalizeTag(raw).toLowerCase();
}

/**
 * A vault's alias table as a map from a tag's key to the spelling it is
 * written in, `null` dropping it. Keyed by `tagKey`, so an entry matches
 * however it — or the tag it names — was spelled.
 *
 * Every target is also its own entry, unless the table gives its key one: an
 * alias is the vault deciding how a tag is spelled, and `large language
 * models: LLM` means the forty articles already tagged `llm` are spelled
 * `LLM` too, rather than outvoting the table. One hop, which a table that
 * passes `aliasProblems` makes enough: a target's key maps to that target.
 */
export function tagAliases(
  aliases: Readonly<Record<string, string | null>> = {},
): ReadonlyMap<string, string | null> {
  const map = new Map<string, string | null>();
  for (const [from, to] of Object.entries(aliases)) {
    const key = tagKey(from);
    if (key === "") continue;
    map.set(key, to === null ? null : normalizeTag(to));
  }
  for (const to of [...map.values()]) {
    if (to === null || to === "") continue;
    const key = to.toLowerCase();
    if (!map.has(key)) map.set(key, to);
  }
  return map;
}

/**
 * Why an alias table would not settle: respelling a tag it produced must
 * change nothing, or every run rewrites the same articles — a chain `a: B`,
 * `b: C` moves `a` one step per run, and `a: b`, `b: a` flips forever. Named
 * per entry, empty when the table is sound. A respelling (`ai: AI`) is fine.
 */
export function aliasProblems(
  aliases: Readonly<Record<string, string | null>>,
): string[] {
  const problems: string[] = [];
  const entries = new Map<string, { from: string; to: string | null }>();
  for (const [from, to] of Object.entries(aliases)) {
    const key = tagKey(from);
    const earlier = entries.get(key);
    if (earlier !== undefined) {
      problems.push(
        `aliases ${JSON.stringify(earlier.from)} and ${JSON.stringify(from)} name the same tag`,
      );
      continue;
    }
    entries.set(key, { from, to: to === null ? null : normalizeTag(to) });
  }
  const spellings = new Map<string, { from: string; to: string }>();
  for (const { from, to } of entries.values()) {
    if (to === null || to === "") continue;
    const onward = entries.get(to.toLowerCase());
    if (onward !== undefined && onward.to !== to) {
      problems.push(
        `alias ${JSON.stringify(from)} → ${JSON.stringify(to)}, but ${JSON.stringify(onward.from)} → ${JSON.stringify(onward.to)}: a tag it writes would be rewritten again`,
      );
    }
    const same = spellings.get(to.toLowerCase());
    if (same !== undefined && same.to !== to) {
      problems.push(
        `aliases ${JSON.stringify(same.from)} and ${JSON.stringify(from)} spell one tag two ways: ${JSON.stringify(same.to)} and ${JSON.stringify(to)}`,
      );
    }
    if (same === undefined) spellings.set(to.toLowerCase(), { from, to });
  }
  return problems;
}

/**
 * An article's tags in canonical form: each normalized and put through the
 * aliases, empties and duplicates — by key — dropped, the first spelling and
 * its position kept, and cut to `limit` — `TAG_LIMIT` unless a caller filters
 * further first.
 */
export function normalizeTags(
  tags: readonly string[],
  aliases: ReadonlyMap<string, string | null> = new Map(),
  limit: number = TAG_LIMIT,
): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  for (const raw of tags) {
    if (out.length >= limit) break;
    const normal = normalizeTag(raw);
    const key = normal.toLowerCase();
    const tag = aliases.has(key) ? aliases.get(key) : normal;
    if (tag === null || tag === undefined || tag === "") continue;
    if (keys.has(tag.toLowerCase())) continue;
    keys.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/**
 * What is wrong with an article's tags as written, by form alone: a tag not
 * in canonical form, one listed twice — however it was spelled, case included
 * — or more than `TAG_LIMIT`. Empty when they are fine. Language and case are
 * policy, not form, and are not checked here: an article may carry a tag a
 * person gave it.
 */
export function tagFormProblems(tags: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const canonical = normalizeTag(tag);
    // Checked on its own, before the comparison below: `""` normalizes to
    // itself, so as "is it canonical?" it passes — and the site would still
    // give it a page and a blank chip.
    if (canonical === "") {
      problems.push(
        tag === ""
          ? 'tag "" is empty'
          : `tag ${JSON.stringify(tag)} is empty once normalized`,
      );
      continue;
    }
    if (canonical !== tag) {
      problems.push(
        `tag ${JSON.stringify(tag)} is not in canonical form (${JSON.stringify(canonical)})`,
      );
    }
    const key = canonical.toLowerCase();
    if (seen.has(key)) {
      problems.push(`tag ${JSON.stringify(tag)} is listed more than once`);
    }
    seen.add(key);
  }
  if (tags.length > TAG_LIMIT) {
    problems.push(`${tags.length} tags, at most ${TAG_LIMIT}`);
  }
  return problems;
}
