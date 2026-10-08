import {
  assetsDir,
  indexPath,
  slugForUrl,
  snapshotAssetName,
} from "@tiro/shared";
import { buildClipFile, type ClipFile, type ClipInput } from "./clip.ts";
import {
  commitFiles,
  createBlob,
  type ExistingIndex,
  encodeBase64Utf8,
  existingIndexFrom,
  type FetchLike,
  findExistingIndex,
  putFile,
} from "./github.ts";
import type { TiroExtensionConfig } from "./storage.ts";

/** A figure snapshot the clip's markdown names (ADR 0039): its id, which is
 * also its file name, and the image itself. */
export interface Snapshot {
  id: string;
  bytes: Uint8Array;
}

export interface CommitClipOptions {
  /** Snapshots to commit beside `index.md`. Only those the markdown names
   * belong here; the caller decides, since it holds the payload. */
  snapshots?: readonly Snapshot[];
  /** Told as each snapshot finishes uploading. */
  onUpload?: (done: number, total: number) => void;
}

export interface CommittedClip {
  file: ClipFile;
  /** An article was already at this path, and the clip replaced it. */
  updated: boolean;
}

/** Uploads at a time. Enough to hide each request's latency, few enough that
 * GitHub's secondary rate limit on content creation never notices. */
const UPLOAD_CONCURRENCY = 3;

/**
 * Commit one clip to the vault: its `index.md`, and with it any figure
 * snapshots the body names.
 *
 * Without snapshots this is the one Contents API PUT a clip has always been —
 * the path every clip but a captured one takes, kept exactly as it was. With
 * them, the files have to land as one commit: a body naming
 * `./assets/<id>.webp` before the file is there would publish a broken image,
 * and each extra commit would be one more push, workflow run and deploy.
 */
export async function commitClip(
  config: TiroExtensionConfig,
  clip: Omit<ClipInput, "unlisted">,
  options: CommitClipOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<CommittedClip> {
  // The lookup comes first now: the flat layout makes the slug — and so
  // the path — derivable without building the file, and a re-clip has to
  // read the old article's `unlisted` flag before it rebuilds `index.md`
  // over it (ADR 0017).
  const slug = await slugForUrl(clip.url);
  const snapshots = options.snapshots ?? [];
  return snapshots.length === 0
    ? commitIndex(config, clip, slug, fetchImpl)
    : commitWithSnapshots(config, clip, slug, snapshots, options, fetchImpl);
}

/**
 * A stub must not replace a body that is already there.
 *
 * A PDF clip carries no body and bets that the next processing run
 * builds one. Written over a converted article that bet costs the
 * article: if the fetch then fails, or the source has 404'd since, the
 * Markdown is gone from the vault's current state and this stage
 * cannot regenerate it — unlike an HTML re-clip, which replaces
 * content with content. So the old body rides along until a
 * conversion actually succeeds, and a failed reconversion costs
 * freshness instead (ADR 0026).
 *
 * Read from the same lookup `unlisted` uses, and carried on the same
 * principle: a re-clip rebuilds index.md from scratch, so anything it
 * cannot regenerate has to be carried or it is dropped.
 */
function rebuild(
  clip: Omit<ClipInput, "unlisted">,
  found: Pick<ExistingIndex, "unlisted" | "body"> | null,
): Promise<ClipFile> {
  const stub = clip.sourceMedia === "pdf";
  return buildClipFile({
    ...clip,
    ...(stub && found !== null ? { markdown: found.body } : {}),
    unlisted: found?.unlisted,
  });
}

async function commitIndex(
  config: TiroExtensionConfig,
  clip: Omit<ClipInput, "unlisted">,
  slug: string,
  fetchImpl: FetchLike,
): Promise<CommittedClip> {
  const existing = await findExistingIndex(config, slug, fetchImpl);
  const file = await rebuild(clip, existing);
  await putFile(
    config,
    {
      path: file.path,
      contentBase64: encodeBase64Utf8(file.content),
      message: `clip: ${file.title}`,
      ...(existing !== null ? { sha: existing.sha } : {}),
      // A stale sha means something committed to this article between the
      // lookup above and this PUT. Retrying the bytes already built would
      // overwrite whatever it did — including, if it was a hand-edit
      // hiding the article, the `unlisted` flag this clip read as absent.
      // So the retry redoes the lookup and rebuilds against the answer.
      resolveConflict: async () => {
        const again = await findExistingIndex(config, slug, fetchImpl);
        const rebuilt = await rebuild(clip, again);
        return {
          ...(again !== null ? { sha: again.sha } : {}),
          contentBase64: encodeBase64Utf8(rebuilt.content),
        };
      },
    },
    fetchImpl,
  );
  return { file, updated: existing !== null };
}

async function commitWithSnapshots(
  config: TiroExtensionConfig,
  clip: Omit<ClipInput, "unlisted">,
  slug: string,
  snapshots: readonly Snapshot[],
  options: CommitClipOptions,
  fetchImpl: FetchLike,
): Promise<CommittedClip> {
  // Named — and so validated — before anything is uploaded: an id that is
  // not a snapshot's would otherwise become a path in the vault.
  const named = snapshots.map((snapshot) => ({
    path: `${assetsDir(slug)}/${snapshotAssetName(snapshot.id)}`,
    bytes: snapshot.bytes,
  }));
  const shas = new Array<string>(named.length);
  let done = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < named.length) {
      const index = next++;
      const item = named[index];
      if (item === undefined) continue;
      shas[index] = await createBlob(config, item.bytes, fetchImpl);
      done += 1;
      options.onUpload?.(done, named.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, named.length) }, worker),
  );

  // Rebuilt on every attempt against the head it will parent on, which is
  // what `putFile`'s conflict retry does for the one-file path: a commit
  // landing in between may have hidden the article, and the flag it set has
  // to survive this one.
  let built = null as CommittedClip | null;
  const path = indexPath(slug);
  await commitFiles(
    config,
    {
      build: async (reader) => {
        const text = await reader.read(path);
        const found = text === null ? null : existingIndexFrom(path, text);
        const file = await rebuild(clip, found);
        built = { file, updated: text !== null };
        return {
          message: `clip: ${file.title}`,
          files: [
            { path: file.path, content: file.content },
            ...named.map((item, index) => ({
              path: item.path,
              blob: shas[index] ?? "",
            })),
          ],
        };
      },
    },
    fetchImpl,
  );
  if (built === null) throw new Error("the clip was never built");
  return built;
}
