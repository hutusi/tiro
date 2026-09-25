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
  compareInstants,
  FRONTMATTER_RE,
  isoDatetime,
  TIRO_SCHEMA_VERSION,
} from "./frontmatter.ts";

/** The one reserved id. A favorite is membership in this collection and
 * nothing else — there is no separate flag to keep in step with it. */
export const FAVORITES_ID = "favorites";

/**
 * A collection's cover: one article asset, named by its vault path.
 *
 * A path into the vault, not a URL. The site is public and a hotlinked cover
 * breaks the day its host moves it, silently; an asset path is something
 * `validate` can check exists (ADR 0030). Any article's asset may serve, not
 * only a member's — the picture that sums up a shelf is not always inside it.
 *
 * Both parts are held to the alphabet the pipeline itself writes (slugs are
 * lowercase dash-joined ascii, assets are content-hash names), loosened only
 * enough for a hand-placed file: no separators and no leading dot, so the path
 * can never climb out of the article's `assets/`.
 */
const COVER_RE =
  /^articles\/([a-z0-9]+(?:-[a-z0-9]+)*)\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

/**
 * Files a browser shows as an image — what a cover may be. Checked by
 * `validate` and by the site, not by the schema: a schema failure fails the
 * build and stops the clipper writing the collection at all, and a wrong
 * extension is the owner's to fix at leisure, not a reason to block either.
 */
const COVER_IMAGE_RE = /\.(?:jpe?g|png|webp|avif|gif|svg)$/i;

export function isCoverImageFile(file: string): boolean {
  return COVER_IMAGE_RE.test(file);
}

/** The article and file a cover path names, or null if it is not one. */
export function parseCoverPath(
  cover: string,
): { slug: string; file: string } | null {
  const match = COVER_RE.exec(cover);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { slug: match[1], file: match[2] };
}

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
  /** Hand-set cover, `articles/<slug>/assets/<file>`. Absent is the normal
   * case: the site then builds one from the members' own images (ADR 0030).
   *
   * Declared here even though only a person writes it, because this schema is
   * also what the clipper parses a collection with before rewriting it — and
   * zod drops keys it was not told about, so a field missing from here would
   * be erased by the next toggle. */
  cover: z
    .string()
    .regex(COVER_RE, "expected articles/<slug>/assets/<file>")
    .optional(),
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
  const ordered = [...mine].sort((a, b) => compareInstants(a.at, b.at));

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
    if (compareInstants(op.at, latest) > 0) latest = op.at;
  }

  // Compared against where we started, not counted as we went: a flush that
  // adds an article and then removes it again has done nothing, and writing
  // that "nothing" would still cost a commit, a workflow run and a build.
  const sameMembers =
    items.length === before.length &&
    items.every((item, i) => item.slug === before[i]?.slug);
  if (sameMembers) return null;

  if (existing !== null) {
    // Never earlier than what the file already says. Another machine may have
    // saved after this one queued its ops — the reason this applies a delta at
    // all — and taking the ops' time alone would move `updated_at` backwards,
    // sinking a collection that just changed down the list.
    const previous = existing.frontmatter.updated_at;
    const updated =
      previous !== undefined && compareInstants(previous, latest) > 0
        ? previous
        : latest;
    return {
      id,
      frontmatter: { ...existing.frontmatter, items, updated_at: updated },
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

/**
 * Carry an article's memberships across a slug rename, purely.
 *
 * The rename happens when an identity rule changes (invariant 2) — `sweep
 * --recanonicalize` moves the article's directory, and every collection that
 * named the old slug would otherwise be left pointing at nothing. The site
 * shows that as a missing row, not an error, so without this a rule change
 * would quietly empty collections.
 *
 * The member keeps its place and its `added_at`: it is the same article, and
 * the owner's ordering is not something a rename gets to reshuffle. If the new
 * slug is already a member — two old URLs canonicalizing to one article — the
 * old entry is dropped rather than listed twice. `updated_at` is left alone,
 * because nothing the owner decided has changed.
 *
 * A cover naming the old slug is carried too, whether or not the article is a
 * member: the rename moves its `assets/` directory, and a cover left pointing
 * at the old one is a broken image the site would quietly replace.
 *
 * Returns only the collections that changed, so the caller writes nothing it
 * does not have to.
 */
export function renameCollectionMember(
  collections: readonly ParsedCollection[],
  from: string,
  to: string,
): ParsedCollection[] {
  const changed: ParsedCollection[] = [];
  for (const collection of collections) {
    const { items, cover } = collection.frontmatter;
    const member = items.some((item) => item.slug === from);
    // The cover moves with the directory it lives in, and it may name an
    // article that is not a member — so it is checked on its own, not only
    // for collections that hold `from`.
    const coverTarget = cover === undefined ? null : parseCoverPath(cover);
    const coverMoves = coverTarget?.slug === from;
    if (!member && !coverMoves) continue;
    const already = items.some((item) => item.slug === to);
    const renamed = !member
      ? items
      : already
        ? items.filter((item) => item.slug !== from)
        : items.map((item) =>
            item.slug === from ? { ...item, slug: to } : item,
          );
    const frontmatter = { ...collection.frontmatter, items: renamed };
    if (coverMoves && coverTarget !== null) {
      frontmatter.cover = `articles/${to}/assets/${coverTarget.file}`;
    }
    changed.push({ ...collection, frontmatter });
  }
  return changed;
}
