import { compareInstants, FAVORITES_ID, parseMemberRef } from "@tiro/shared";
import { type Article, getArticles } from "./articles.ts";
import { coverImages } from "./covers.ts";
import { getSites, type Member, type Site } from "./sites.ts";
import { STRINGS } from "./strings.ts";
import { readCollections } from "./vault-read.ts";

/** A run of listed members under one heading, or under none (ADR 0051). */
export interface CollectionSection {
  title: string | null;
  members: Member[];
}

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
  /** The listed saved sites among the members (ADR 0055), in file order. */
  sites: Site[];
  /** Both kinds, in the owner's order — what the page lists. */
  members: Member[];
  /**
   * `members`, split where the members' `section` changes (ADR 0051).
   *
   * Grouped after the listed join, so a run broken only by an unlisted or
   * missing member is still one group. A collection with no sections is one
   * untitled group, and renders exactly as it did before sections existed.
   */
  sections: CollectionSection[];
  /**
   * Every member as the vault names it — an article's slug, `sites/<slug>`
   * for a saved site — listed or not, in file order.
   *
   * Membership is a fact about the collection; being listed is a fact about
   * the article. The clipper's tick must reflect the first, so it cannot read
   * `articles`. A slug with no article in the vault survives here too — the
   * site degrades to not showing a row, and `validate` is what refuses it.
   */
  memberSlugs: string[];
  /**
   * What the collection is shown with: 0–3 public image paths, the hand-set
   * cover or the listed members' lead images (see `coverImages`). Empty means
   * a typographic cover — a valid state, not a missing one.
   */
  coverImages: string[];
  /**
   * Favorites standing in for a `favorites.md` the vault does not have yet.
   *
   * Favorites is the one collection every reader has — the clipper offers it
   * first even before its file exists — and `/favorites/` redirects to it
   * unconditionally, so its page has to exist too, or that shortcut is a 404
   * on every vault that has not favorited anything. It is never offered to the
   * clipper as a real collection: see `tiroPagePayload`.
   */
  virtual: boolean;
}

let cache: Collection[] | null = null;
/** The reads these were built from. Both `readCollections` and `getArticles`
 * hand back the same array while nothing changed, so comparing identity is the
 * whole staleness check — same trick, same reason, as `articles.ts`. */
let cacheCollectionSource: unknown = null;
let cacheArticleSource: unknown = null;
let cacheSiteSource: unknown = null;
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
  const sites = getSites();
  if (
    cache !== null &&
    cacheCollectionSource === entries &&
    cacheArticleSource === articles &&
    cacheSiteSource === sites
  ) {
    return cache;
  }
  cacheCollectionSource = entries;
  cacheArticleSource = articles;
  cacheSiteSource = sites;
  membershipCache = null;

  const bySlug = new Map(articles.map((article) => [article.slug, article]));
  // By `sites/<slug>`, the form a collection names a site by (ADR 0055): the
  // same slug under `articles/` is a different document.
  const byRef = new Map(sites.map((site) => [site.ref, site]));
  const listed = new Set([...bySlug.keys(), ...byRef.keys()]);

  const collections = entries.map((entry): Collection => {
    const memberSlugs = entry.frontmatter.items.map((item) => item.slug);
    const members: Member[] = [];
    const sections: CollectionSection[] = [];
    for (const item of entry.frontmatter.items) {
      const ref = parseMemberRef(item.slug);
      let member: Member | undefined;
      if (ref.kind === "site") {
        const site = byRef.get(item.slug);
        if (site !== undefined) member = { kind: "site", site };
      } else {
        const article = bySlug.get(item.slug);
        if (article !== undefined) member = { kind: "article", article };
      }
      if (member === undefined) continue;
      members.push(member);
      const title = item.section ?? null;
      const last = sections.at(-1);
      if (last !== undefined && last.title === title) last.members.push(member);
      else sections.push({ title, members: [member] });
    }
    return {
      id: entry.id,
      title: entry.frontmatter.title,
      description: entry.frontmatter.description ?? null,
      body: entry.body,
      updatedAt: entry.frontmatter.updated_at ?? null,
      articles: members.flatMap((m) =>
        m.kind === "article" ? [m.article] : [],
      ),
      sites: members.flatMap((m) => (m.kind === "site" ? [m.site] : [])),
      members,
      sections,
      memberSlugs,
      coverImages: coverImages(
        entry.id,
        entry.frontmatter.cover,
        members,
        listed,
      ),
      virtual: false,
    };
  });
  if (!collections.some((collection) => collection.id === FAVORITES_ID)) {
    collections.push({
      id: FAVORITES_ID,
      title: STRINGS.collections.favorites,
      description: null,
      body: "",
      updatedAt: null,
      articles: [],
      sites: [],
      members: [],
      sections: [],
      memberSlugs: [],
      coverImages: [],
      virtual: true,
    });
  }

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
 * `slug` is the member as the vault names it, so a saved site asks with
 * `sites/<slug>` (ADR 0055).
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
 *
 * A saved site's page passes `sites/<slug>` (ADR 0055). The released
 * extension refuses a slug that is not one path segment and so takes that
 * page for a plain Tiro page — never for the article of the same slug, which
 * its Remove and its ticks would otherwise act on.
 */
export async function tiroPagePayload(slug: string): Promise<string> {
  const member = await collectionsOf(slug);
  const catalog = await getCollections();
  return JSON.stringify({
    v: 1,
    slug,
    member: member.map((collection) => collection.id),
    // Only collections with a file. The clipper sends a title with an op only
    // for a collection missing from this catalog, and that title is what the
    // file is born with — so listing virtual favorites here would make the
    // first favorite create `favorites.md` titled "favorites". Left out, the
    // clipper names it itself, as it always has.
    collections: catalog
      .filter((collection) => !collection.virtual)
      .map((collection) => ({
        id: collection.id,
        title: collection.title,
      })),
  }).replaceAll("<", "\\u003c");
}
