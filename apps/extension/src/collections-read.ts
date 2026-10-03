import {
  COLLECTIONS_DIR,
  compareInstants,
  FAVORITES_ID,
  isValidCollectionId,
  type ParsedCollection,
  parseCollection,
} from "@tiro/shared/documents"; // not the root: see there
import { type FetchLike, readerAtHead, type TreeReader } from "./github.ts";
import type { TiroExtensionConfig } from "./storage.ts";
import type { CatalogEntry } from "./tiro-page.ts";

/**
 * Reading the vault's collections (ADR 0029) — every file under
 * `collections/`, from one commit.
 */

export interface CollectionFiles {
  /** Every file that parsed, in filename order. */
  parsed: { path: string; collection: ParsedCollection }[];
  /**
   * Every file that did not — a filename that is not a collection id is judged
   * the same way, since it already fails the site's build. The text rides
   * along so a caller can tell whether a broken file concerns it.
   */
  unreadable: { path: string; text: string; error: unknown }[];
}

/**
 * Every collection file the reader's commit holds, parsed where it can be.
 *
 * What to do about one that cannot be is the caller's call, not this one's:
 * Remove refuses only when the broken file names the article it is removing,
 * and the popup's catalog just leaves it out.
 */
export async function readEveryCollection(
  reader: Pick<TreeReader, "list" | "read">,
): Promise<CollectionFiles> {
  const names = ((await reader.list(COLLECTIONS_DIR)) ?? [])
    .filter((name) => name.endsWith(".md"))
    .sort();
  const read = await Promise.all(
    names.map(async (name) => {
      const path = `${COLLECTIONS_DIR}/${name}`;
      return { path, id: name.slice(0, -3), text: await reader.read(path) };
    }),
  );
  const out: CollectionFiles = { parsed: [], unreadable: [] };
  for (const { path, id, text } of read) {
    if (text === null) continue;
    try {
      if (!isValidCollectionId(id)) {
        throw new Error(`"${id}" is not a collection id`);
      }
      out.parsed.push({ path, collection: parseCollection(id, text) });
    } catch (error) {
      out.unreadable.push({ path, text, error });
    }
  }
  return out;
}

/**
 * What the popup offers after a clip (ADR 0037): the same shape a Tiro page's
 * marker gives it, read from the vault instead of from a page.
 */
export interface ClipCollections {
  slug: string;
  /** The collections the vault, at the commit read, says the article is in. */
  member: string[];
  /** Favorites first, then most recently updated — the site's own order. */
  catalog: CatalogEntry[];
  /** Collection files that could not be read, and so are not offered. */
  unreadable: string[];
}

/**
 * The collection catalog at the branch head, and the article's place in it.
 *
 * Read only after the clip has been committed: the disclosure promises that
 * nothing reaches the vault before the Clip click, and a read is a request to
 * it all the same. A collection file that does not parse is left out rather
 * than failing the read — it cannot be toggled until it is fixed, but every
 * other collection still can, and the flush refuses to rewrite it anyway.
 */
export async function readClipCollections(
  config: TiroExtensionConfig,
  slug: string,
  fetchImpl: FetchLike = fetch,
): Promise<ClipCollections> {
  const { reader } = await readerAtHead(config, fetchImpl);
  const { parsed, unreadable } = await readEveryCollection(reader);
  const collections = parsed.map((p) => p.collection);
  collections.sort((a, b) => {
    if (a.id !== b.id) {
      if (a.id === FAVORITES_ID) return -1;
      if (b.id === FAVORITES_ID) return 1;
    }
    const byUpdated = compareInstants(
      b.frontmatter.updated_at,
      a.frontmatter.updated_at,
    );
    return byUpdated !== 0 ? byUpdated : a.id.localeCompare(b.id);
  });
  return {
    slug,
    member: collections
      .filter((c) => c.frontmatter.items.some((item) => item.slug === slug))
      .map((c) => c.id),
    catalog: collections.map((c) => ({ id: c.id, title: c.frontmatter.title })),
    unreadable: unreadable.map((u) => u.path),
  };
}
