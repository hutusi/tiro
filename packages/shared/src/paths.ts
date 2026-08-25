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
