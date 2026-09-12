import type { ArticleFrontmatter } from "@tiro/shared";

/**
 * Is this article hidden from every surface that enumerates articles?
 *
 * One line, but its own module on purpose: it is the single definition of
 * "hidden", and its three callers cannot share any other home. `articles.ts`
 * imports `astro:content`, which only resolves inside an Astro build — so
 * nothing under `test/` can import it, and a predicate living there could not
 * be tested. The sitemap filter (`unlisted-slugs.ts`) runs from
 * `astro.config.mjs`, before the content layer exists at all.
 *
 * Strictly `=== true`, never truthiness: the field is optional, and the whole
 * point is that an article which never carried the key behaves exactly as it
 * did before the key existed.
 */
export function isUnlisted(
  frontmatter: Pick<ArticleFrontmatter, "unlisted">,
): boolean {
  return frontmatter.unlisted === true;
}
