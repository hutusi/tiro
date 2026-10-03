import {
  COLLECTIONS_DIR,
  isValidCollectionId,
  type ParsedCollection,
  parseCollection,
} from "@tiro/shared/documents"; // not the root: see there
import type { TreeReader } from "./github.ts";

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
