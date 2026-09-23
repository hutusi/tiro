/** Vault-relative path helpers. Plain string joins — no `node:path` — so
 * they are safe in the extension, Bun, and the site alike.
 *
 * The layout is flat: `articles/<slug>/…` (ADR 0007). The slug is the whole
 * identity, so the path itself guarantees a re-clip overwrites rather than
 * duplicates. */

export function articleDir(slug: string): string {
  return `articles/${slug}`;
}

export function indexPath(slug: string): string {
  return `${articleDir(slug)}/index.md`;
}

export function translationPath(slug: string): string {
  return `${articleDir(slug)}/zh.md`;
}

export function assetsDir(slug: string): string {
  return `${articleDir(slug)}/assets`;
}
/** Collections live beside `articles/`, one file per collection, the filename
 * stem being the id (ADR 0029). The processor's globs are all rooted at
 * `articles/`, so nothing here is ever mistaken for an article. */
export const COLLECTIONS_DIR = "collections";

export function collectionPath(id: string): string {
  return `${COLLECTIONS_DIR}/${id}.md`;
}
