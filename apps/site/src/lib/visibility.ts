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

/**
 * Does this article have anything to read yet?
 *
 * A PDF is clipped as a stub — identity and title, no body — and the processor
 * builds the body later from the document's text layer (ADR 0026). Between
 * those two moments the article sits in the vault with nothing in it, and any
 * deploy triggered by some *other* article would publish it: a reader page
 * showing nothing, and a library row leading there. A PDF that is refused
 * outright — a scan, a login wall — stays in that state permanently.
 *
 * This is the same empty article the clipper refused to commit back when a PDF
 * tab was a dead end. Moving where an empty article can be *created* must not
 * move where one can be *published*, so the old refusal is restated here, at
 * the other end of the pipeline.
 *
 * Asked of the body rather than of `source_media` and `processed_at` together,
 * because emptiness is the property that actually makes publishing wrong, and
 * nothing else has to be true for it to be. It also lands the right answer on
 * the case those two fields would get wrong: a PDF re-clip that carried its
 * previous body forward is unprocessed but not empty, and it has something to
 * read, so it keeps its page.
 */
export function hasReadableBody(article: { body: string }): boolean {
  return article.body.trim() !== "";
}
