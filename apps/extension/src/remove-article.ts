import {
  articleDir,
  COLLECTIONS_DIR,
  dropCollectionMember,
  indexPath,
  readFrontmatterLoose,
  stringifyCollection,
} from "@tiro/shared/documents"; // not the root: see there
import { readEveryCollection } from "./collections-read.ts";
import {
  type CommitFile,
  commitFiles,
  type FetchLike,
  readAtHead,
} from "./github.ts";
import type { TiroExtensionConfig } from "./storage.ts";
import { isArticleSlug } from "./tiro-page.ts";

/**
 * Removing an article from the vault (ADR 0036).
 *
 * Two steps, the popup's confirmation between them: `lookupArticle` finds out
 * what is really there, so the confirmation can name it, and `removeArticle`
 * deletes it — its whole directory, and its place in every collection — as
 * one commit.
 */

/** What the vault holds at a slug, as much as the confirmation needs. */
export interface FoundArticle {
  /** The vault's own title, or null when its frontmatter cannot be read. */
  title: string | null;
  /** The translated title (ADR 0016), when the article has one. */
  titleZh: string | null;
}

function assertSlug(slug: string): void {
  // A slug comes from a page's marker or from a URL. Either way it becomes a
  // path in a deletion, so one that is not a plain path segment stops here,
  // before any request is made.
  if (!isArticleSlug(slug)) {
    throw new Error(`"${slug}" is not an article slug`);
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The article at `slug` as the vault has it, or null when it is not there.
 *
 * The slug is untrusted — a Tiro page's marker can name any slug, and a clip
 * record can be stale — so the confirmation shows what this finds rather than
 * what the page said. Read loosely: an article whose frontmatter is broken
 * must still be removable, so that reads as an untitled article, not an
 * error. Not `findExistingIndex`, which refuses exactly such an article.
 *
 * A null answer is trustworthy because `readAtHead` reads the branch first: a
 * vault the token cannot see throws rather than reading as empty.
 */
export async function lookupArticle(
  config: TiroExtensionConfig,
  slug: string,
  fetchImpl: FetchLike = fetch,
): Promise<FoundArticle | null> {
  assertSlug(slug);
  const { text: index } = await readAtHead(config, indexPath(slug), fetchImpl);
  if (index === null) return null;
  const frontmatter = readFrontmatterLoose(index);
  return frontmatter.kind === "ok"
    ? {
        title: text(frontmatter.data.title),
        titleZh: text(frontmatter.data.title_zh),
      }
    : { title: null, titleZh: null };
}

/** A collection file that names the article and cannot be parsed. */
export class UnreadableCollectionError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(
      `${path} names this article and could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "UnreadableCollectionError";
  }
}

export type RemoveOutcome =
  | {
      kind: "removed";
      commit: string;
      /** How many files the article's directory held. */
      files: number;
      /** The collections it was taken out of, or whose cover it was. */
      collections: string[];
    }
  /** Not in the vault — nothing was committed. */
  | { kind: "gone" };

/**
 * `remove: <title>`, and a body saying what went with it, so `git log` in the
 * vault reads without opening the diff.
 */
function commitMessage(
  slug: string,
  title: string | undefined,
  files: number,
  changes: readonly { id: string; member: boolean; cover: boolean }[],
): string {
  const lines = [
    `remove: ${title ?? slug}`,
    "",
    `articles/${slug}/ (${files === 1 ? "1 file" : `${files} files`})`,
  ];
  if (changes.length > 0) {
    const parts = changes.map(({ id, member, cover }) =>
      [id, member ? "−1" : "", cover ? "(cover unpinned)" : ""]
        .filter((part) => part !== "")
        .join(" "),
    );
    lines.push(`collections: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Delete the article at `slug`, and take it out of every collection, as one
 * commit.
 *
 * "The article" is its whole directory — `index.md`, `zh.md`, `assets/`, the
 * processor's checkpoints — listed at the head the commit is built on. A
 * directory without an `index.md` is not an article (what `validate` means by
 * one), so that is "gone" and nothing is written.
 *
 * Built by `commitFiles`, so a commit landing in between — typically the
 * processing run finishing this very article — makes it rebuild from the new
 * head: the files that run added are listed, and deleted, too.
 *
 * Every collection file is read, since any of them may name the article. One
 * that cannot be parsed stops the removal only if its text contains the slug:
 * slugs end in a hash, so a file without it does not name this article, and a
 * broken collection that has nothing to do with it should not make the article
 * impossible to remove. One that does is the owner's hand-written document,
 * and rewriting it from a guess is not this function's call.
 */
export async function removeArticle(
  config: TiroExtensionConfig,
  slug: string,
  options: { title?: string } = {},
  fetchImpl: FetchLike = fetch,
): Promise<RemoveOutcome> {
  assertSlug(slug);
  // Reassigned by every attempt: a retry rebuilds against a new head.
  let files = 0;
  let collections: string[] = [];

  const { committed } = await commitFiles(
    config,
    {
      build: async (reader) => {
        const articleFiles = await reader.files(articleDir(slug));
        if (!articleFiles.includes(indexPath(slug))) return null;

        const { parsed, unreadable } = await readEveryCollection(reader);
        const naming = unreadable.find((file) => file.text.includes(slug));
        if (naming !== undefined) {
          throw new UnreadableCollectionError(naming.path, naming.error);
        }

        const changed = dropCollectionMember(
          parsed.map((p) => p.collection),
          slug,
        );
        const pathOf = new Map(parsed.map((p) => [p.collection.id, p.path]));
        const before = new Map(
          parsed.map((p) => [p.collection.id, p.collection.frontmatter]),
        );
        const changes = changed.map((c) => {
          const old = before.get(c.id);
          return {
            id: c.id,
            member: old?.items.some((item) => item.slug === slug) ?? false,
            cover:
              old?.cover !== undefined && c.frontmatter.cover === undefined,
          };
        });

        files = articleFiles.length;
        collections = changed.map((c) => c.id);
        const out: CommitFile[] = [
          ...articleFiles.map((path) => ({ path, delete: true as const })),
          ...changed.map((c) => ({
            path: pathOf.get(c.id) ?? `${COLLECTIONS_DIR}/${c.id}.md`,
            content: stringifyCollection(c.frontmatter, c.body),
          })),
        ];
        return {
          message: commitMessage(slug, options.title, files, changes),
          files: out,
        };
      },
    },
    fetchImpl,
  );

  // The builder returns null only when there is no article; an article always
  // has at least its index.md to delete, so a commit was made otherwise.
  return committed === null
    ? { kind: "gone" }
    : { kind: "removed", commit: committed, files, collections };
}
