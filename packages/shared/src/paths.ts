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

/**
 * A figure snapshot's id: the first 12 hex digits of the SHA-256 of its bytes.
 * It travels bare — never with its extension — because Readability turns any
 * attribute on a `<figure>` that looks like an image filename into an `<img>`
 * (`_fixLazyImages`), and a marker carrying one would publish a page-absolute
 * image in its place.
 */
export const SNAPSHOT_ID = /^[0-9a-f]{12}$/;

/**
 * The file a figure snapshot is committed as, in the article's `assets/`
 * (ADR 0039): its id and `.webp`.
 *
 * The processor's own shape — `<12 hex><ext>` — on purpose. Once committed, a
 * snapshot is an asset like any it downloaded: kept while `index.md` names it,
 * pruned by `reconcileAssets` once a re-clip no longer does. A name of its own
 * would be "someone else's file" to the processor and never pruned at all.
 */
export function snapshotAssetName(id: string): string {
  if (!SNAPSHOT_ID.test(id)) throw new Error(`not a snapshot id: ${id}`);
  return `${id}.webp`;
}

/**
 * The largest article asset the site will serve. Cloudflare Pages rejects
 * files over 25 MB; the processor caps downloads at 10 MB, so anything bigger
 * is unexpected. The site's `copy-assets` skips it loudly, which is why a
 * collection cover naming one is refused by `validate` — it would point at a
 * file that was never published.
 */
export const MAX_SERVED_ASSET_BYTES = 20 * 1024 * 1024;
/** Collections live beside `articles/`, one file per collection, the filename
 * stem being the id (ADR 0029). The processor's globs are all rooted at
 * `articles/`, so nothing here is ever mistaken for an article. */
export const COLLECTIONS_DIR = "collections";

/**
 * Where a link saved without its page waits to become an article (ADR 0034):
 * one file per save, dropped by a phone's shortcut or the extension's "Clip
 * link", holding the URL as text. The processor turns each into a stub under
 * `articles/` and deletes it. A file rather than a message, because a file is
 * in git the moment it is saved, whatever happens to the run it starts.
 */
export const INBOX_DIR = "inbox";

export function collectionPath(id: string): string {
  return `${COLLECTIONS_DIR}/${id}.md`;
}
