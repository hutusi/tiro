import {
  normalizeUrl,
  previewFile,
  previewRef,
  readFrontmatterLoose,
  SiteClipFrontmatterSchema,
  siteAssetsDir,
  siteIndexPath,
  slugForUrl,
  snapshotAssetName,
  stringifyCollection,
  stringifySite,
  TIRO_SCHEMA_VERSION,
} from "@tiro/shared";
import { readEveryCollection } from "./collections-read.ts";
import {
  commitFiles,
  createBlob,
  existingIndexFrom,
  type FetchLike,
  findExistingAt,
} from "./github.ts";
import type { TiroExtensionConfig } from "./storage.ts";

/**
 * Saving a page as a site (ADR 0055): a screenshot of what the reader was
 * looking at, the page's title and description, and their note, committed to
 * `sites/<slug>/` — beside, never over, an article of the same page.
 */

export interface SiteInput {
  /** The tab's address, exactly. The site is filed under it normalized, and
   * keeps it as `tiro.source_url` when that dropped something — a view's
   * fragment — so "open site" goes back to the view that was saved. */
  url: string;
  title: string;
  /** The page's own description of itself, if it gives one. */
  description?: string;
  /** Why the reader kept it. */
  note?: string;
  /** The page's text, as the clipper read it: context for the processor's
   * introduction, never shown. */
  markdown: string;
  clippedAt: string;
  clipperVersion: string;
  clipperCommit?: string;
}

/** The screenshot: its id — the first 12 hex digits of its bytes' SHA-256,
 * a figure snapshot's name (ADR 0039) — and the image. */
export interface SiteShot {
  id: string;
  bytes: Uint8Array;
}

export interface SiteFile {
  slug: string;
  path: string;
  content: string;
  title: string;
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** The site's `index.md`, validated through the shared schema — the write
 * half of the contract, as `buildClipFile` is for an article. */
export async function buildSiteFile(
  input: SiteInput & {
    /** The screenshot's id; its file is `<id>.webp` in the site's assets. */
    shotId: string;
    /** Carried from the site this save replaces (ADR 0017). */
    unlisted?: boolean;
  },
): Promise<SiteFile> {
  const url = normalizeUrl(input.url);
  const domain = new URL(url).hostname;
  const title = present(input.title) ?? domain;
  const description = present(input.description);
  // A note keeps its line breaks: it is the reader's, typed in a box.
  const note = input.note?.trim() === "" ? undefined : input.note?.trim();
  const frontmatter = SiteClipFrontmatterSchema.parse({
    url,
    title,
    domain,
    clipped_at: input.clippedAt,
    ...(description !== undefined ? { description } : {}),
    preview: previewRef(snapshotAssetName(input.shotId)),
    ...(note !== undefined ? { note } : {}),
    ...(input.unlisted === true ? { unlisted: true } : {}),
    tiro: {
      schema: TIRO_SCHEMA_VERSION,
      ...(input.clipperVersion !== ""
        ? { clipper_version: input.clipperVersion }
        : {}),
      ...(input.clipperCommit !== undefined && input.clipperCommit !== ""
        ? { clipper_commit: input.clipperCommit }
        : {}),
      ...(input.url !== url ? { source_url: input.url } : {}),
    },
  });
  const slug = await slugForUrl(input.url);
  return {
    slug,
    path: siteIndexPath(slug),
    content: stringifySite(frontmatter, input.markdown),
    title,
  };
}

/** What the vault already holds as this page's site: enough to say a save
 * updates it, and to offer its note again — the one thing a re-save cannot
 * regenerate. */
export interface FoundSite {
  note: string | null;
}

/**
 * The site saved at this page's slug, or null when there is none.
 *
 * Read through `findExistingAt`, which refuses frontmatter it cannot read
 * rather than calling the site absent: offered nothing, the reader would
 * save over a note they wrote without seeing it.
 */
export async function lookupSite(
  config: TiroExtensionConfig,
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<FoundSite | null> {
  const slug = await slugForUrl(url);
  const found = await findExistingAt(config, siteIndexPath(slug), fetchImpl);
  if (found === null) return null;
  const frontmatter = readFrontmatterLoose(found.text);
  const note =
    frontmatter.kind === "ok" && typeof frontmatter.data.note === "string"
      ? frontmatter.data.note.trim()
      : "";
  return { note: note === "" ? null : note };
}

export interface CommittedSite {
  file: SiteFile;
  /** A site was already at this path, and the save replaced it. */
  updated: boolean;
}

/**
 * Commit a site: its `index.md` and its screenshot, as one commit — a page
 * naming a picture that is not there yet would show a broken one.
 *
 * Rebuilt against every head `commitFiles` tries, like a clip with pictures:
 * a commit landing in between may have hidden the site, and that flag has to
 * survive this save. The note is not carried — the reader was shown it and
 * sent back what they want kept. The old screenshot is left for the processor
 * to prune once nothing names it, which is how a re-clip's old pictures go.
 *
 * A collection whose hand-set cover is the old screenshot moves to the new one
 * in the same commit. Otherwise the processor's pruning would leave the cover
 * naming a file that is gone — not a rare stale cover, as an article's can be,
 * but the outcome of nearly every re-save, since a new picture is a new name.
 * A collection file that cannot be parsed is left as it is; `validate` reports
 * a cover it names that is gone.
 */
export async function commitSite(
  config: TiroExtensionConfig,
  input: SiteInput,
  shot: SiteShot,
  fetchImpl: FetchLike = fetch,
): Promise<CommittedSite> {
  const slug = await slugForUrl(input.url);
  const shotPath = `${siteAssetsDir(slug)}/${snapshotAssetName(shot.id)}`;
  const blob = await createBlob(config, shot.bytes, fetchImpl);
  const path = siteIndexPath(slug);
  let built = null as CommittedSite | null;
  await commitFiles(
    config,
    {
      build: async (reader) => {
        const text = await reader.read(path);
        const found = text === null ? null : existingIndexFrom(path, text);
        const file = await buildSiteFile({
          ...input,
          shotId: shot.id,
          unlisted: found?.unlisted,
        });
        built = { file, updated: text !== null };
        const covers =
          text === null
            ? []
            : await coversFollowing(reader, text, slug, shotPath);
        return {
          message:
            covers.length === 0
              ? `site: ${file.title}`
              : `site: ${file.title}\n\ncovers moved to the new picture: ${covers.map((c) => c.id).join(", ")}`,
          files: [
            { path: file.path, content: file.content },
            { path: shotPath, blob },
            ...covers.map((c) => ({ path: c.path, content: c.content })),
          ],
        };
      },
    },
    fetchImpl,
  );
  if (built === null) throw new Error("the site was never built");
  return built;
}

/**
 * The collections whose cover is the site's current screenshot, rewritten to
 * name `next` — the picture this save commits. Empty when the site had no
 * screenshot, or when the new one is the same file.
 */
async function coversFollowing(
  reader: Parameters<typeof readEveryCollection>[0],
  oldIndex: string,
  slug: string,
  next: string,
): Promise<{ id: string; path: string; content: string }[]> {
  const old = readFrontmatterLoose(oldIndex);
  const file =
    old.kind === "ok" && typeof old.data.preview === "string"
      ? previewFile(old.data.preview)
      : null;
  if (file === null) return [];
  const previous = `${siteAssetsDir(slug)}/${file}`;
  if (previous === next) return [];
  const { parsed } = await readEveryCollection(reader);
  return parsed
    .filter(({ collection }) => collection.frontmatter.cover === previous)
    .map(({ path, collection }) => ({
      id: collection.id,
      path,
      content: stringifyCollection(
        { ...collection.frontmatter, cover: next },
        collection.body,
      ),
    }));
}
