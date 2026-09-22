/**
 * Collections — the owner's own curation, as vault documents (ADR 0029).
 *
 * Tags and categories are LLM output; a collection is the one place in the
 * vault that records a human decision about an article. Favorites is a
 * collection with a reserved id, so "favorite" needs no second mechanism.
 *
 * One file per collection at `collections/<id>.md`, with the filename stem as
 * the id — the same "the path is the identity" rule the flat article layout
 * follows (ADR 0007). Membership deliberately does *not* live in article
 * frontmatter: the processor rewrites `index.md` on every run, and a curation
 * edit racing that rewrite would be a conflict on the one file the whole
 * pipeline depends on.
 *
 * Browser-safe: the extension writes these files, so nothing here may touch
 * `node:` APIs (invariant 6).
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  FRONTMATTER_RE,
  isoDatetime,
  TIRO_SCHEMA_VERSION,
} from "./frontmatter.ts";

/** The one reserved id. A favorite is membership in this collection and
 * nothing else — there is no separate flag to keep in step with it. */
export const FAVORITES_ID = "favorites";

/**
 * One article's membership.
 *
 * `added_at` is optional so a collection stays worth hand-editing: `- slug: x`
 * on its own is a valid entry. The extension always writes the timestamp; a
 * reader that wants a date must cope with not having one.
 */
export const CollectionItemSchema = z.object({
  slug: z.string().min(1),
  added_at: isoDatetime.optional(),
});
export type CollectionItem = z.infer<typeof CollectionItemSchema>;

/**
 * A collection's frontmatter.
 *
 * `tiro.schema` is the same dial the article document format uses: both are
 * vault documents written by the same three components, so a breaking change
 * to either is the same lockstep event. Adding the directory is additive —
 * no `collections/` means no collections — so it does not bump (ADR 0002).
 *
 * Only `title` is required. The timestamps are metadata the extension
 * maintains, and demanding them would make a hand-written collection fail
 * validation for no benefit.
 */
export const CollectionFrontmatterSchema = z.object({
  /** Display name. Free-form — Chinese titles are the expected case, which is
   * exactly why it is not the id. */
  title: z.string().min(1),
  description: z.string().trim().min(1).optional(),
  created_at: isoDatetime.optional(),
  updated_at: isoDatetime.optional(),
  /** Ordered: file order *is* the curation order, so a hand edit reorders a
   * collection and no sort overrules it. The extension prepends. */
  items: z.array(CollectionItemSchema).default([]),
  tiro: z.object({ schema: z.literal(TIRO_SCHEMA_VERSION) }),
});
export type CollectionFrontmatter = z.infer<typeof CollectionFrontmatterSchema>;

export interface ParsedCollection {
  /** Stem of the filename it was read from. The identity, never stored inside
   * the file — one definition, the way an article's slug is its directory. */
  id: string;
  frontmatter: CollectionFrontmatter;
  /** Markdown body with the frontmatter fence stripped. May be empty. */
  body: string;
}

/** Parse and validate a `collections/<id>.md` file. Throws on violations. */
export function parseCollection(
  id: string,
  fileText: string,
): ParsedCollection {
  const match = fileText.match(FRONTMATTER_RE);
  if (match?.[1] === undefined) {
    throw new Error("collection has no frontmatter block");
  }
  const frontmatter = CollectionFrontmatterSchema.parse(parseYaml(match[1]));
  const body = fileText.slice(match[0].length).replace(/^\n+/, "");
  return { id, frontmatter, body };
}

/**
 * Serialize a collection back to file text. Same reasoning as
 * `stringifyArticle`: the `yaml` serializer owns quoting, because a title
 * containing `: " #` must never be templated by hand.
 *
 * An empty body gets no trailing blank line — most collections are a title and
 * a list, and a file that ends in stray whitespace churns the diff on every
 * toggle.
 */
export function stringifyCollection(
  frontmatter: CollectionFrontmatter,
  body: string,
): string {
  const yamlText = stringifyYaml(frontmatter).trimEnd();
  const trimmed = body.trimEnd();
  return trimmed === ""
    ? `---\n${yamlText}\n---\n`
    : `---\n${yamlText}\n---\n\n${trimmed}\n`;
}

/** One queued membership edit. */
export interface CollectionOp {
  /** Target collection id. */
  collection: string;
  /**
   * Display title, carried only by an op that may have to create the file.
   * Without it a brand-new collection would be born titled with its own id.
   */
  title?: string;
  slug: string;
  action: "add" | "remove";
  /** When the user toggled, ISO. Becomes the item's `added_at`, so the record
   * is the moment of the decision rather than the moment of the flush. */
  at: string;
}

/**
 * Apply queued ops to a collection, purely.
 *
 * This is the whole correctness core, kept free of Chrome and GitHub so it can
 * be tested directly. Two properties matter and are tested as such:
 *
 * - **Idempotent, set semantics.** Adding a slug that is already a member
 *   leaves its position and `added_at` alone; removing one that is not a
 *   member changes nothing. So replaying a flush that already landed is safe,
 *   which is what lets the queue survive a service worker killed mid-write.
 * - **A delta, not an overwrite.** Ops are applied to the file *as it is now*,
 *   never to a copy the extension cached, so an edit made on another machine
 *   between read and write survives.
 *
 * Returns null when nothing changed — including every op being a no-op, and a
 * removal from a collection that does not exist. The caller must then write
 * nothing at all: an empty commit still costs a push, a workflow run and a
 * build.
 */
export function applyCollectionOps(
  id: string,
  existing: ParsedCollection | null,
  ops: readonly CollectionOp[],
): ParsedCollection | null {
  const mine = ops.filter((op) => op.collection === id);
  if (mine.length === 0) return null;

  // Oldest first, so two toggles of the same article in one flush settle on
  // the last thing the user actually did.
  const ordered = [...mine].sort((a, b) => a.at.localeCompare(b.at));

  const before = existing === null ? [] : existing.frontmatter.items;
  let items = [...before];
  let latest = "";

  for (const op of ordered) {
    const member = items.some((item) => item.slug === op.slug);
    if (op.action === "add") {
      if (member) continue;
      // Prepend: a collection reads newest-first until its owner reorders it.
      items = [{ slug: op.slug, added_at: op.at }, ...items];
    } else {
      if (!member) continue;
      items = items.filter((item) => item.slug !== op.slug);
    }
    if (op.at > latest) latest = op.at;
  }

  // Compared against where we started, not counted as we went: a flush that
  // adds an article and then removes it again has done nothing, and writing
  // that "nothing" would still cost a commit, a workflow run and a build.
  const sameMembers =
    items.length === before.length &&
    items.every((item, i) => item.slug === before[i]?.slug);
  if (sameMembers) return null;

  if (existing !== null) {
    return {
      id,
      frontmatter: { ...existing.frontmatter, items, updated_at: latest },
      body: existing.body,
    };
  }

  // Born from the first op that named a title; an op queued against a
  // collection the page listed carries none, and the id is the honest
  // fallback rather than a guess at what the owner meant.
  const title = ordered.find((op) => op.title !== undefined)?.title ?? id;
  const created = ordered[0]?.at ?? latest;
  return {
    id,
    frontmatter: {
      title,
      created_at: created,
      updated_at: latest,
      items,
      tiro: { schema: TIRO_SCHEMA_VERSION },
    },
    body: "",
  };
}
