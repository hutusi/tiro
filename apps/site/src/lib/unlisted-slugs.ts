import { readVault } from "./vault-read.ts";
import { isUnlisted } from "./visibility.ts";

let cache: Set<string> | null = null;
let cacheSource: unknown = null;

/**
 * The slugs of every unlisted article.
 *
 * Reads through `readVault`, the site's one reader of the vault (ADR 0020).
 * This used to walk the vault itself, because `@astrojs/sitemap` is configured
 * in `astro.config.mjs` — evaluated before Astro's content layer exists — and
 * its `filter` is synchronous, so the content layer was unreachable from here.
 * Now that nothing loads the vault through that layer, there is one reader
 * again and "what counts as unlisted" has one definition rather than two that
 * had to be kept in step.
 *
 * Memoized: the filter is called once per built page.
 */
export function unlistedSlugs(): Set<string> {
  const entries = readVault();
  if (cache !== null && cacheSource === entries) return cache;
  cacheSource = entries;
  cache = new Set(
    entries
      .filter((entry) => isUnlisted(entry.frontmatter))
      .map((entry) => entry.slug),
  );
  return cache;
}

/**
 * Should this page URL appear in the sitemap? Shaped for `sitemap({ filter })`,
 * which hands over absolute URLs like
 * `https://tiro.ainaive.com/articles/<slug>/`.
 *
 * Two things are kept out. Unlisted articles, which is the point of the flag.
 * And every `/s/` alias: those exist to redirect, so listing them would offer
 * a crawler a second address for content that already has a canonical one —
 * and, worse, would publish an unlisted article's short link in the very file
 * the flag keeps its long one out of.
 *
 * Matches on whole path segments rather than a substring: a slug is also a
 * publisher's own path, so a bare `includes()` would drop a page whose URL
 * merely contained one.
 */
export function isSitemapEligible(page: string): boolean {
  const { pathname } = new URL(page);
  if (/^\/s\/[^/]*\/?$/.test(pathname)) return false;
  const match = pathname.match(/^\/articles\/([^/]+)\/?$/);
  return match === null || !unlistedSlugs().has(match[1] as string);
}
