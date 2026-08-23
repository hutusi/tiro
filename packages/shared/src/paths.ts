/** Vault-relative path helpers. Plain string joins — no `node:path` — so
 * they are safe in the extension, Bun, and the site alike. */

export function articleDir(year: number, slug: string): string {
  return `articles/${year}/${slug}`;
}

export function indexPath(year: number, slug: string): string {
  return `${articleDir(year, slug)}/index.md`;
}

export function translationPath(year: number, slug: string): string {
  return `${articleDir(year, slug)}/zh.md`;
}

export function assetsDir(year: number, slug: string): string {
  return `${articleDir(year, slug)}/assets`;
}

/** The year partition an article belongs to, from its clip timestamp (UTC). */
export function yearFromClippedAt(clippedAtIso: string): number {
  const year = new Date(clippedAtIso).getUTCFullYear();
  if (Number.isNaN(year))
    throw new Error(`invalid clipped_at timestamp: ${clippedAtIso}`);
  return year;
}
