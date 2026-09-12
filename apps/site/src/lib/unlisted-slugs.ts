import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArticle } from "@tiro/shared";
import { vaultDir } from "./vault.ts";
import { isUnlisted } from "./visibility.ts";

let cache: Set<string> | null = null;

/**
 * The slugs of every unlisted article, read straight off the vault.
 *
 * The sitemap needs this and cannot get it the way the rest of the site does:
 * `@astrojs/sitemap` is configured in `astro.config.mjs`, which is evaluated
 * before the content layer exists, and its `filter` is synchronous. So this
 * reads the files itself — with the shared `parseArticle`, not a hand-rolled
 * YAML pass, so "what counts as unlisted" has exactly one definition.
 *
 * Memoized: the filter is called once per built page, and re-reading the whole
 * vault each time would be quadratic in article count for no gain.
 *
 * Throws on an unparseable article, naming the file. The build would fail on
 * it anyway a moment later (`articles.ts` validates every entry through the
 * same schema); failing here with the path is the better error.
 */
export function unlistedSlugs(): Set<string> {
  if (cache !== null) return cache;
  const articlesDir = join(vaultDir(), "articles");
  const slugs = new Set<string>();
  for (const entry of readdirSync(articlesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = join(articlesDir, entry.name, "index.md");
    let text: string;
    try {
      text = readFileSync(indexPath, "utf8");
    } catch {
      // A directory without an index.md is not an article; the glob loader
      // ignores it too, so there is nothing here to hide or to publish.
      continue;
    }
    try {
      if (isUnlisted(parseArticle(text).frontmatter)) slugs.add(entry.name);
    } catch (error) {
      throw new Error(`${indexPath}: ${(error as Error).message}`);
    }
  }
  cache = slugs;
  return slugs;
}

/**
 * Should this page URL appear in the sitemap? Shaped for `sitemap({ filter })`,
 * which hands over absolute URLs like
 * `https://tiro.ainaive.com/articles/<slug>/`.
 *
 * Matches on the path segment rather than a substring: a slug is also a
 * publisher's own path, so a bare `includes()` would drop a page whose URL
 * merely contained one.
 */
export function isSitemapEligible(page: string): boolean {
  const match = new URL(page).pathname.match(/^\/articles\/([^/]+)\/?$/);
  return match === null || !unlistedSlugs().has(match[1] as string);
}
