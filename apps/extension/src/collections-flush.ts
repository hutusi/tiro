import {
  applyCollectionOps,
  articleDir,
  collectionPath,
  isValidCollectionId,
  parseCollection,
  stringifyCollection,
} from "@tiro/shared/documents"; // not the root: see there
import type { QueuedOp } from "./collection-queue.ts";
import { commitFiles, type FetchLike } from "./github.ts";
import type { TiroExtensionConfig } from "./storage.ts";

export interface FlushOutcome {
  /** The commit made, or null when every op turned out to be a no-op. */
  committed: string | null;
  /** Ops that are now true of the vault, whether or not this flush had to
   * write anything for them. */
  sent: Set<string>;
  /** Ops that can never apply: an add for an article this vault does not
   * have. Retrying would not change that, so they are dropped, not kept. */
  refused: QueuedOp[];
}

/**
 * `collections: favorites +2 −1, reading +1` — what this commit changes, per
 * collection, so `git log` in the vault reads without opening the diff.
 *
 * Counted from the membership each file had and will have, not from the
 * toggles that were queued: an add the vault refused, or a toggle that
 * already landed, changes nothing and must not be counted. Built inside the
 * builder for the same reason the files are — a retry against a newer head
 * can change both.
 */
function commitMessage(
  changes: readonly {
    id: string;
    before: readonly string[];
    after: readonly string[];
  }[],
): string {
  const parts = changes.map(({ id, before, after }) => {
    const added = after.filter((slug) => !before.includes(slug)).length;
    const removed = before.filter((slug) => !after.includes(slug)).length;
    return [id, added > 0 ? `+${added}` : "", removed > 0 ? `−${removed}` : ""]
      .filter((part) => part !== "")
      .join(" ");
  });
  return `collections: ${parts.join(", ")}`;
}

/**
 * Write every pending toggle to the vault as one commit (ADR 0029).
 *
 * Built against the head `commitFiles` reads, and rebuilt if another commit
 * lands first, so the ops are applied as a delta to each collection as it now
 * stands — an edit from another machine survives, and an op that already
 * landed is a no-op rather than a duplicate.
 *
 * An add is checked against the vault before it is written. The page it came
 * from says "a Tiro site", not "*your* Tiro site" — the marker is deliberately
 * not tied to a hostname — so a slug from someone else's deployment, or from a
 * tab open since the article was deleted, would otherwise put a member in the
 * collection with nothing behind it. Such an op is refused and dropped; it
 * could never succeed. Removals are not checked: removing a slug that is not
 * there is already a no-op.
 *
 * A collection file this cannot parse fails the whole flush and keeps the
 * queue, rather than being overwritten from nothing. It is the owner's
 * hand-written document, and a flush that "fixed" it by replacing it would
 * lose every member it held.
 */
export async function flushCollections(
  config: TiroExtensionConfig,
  pending: readonly QueuedOp[],
  fetchImpl: FetchLike = fetch,
): Promise<FlushOutcome> {
  if (pending.length === 0) {
    return { committed: null, sent: new Set(), refused: [] };
  }
  for (const op of pending) {
    // Ids come from a page, and a page is untrusted input. One that could not
    // be a filename must never become a path.
    if (!isValidCollectionId(op.collection)) {
      throw new Error(`"${op.collection}" is not a usable collection id`);
    }
  }

  // Reassigned by every attempt: a retry rebuilds against a new head, where an
  // article missing a moment ago may have arrived.
  let refused: QueuedOp[] = [];
  const { committed } = await commitFiles(
    config,
    {
      build: async (reader) => {
        const added = new Set(
          pending.filter((op) => op.action === "add").map((op) => op.slug),
        );
        // "An article" means what `validate` means: its `index.md` is there.
        // A directory alone is not enough — one holding only an orphan `zh.md`
        // would pass, and the collection would gain a member `validate` then
        // refuses and the site silently skips.
        const missing = new Set<string>();
        for (const slug of added) {
          const names = await reader.list(articleDir(slug));
          if (!names?.includes("index.md")) missing.add(slug);
        }
        refused = pending.filter(
          (op) => op.action === "add" && missing.has(op.slug),
        );
        const usable = pending.filter((op) => !refused.includes(op));

        const ids = [...new Set(usable.map((op) => op.collection))].sort();
        const files: { path: string; content: string }[] = [];
        const changes: { id: string; before: string[]; after: string[] }[] = [];
        for (const id of ids) {
          const path = collectionPath(id);
          const text = await reader.read(path);
          const existing = text === null ? null : parseCollection(id, text);
          const next = applyCollectionOps(id, existing, usable);
          if (next === null) continue;
          files.push({
            path,
            content: stringifyCollection(next.frontmatter, next.body),
          });
          changes.push({
            id,
            before: existing?.frontmatter.items.map((item) => item.slug) ?? [],
            after: next.frontmatter.items.map((item) => item.slug),
          });
        }
        return { message: commitMessage(changes), files };
      },
    },
    fetchImpl,
  );

  return {
    committed,
    sent: new Set(
      pending.filter((op) => !refused.includes(op)).map((op) => op.id),
    ),
    refused,
  };
}
