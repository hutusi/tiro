import { type ArticleFrontmatter, tagSlug } from "@tiro/shared";
import {
  buildShortLinks,
  reportShortLinks,
  type ShortLinks,
} from "./short-links.ts";
import { groupByTerm, type TermGroup } from "./terms.ts";
import { usableTranslation } from "./translation.ts";
import { readVault } from "./vault-read.ts";
import { isUnlisted } from "./visibility.ts";

export interface Article {
  /** The slug — the article's whole identity (flat layout, ADR 0007). */
  id: string;
  slug: string;
  frontmatter: ArticleFrontmatter;
  body: string;
  zhBody: string | null;
}

let cache: Article[] | null = null;
let listedCache: Article[] | null = null;
/** The vault read these caches were built from. `readVault` hands back the same
 * array while the vault is unchanged and a new one after an edit, so comparing
 * identity is the whole staleness check — in dev it is what makes an edit show
 * up, and in a build it is a pointer compare. */
let cacheSource: unknown = null;

/** Every article, unlisted ones included, newest first, validated through the
 * shared contract and joined with their translations. Throws (failing the
 * build) on any invalid frontmatter and on an empty production collection —
 * both are signs the vault checkout or glob base is wrong, never something to
 * ship silently.
 *
 * Only the reader route wants this one: it must still build a page for an
 * unlisted article, since being reachable at its URL is the whole point of the
 * flag. Everything that *lists* articles wants `getArticles()` below. */
export async function getAllArticles(): Promise<Article[]> {
  const entries = readVault();
  if (cache !== null && cacheSource === entries) return cache;
  cacheSource = entries;
  listedCache = null;

  const articles = entries.map((entry): Article => {
    // Flat layout, so a slug is one path segment. A nested directory would be
    // a layout migration that never happened (ADR 0007).
    if (entry.slug.includes("/")) {
      throw new Error(`unexpected article id: ${entry.slug}`);
    }
    return {
      id: entry.slug,
      slug: entry.slug,
      frontmatter: entry.frontmatter,
      body: entry.body,
      zhBody: usableTranslation(entry.frontmatter, entry.zhBody),
    };
  });

  if (articles.length === 0 && import.meta.env.PROD) {
    throw new Error(
      "the articles collection is empty — refusing to build an empty site",
    );
  }

  articles.sort((a, b) =>
    b.frontmatter.clipped_at.localeCompare(a.frontmatter.clipped_at),
  );
  cache = articles;
  return articles;
}

/** The articles every list, feed and index is built from — unlisted ones
 * removed.
 *
 * This is the single funnel: the library, the pager, the tag and category
 * pages, the search page's chip counts and the RSS feed all read it, so the
 * flag takes effect everywhere by removing it here rather than by teaching
 * seven call sites to check.
 *
 * Filters the cached array rather than rebuilding one — `articleMeta` keys its
 * memo on article identity (`article-meta.ts`), which holds only while the
 * list pages and the reader see the same objects.
 *
 * The empty-collection guard above stays on the *unfiltered* count, and this
 * one adds no guard of its own. It is tempting: a vault whose articles are all
 * unlisted builds a site with an empty library, which is almost certainly not
 * what anyone wanted. But refusing the build fails in the wrong direction —
 * the deploy workflow builds before it uploads, so a refusal leaves the
 * *previous* deployment live, the one where the article now being hidden is
 * still listed. A feature whose job is to stop publishing something must not
 * answer "I could not do that" by continuing to publish it. The empty library
 * is the truthful rendering of that vault; the owner can see it and unhide.
 *
 * `Library.astro`'s empty state carries the `data-pagefind-body` that keeps the
 * search index narrow in exactly this case — see the comment there. */
export async function getArticles(): Promise<Article[]> {
  listedCache ??= (await getAllArticles()).filter(
    (article) => !isUnlisted(article.frontmatter),
  );
  return listedCache;
}

export function articleUrl(article: Article): string {
  return `/articles/${article.slug}/`;
}

let shortLinkCache: ShortLinks | null = null;

/**
 * The site's short links, over every article — unlisted ones included. An
 * unlisted article is exactly the case a short link is for: its URL *is* the
 * sharing mechanism, so it is the one that most wants to be short.
 *
 * Lives here rather than beside `buildShortLinks` so that module stays a pure
 * function of a list of slugs, callable without the content layer — which is
 * what lets the `_redirects` generator reuse it after the build, off a plain
 * directory listing, instead of restating the rule.
 */
export async function shortLinks(): Promise<ShortLinks> {
  if (shortLinkCache === null) {
    shortLinkCache = buildShortLinks(
      (await getAllArticles()).map((article) => article.slug),
    );
    reportShortLinks(shortLinkCache);
  }
  return shortLinkCache;
}

export function tagUrl(tag: string): string {
  return `/tags/${tagSlug(tag)}/`;
}

export function categoryUrl(category: string): string {
  return `/categories/${tagSlug(category)}/`;
}

export interface ArticleGroup {
  slug: string;
  label: string;
  articles: Article[];
}

function toArticleGroups(groups: TermGroup<Article>[]): ArticleGroup[] {
  return groups.map(({ slug, label, items }) => ({
    slug,
    label,
    articles: items,
  }));
}

export async function tagIndex(): Promise<ArticleGroup[]> {
  return toArticleGroups(
    groupByTerm(await getArticles(), (a) => a.frontmatter.tags ?? []),
  );
}

let termPageCache: { tags: Set<string>; categories: Set<string> } | null = null;

/** The term slugs that actually have a page.
 *
 * Term routes are generated from the *listed* articles, so a tag or category
 * carried only by unlisted ones addresses no page at all — the reader linking
 * to it would 404. Every listed article's terms are in here by construction,
 * so this only ever says no about an unlisted article's.
 */
async function termPages(): Promise<{
  tags: Set<string>;
  categories: Set<string>;
}> {
  termPageCache ??= {
    tags: new Set((await tagIndex()).map((group) => group.slug)),
    categories: new Set((await categoryIndex()).map((group) => group.slug)),
  };
  return termPageCache;
}

/** `tagUrl(tag)` if that tag has a page, otherwise null. */
export async function tagPageUrl(tag: string): Promise<string | null> {
  return (await termPages()).tags.has(tagSlug(tag)) ? tagUrl(tag) : null;
}

/** `categoryUrl(category)` if that category has a page, otherwise null. */
export async function categoryPageUrl(
  category: string,
): Promise<string | null> {
  return (await termPages()).categories.has(tagSlug(category))
    ? categoryUrl(category)
    : null;
}

export async function categoryIndex(): Promise<ArticleGroup[]> {
  return toArticleGroups(
    groupByTerm(await getArticles(), (a) =>
      a.frontmatter.category === undefined ? [] : [a.frontmatter.category],
    ),
  );
}
