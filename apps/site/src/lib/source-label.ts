import { type ArticleFrontmatter, localDocumentName } from "@tiro/shared";

/**
 * How an article names where it came from, and whether that is a link.
 *
 * Its own function because the reader asks three times — the toolbar chip, the
 * byline, and the end note — and an article that linked in one place and not
 * another would be a bug nobody noticed until they clicked.
 *
 * A document imported off disk has no address to open (ADR 0027). Its stored
 * `domain` is the sentinel `"local"`, which is the right thing to keep in the
 * vault and the wrong thing to show a reader: the filename is what the owner
 * calls it, and it is the only part that says which document this is.
 */
export interface SourceLabel {
  /** What to print. */
  name: string;
  /** Where it points, or null when there is nothing to open. */
  href: string | null;
}

export function sourceLabel(
  frontmatter: Pick<ArticleFrontmatter, "url" | "domain">,
): SourceLabel {
  const local = localDocumentName(frontmatter.url);
  return local === null
    ? { name: frontmatter.domain, href: frontmatter.url }
    : { name: local, href: null };
}
