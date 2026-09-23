import { compareInstants, FAVORITES_ID } from "@tiro/shared";
import { type Article, getArticles } from "./articles.ts";
import { readCollections } from "./vault-read.ts";

export interface Collection {
  /** The filename stem, which is the collection's whole identity (ADR 0029). */
  id: string;
  title: string;
  description: string | null;
  /** The collection's own prose, markdown, possibly empty. */
  body: string;
  updatedAt: string | null;
  /**
   * The members this site lists, in file order.
   *
   * Joined through `getArticles()`, the listed funnel — so an unlisted member
   * is not here. That is ADR 0017 holding: enumeration is the thing the flag
   * removes, and a public collection page listing the article would put it
   * straight back. The membership itself is untouched; see `memberSlugs`.
   */
  articles: Article[];
  /**
   * Every member slug, listed or not, in file order.
   *
   * Membership is a fact about the collection; being listed is a fact about
   * the article. The clipper's tick must reflect the first, so it cannot read
   * `articles`. A slug with no article in the vault survives here too — the
   * site degrades to not showing a row, and `validate` is what refuses it.
   */
  memberSlugs: string[];
}

let cache: Collection[] | null = null;
/** The reads these were built from. Both `readCollections` and `getArticles`
 * hand back the same array while nothing changed, so comparing identity is the
 * whole staleness check — same trick, same reason, as `articles.ts`. */
let cacheCollectionSource: unknown = null;
let cacheArticleSource: unknown = null;
let membershipCache: Map<string, Collection[]> | null = null;

/**
 * Every collection, favorites first and then most-recently-updated first.
 *
 * Favorites leads because it is the one collection every vault has and the one
 * a reader expects at the top. The rest float by `updated_at` so the list the
 * owner is actively filling is the one they land on, with the id as a stable
 * tie-break — a collection that has never been touched still has to sort
 * somewhere deterministic, or two builds of the same vault differ.
 *
 * Empty collections are listed. One is what you get the moment you create a
 * collection, and hiding it would make a just-created list look like it failed
 * to save.
 */
export async function getCollections(): Promise<Collection[]> {
  const entries = readCollections();
  const articles = await getArticles();
  if (
    cache !== null &&
    cacheCollectionSource === entries &&
    cacheArticleSource === articles
  ) {
    return cache;
  }
  cacheCollectionSource = entries;
  cacheArticleSource = articles;
  membershipCache = null;

  const bySlug = new Map(articles.map((article) => [article.slug, article]));

  const collections = entries.map((entry): Collection => {
    const memberSlugs = entry.frontmatter.items.map((item) => item.slug);
    return {
      id: entry.id,
      title: entry.frontmatter.title,
      description: entry.frontmatter.description ?? null,
      body: entry.body,
      updatedAt: entry.frontmatter.updated_at ?? null,
      articles: memberSlugs
        .map((slug) => bySlug.get(slug))
        .filter((article): article is Article => article !== undefined),
      memberSlugs,
    };
  });

  collections.sort((a, b) => {
    if (a.id !== b.id) {
      if (a.id === FAVORITES_ID) return -1;
      if (b.id === FAVORITES_ID) return 1;
    }
    // By instant, not by text — an `updated_at` written with an offset would
    // otherwise sort by its digits (see `compareInstants`).
    const byUpdated = compareInstants(b.updatedAt, a.updatedAt);
    return byUpdated !== 0 ? byUpdated : a.id.localeCompare(b.id);
  });

  cache = collections;
  return collections;
}

export function collectionUrl(id: string): string {
  return `/collections/${id}/`;
}

/**
 * The collections an article belongs to, in the order `getCollections` puts
 * them — by membership, so an unlisted article still knows its own chips.
 */
export async function collectionsOf(slug: string): Promise<Collection[]> {
  // Asked first, and unconditionally: it is what drops the index below when
  // the vault has moved on. Checking the memo before reading would hand back
  // yesterday's membership for as long as the process lives.
  const collections = await getCollections();
  if (membershipCache === null) {
    const index = new Map<string, Collection[]>();
    for (const collection of collections) {
      for (const member of collection.memberSlugs) {
        const existing = index.get(member);
        if (existing === undefined) index.set(member, [collection]);
        else existing.push(collection);
      }
    }
    membershipCache = index;
  }
  return membershipCache.get(slug) ?? [];
}

/**
 * What the clipper reads off an article page: the `#tiro-page` JSON island
 * (ADR 0029), already serialized.
 *
 * It carries the whole catalog, not just this article's membership, so the
 * popup can draw its full tick-list from the DOM and make no network request
 * until the reader actually toggles something.
 *
 * Membership rather than listing, so an unlisted article still reports the
 * collections it is in — the tick has to say what is true of the vault, not
 * what this site chose to publish.
 *
 * `<` is escaped because a collection title containing `</script>` would
 * otherwise close the element and spill the rest of the payload into the
 * document as markup. JSON's `<` is still `<` to any parser, so nothing
 * downstream has to know. Built here rather than in the template so the escape
 * is one testable function and not a regex in an `.astro` file.
 */
export async function tiroPagePayload(slug: string): Promise<string> {
  const member = await collectionsOf(slug);
  const catalog = await getCollections();
  return JSON.stringify({
    v: 1,
    slug,
    member: member.map((collection) => collection.id),
    collections: catalog.map((collection) => ({
      id: collection.id,
      title: collection.title,
    })),
  }).replaceAll("<", "\\u003c");
}
