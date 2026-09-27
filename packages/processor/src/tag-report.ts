import {
  needsProcessing,
  normalizeTag,
  normalizeTags,
  parseArticle,
  TAG_LIMIT,
} from "@tiro/shared";
import {
  buildVocabulary,
  MIN_TAGS,
  spellingOf,
  undecided,
} from "./tag-policy.ts";

export interface TaggedArticle {
  slug: string;
  tags: readonly string[];
  /** A pending article has no tags yet, which is not the same as too few. */
  processed: boolean;
}

export interface TagCount {
  tag: string;
  articles: number;
}

/** What the vault's tags look like — the numbers ADR 0033 was measured by, and
 * what ADR 0035's alias table is drafted from. */
export interface TagReport {
  articles: number;
  /** Distinct tags in canonical form, and how many of them only one article
   * carries: the share of tag pages that list nothing but the reader's own
   * article. */
  distinct: number;
  singletons: number;
  /** What the next run would offer the model (`buildVocabulary`). */
  vocabulary: number;
  top: TagCount[];
  /** Spellings as written that are not their canonical form, including
   * tags that are empty once normalized (`canonical` is then ""). */
  nonCanonical: { tag: string; canonical: string }[];
  /** Tags still in ADR 0033's form — lowercase English no alias spells —
   * most carried first: what the alias table is drafted from, and those two
   * articles share are what `retag` refuses to start over (ADR 0035). */
  undecided: TagCount[];
  /** Tags the vault spells more than one way, differing only in case: one
   * tag and one page, whose chips read differently until an alias or a
   * retag settles the spelling. The most used spelling first. */
  variants: string[][];
  /** Canonical tags whose plural is also a tag: `agent` beside `agents`. */
  plurals: [string, string][];
  /** Processed articles outside the 3 to 6 the prompt asks for. */
  fewTags: string[];
  manyTags: string[];
}

function byCount(a: TagCount, b: TagCount): number {
  return (
    b.articles - a.articles || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)
  );
}

/**
 * Measure the vault's tags without changing anything. Counts are per article
 * by key, so a tag an article spells two ways — case included — counts once,
 * under the spelling most of the vault uses, and aliases are applied as a run
 * would apply them.
 */
export function tagReport(
  articles: readonly TaggedArticle[],
  aliases: ReadonlyMap<string, string | null>,
): TagReport {
  const counts = new Map<string, number>();
  const spellings = new Map<string, Map<string, number>>();
  const nonCanonical = new Map<string, string>();
  const fewTags: string[] = [];
  const manyTags: string[] = [];
  for (const article of articles) {
    for (const raw of article.tags) {
      const canonical = normalizeTag(raw);
      // An empty result is listed too — it is a tag to remove — and checked on
      // its own, because "" normalizes to itself and would pass the second
      // test. normalizeTags below drops empties, so this is the only place
      // the report can see one.
      if (canonical === "" || canonical !== raw) {
        nonCanonical.set(raw, canonical);
      }
    }
    const tags = normalizeTags(article.tags, aliases, Number.POSITIVE_INFINITY);
    for (const tag of tags) {
      const key = tag.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const written = spellings.get(key) ?? new Map<string, number>();
      written.set(tag, (written.get(tag) ?? 0) + 1);
      spellings.set(key, written);
    }
    if (article.processed && tags.length < MIN_TAGS) fewTags.push(article.slug);
    if (tags.length > TAG_LIMIT) manyTags.push(article.slug);
  }
  const spelled = (key: string) =>
    spellingOf(spellings.get(key) ?? new Map([[key, 1]]));
  const all = [...counts]
    .map(([key, n]) => ({ tag: spelled(key), articles: n }))
    .sort(byCount);
  const plurals: [string, string][] = [];
  for (const key of counts.keys()) {
    if (counts.has(`${key}s`)) plurals.push([spelled(key), spelled(`${key}s`)]);
  }
  plurals.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    articles: articles.length,
    distinct: all.length,
    singletons: all.filter((t) => t.articles === 1).length,
    vocabulary: buildVocabulary(
      articles.map((a) => a.tags),
      aliases,
    ).length,
    top: all.slice(0, 20),
    nonCanonical: [...nonCanonical]
      .map(([tag, canonical]) => ({ tag, canonical }))
      .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)),
    undecided: [...counts]
      .flatMap(([key, n]) =>
        [...(spellings.get(key)?.keys() ?? [])]
          .filter((tag) => undecided(tag, aliases))
          .map((tag) => ({ tag, articles: n })),
      )
      .sort(byCount),
    variants: [...spellings.values()]
      .filter((written) => written.size > 1)
      .map((written) =>
        [...written]
          .sort(([a, na], [b, nb]) => nb - na || (a < b ? -1 : a > b ? 1 : 0))
          .map(([tag]) => tag),
      )
      .sort(([a = ""], [b = ""]) => (a < b ? -1 : a > b ? 1 : 0)),
    plurals,
    fewTags,
    manyTags,
  };
}

/** Every readable article's slug and tags, and how many could not be read. */
export async function readTaggedArticles(
  vaultDir: string,
): Promise<{ articles: TaggedArticle[]; unreadable: number }> {
  const articlesDir = `${vaultDir}/articles`;
  const relPaths = Array.from(
    new Bun.Glob("*/index.md").scanSync({ cwd: articlesDir }),
  ).sort();
  const articles: TaggedArticle[] = [];
  let unreadable = 0;
  for (const relPath of relPaths) {
    const [slug] = relPath.split("/");
    if (slug === undefined) continue;
    try {
      const { frontmatter } = parseArticle(
        await Bun.file(`${articlesDir}/${relPath}`).text(),
      );
      articles.push({
        slug,
        tags: frontmatter.tags ?? [],
        processed: !needsProcessing(frontmatter),
      });
    } catch {
      unreadable += 1;
    }
  }
  return { articles, unreadable };
}
