import { shortIdForSlug } from "@tiro/shared";

/** Where the aliases live. `/s/` reads as short/share; `/a/` would invite the
 * reading that it and `/articles/` are one route family. */
export const SHORT_LINK_PREFIX = "/s";

export interface ShortLinks {
  /** Short id → slug, for every article that kept an id. */
  bySlug: Map<string, string>;
  /** Slug → short id — the direction the reader asks in. */
  byId: Map<string, string>;
  /** Slugs that lost their id to a clash, grouped by the id they shared. */
  collisions: Map<string, string[]>;
  /** Slugs whose name carries no derivable id at all. */
  underivable: string[];
}

/**
 * The short-link map for a set of article slugs.
 *
 * Ids are derived, never assigned (ADR 0019), which is what keeps this a pure
 * function of the slugs and so free of any registry. The consequence is that
 * two articles *could* in principle derive the same id, and that case has to
 * be handled here rather than wished away.
 *
 * A clash drops the id from **both** articles. The alternative — keep one, give
 * the other something else — sounds kinder and is worse: the id would then
 * depend on which article was seen first, and the site is rebuilt from scratch
 * on every deploy, so a clash resolved one way today could resolve the other
 * way tomorrow and silently re-point a link someone had already shared. A short
 * link that 404s is a visible failure; one that quietly leads somewhere else is
 * not. Both long URLs keep working either way.
 *
 * Note this drops ids rather than refusing the build. The deploy builds before
 * it uploads, so a refusal would leave the *previous* deployment live — the
 * same reasoning `articles.ts` records for the empty-library guard.
 */
export function buildShortLinks(slugs: Iterable<string>): ShortLinks {
  const claims = new Map<string, string[]>();
  const underivable: string[] = [];
  for (const slug of slugs) {
    const id = shortIdForSlug(slug);
    if (id === null) {
      underivable.push(slug);
      continue;
    }
    const claimed = claims.get(id);
    if (claimed === undefined) claims.set(id, [slug]);
    else claimed.push(slug);
  }

  const bySlug = new Map<string, string>();
  const byId = new Map<string, string>();
  const collisions = new Map<string, string[]>();
  for (const [id, claimants] of claims) {
    if (claimants.length > 1) {
      collisions.set(id, [...claimants].sort());
      continue;
    }
    const slug = claimants[0] as string;
    bySlug.set(id, slug);
    byId.set(slug, id);
  }
  return { bySlug, byId, collisions, underivable: underivable.sort() };
}

/** The site path an id resolves at. */
export function shortLinkPath(id: string): string {
  return `${SHORT_LINK_PREFIX}/${id}/`;
}

/** This article's short path, or null when it has no id — the caller falls
 * back to the long URL rather than offering a link that does not resolve. */
export function shortPathForSlug(
  links: ShortLinks,
  slug: string,
): string | null {
  const id = links.byId.get(slug);
  return id === undefined ? null : shortLinkPath(id);
}

/**
 * Say what was dropped, on the build log. Both losing cases are silent in the
 * output — the article still builds, its long URL still works — so this is the
 * only thing that would ever tell anyone a short link is missing.
 */
export function reportShortLinks(links: ShortLinks): void {
  for (const [id, slugs] of links.collisions) {
    console.warn(
      `short links: ${slugs.length} articles derive the id "${id}", so none of them gets one: ${slugs.join(", ")}`,
    );
  }
  for (const slug of links.underivable) {
    console.warn(
      `short links: no id derivable from "${slug}" — it does not end in a hash, so it gets no short link`,
    );
  }
}
