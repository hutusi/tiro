import {
  needsProcessing,
  normalizeTag,
  normalizeTags,
  parseArticle,
  TAG_LIMIT,
} from "@tiro/shared";
import { buildVocabulary, isEnglishTag, MIN_TAGS } from "./tag-policy.ts";

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

/** What the vault's tags look like — the numbers ADR 0033 was measured by. */
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
  /** Spellings as written that are not their canonical form. */
  nonCanonical: { tag: string; canonical: string }[];
  nonEnglish: TagCount[];
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
 * in canonical form, so a tag an article spells two ways counts once, and
 * aliases are applied as a run would apply them.
 */
export function tagReport(
  articles: readonly TaggedArticle[],
  aliases: ReadonlyMap<string, string | null>,
): TagReport {
  const counts = new Map<string, number>();
  const nonCanonical = new Map<string, string>();
  const fewTags: string[] = [];
  const manyTags: string[] = [];
  for (const article of articles) {
    for (const raw of article.tags) {
      const canonical = normalizeTag(raw);
      if (canonical !== "" && canonical !== raw)
        nonCanonical.set(raw, canonical);
    }
    const tags = normalizeTags(article.tags, aliases, Number.POSITIVE_INFINITY);
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    if (article.processed && tags.length < MIN_TAGS) fewTags.push(article.slug);
    if (tags.length > TAG_LIMIT) manyTags.push(article.slug);
  }
  const all = [...counts]
    .map(([tag, n]) => ({ tag, articles: n }))
    .sort(byCount);
  const plurals: [string, string][] = [];
  for (const { tag } of all) {
    if (counts.has(`${tag}s`)) plurals.push([tag, `${tag}s`]);
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
    nonEnglish: all.filter((t) => !isEnglishTag(t.tag)),
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
