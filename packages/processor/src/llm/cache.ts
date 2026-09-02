import { createHash } from "node:crypto";
import { rename, rm } from "node:fs/promises";

/**
 * Checkpoint of already-translated blocks for one article (ADR 0008).
 *
 * Translation is the only stage that can outlive a run's budget, and it used
 * to keep everything in memory: a run killed at batch 12 of 14 threw away all
 * twelve and the next run started again at batch 1, so a long article could
 * never finish no matter how often it retried.
 *
 * Keyed by a hash of the block's source text rather than its index, so the
 * checkpoint survives a re-clip that edits or reorders part of the article —
 * every block whose source is byte-identical keeps its translation, and only
 * genuinely changed blocks are re-sent. That also makes reuse safe by
 * construction: a cached translation is only ever returned for exactly the
 * input that produced it.
 */

const CACHE_VERSION = 1;

/** Lives beside the article it belongs to. Dot-prefixed and JSON so it cannot
 * be mistaken for content: every reader in the system globs for `index.md` or
 * `zh.md`, and asset reconciliation only ever looks inside `assets/`. It is
 * processor-internal state, deliberately not part of the shared content
 * contract in `@tiro/shared/paths`. */
export const TRANSLATION_CACHE_FILE = ".tiro-zh-cache.json";

/** Staging path for the atomic write below. Cleaned up on load and on discard:
 * a crash between writing it and renaming it would otherwise leave litter the
 * workflow's `git add -A` commits. */
const tmpPathFor = (pathAbs: string): string => `${pathAbs}.tmp`;

/** Remove a checkpoint and any staging file beside it, without loading it
 * first. The pipeline needs this on every branch — including an article that
 * turned out to need no translation, which never loads a cache and so would
 * otherwise leave a killed run's `.tmp` for `git add -A` to commit. */
export async function discardTranslationCache(pathAbs: string): Promise<void> {
  await rm(pathAbs, { force: true });
  await rm(tmpPathFor(pathAbs), { force: true });
}

interface CacheFile {
  version: number;
  target: string;
  model: string;
  blocks: Record<string, string>;
}

export interface CacheHeader {
  target: string;
  model: string;
}

export interface TranslationCache {
  /** Number of blocks restored from disk at load time. */
  readonly restored: number;
  /** The error from the most recent failed write, or undefined while writes
   * succeed. Set means this checkpoint holds no durable progress, so a caller
   * about to rely on resuming from it must not pretend otherwise. */
  readonly writeError: unknown;
  get(blockText: string): string | undefined;
  set(blockText: string, translation: string): void;
  /** Write pending entries. Called after every batch, so a hard kill costs at
   * most one batch of work. No-op when nothing changed. */
  flush(): Promise<void>;
  /**
   * Forget every block the article no longer contains.
   *
   * Called once an article finishes, so the file that survives holds exactly
   * this article's translations rather than accumulating every version of
   * every paragraph it has ever had.
   */
  retain(blockTexts: readonly string[]): void;
  /**
   * Drop the checkpoint entirely.
   *
   * No longer what a finished article does — it keeps its work so a later
   * re-clip can reuse it (ADR 0010). This is for the outcomes where the stored
   * translations must not be reused: a misaligned result, an article that needs
   * no translation, and a `--force` redo of one that already finished.
   */
  discard(): Promise<void>;
}

function keyFor(blockText: string): string {
  return createHash("sha256").update(blockText).digest("hex");
}

export async function loadTranslationCache(
  pathAbs: string,
  header: CacheHeader,
  log: (message: string) => void = () => {},
): Promise<TranslationCache> {
  let blocks: Record<string, string> = {};
  try {
    const raw = (await Bun.file(pathAbs).json()) as Partial<CacheFile>;
    // A checkpoint written by a different model or for a different target
    // language would resume the article with translations this run would
    // never have produced. Drop it whole rather than blend two vintages —
    // this is also the escape hatch for "retranslate it properly": change the
    // model in tiro.yml and the stale checkpoint discards itself.
    if (
      raw.version === CACHE_VERSION &&
      raw.target === header.target &&
      raw.model === header.model &&
      typeof raw.blocks === "object" &&
      raw.blocks !== null &&
      // Values too, not just the shape. `{"<hash>": 42}` is valid JSON and
      // clears every other guard, but a non-string reaches the join in
      // translateBlocks as `translated[i].trim()` and throws — which escapes
      // processOne, leaves the article pending, and then throws again on every
      // later run from the very same file. A checkpoint that cannot be trusted
      // has to read as absent, never as a fault.
      Object.values(raw.blocks).every((v) => typeof v === "string")
    ) {
      blocks = { ...(raw.blocks as Record<string, string>) };
    }
  } catch {
    // Absent or corrupt checkpoint just means no resume, never a failure:
    // this is an optimisation, and the article translates fine without it.
  }
  // A staging file here is debris from a run killed mid-write. The rename
  // below never happened, so it holds nothing the checkpoint does not.
  // Non-fatal like everything else here: loading a checkpoint must never be
  // the reason an article fails.
  try {
    await rm(tmpPathFor(pathAbs), { force: true });
  } catch (error) {
    log(`could not clear checkpoint staging file: ${String(error)}`);
  }

  const restored = Object.keys(blocks).length;
  let dirty = false;
  let writeError: unknown;

  return {
    restored,
    get writeError() {
      return writeError;
    },
    get(blockText) {
      return blocks[keyFor(blockText)];
    },
    set(blockText, translation) {
      blocks[keyFor(blockText)] = translation;
      dirty = true;
    },
    retain(blockTexts) {
      const live = new Set(blockTexts.map(keyFor));
      const kept: Record<string, string> = {};
      for (const [key, value] of Object.entries(blocks)) {
        if (live.has(key)) kept[key] = value;
      }
      if (Object.keys(kept).length === Object.keys(blocks).length) return;
      blocks = kept;
      dirty = true;
    },
    async flush() {
      if (!dirty) return;
      const file: CacheFile = {
        version: CACHE_VERSION,
        target: header.target,
        model: header.model,
        blocks,
      };
      // Write-then-rename, not write-in-place. `timeout-minutes` kills the job
      // outright, and a kill partway through overwriting the live file leaves
      // truncated JSON that the next run reads as absent — so the article
      // starts from batch 1, in precisely the scenario the checkpoint exists
      // for. rename(2) within a directory is atomic: readers see the old
      // checkpoint or the new one, never half of either.
      const tmpAbs = tmpPathFor(pathAbs);
      try {
        await Bun.write(tmpAbs, `${JSON.stringify(file, null, 2)}\n`);
        await rename(tmpAbs, pathAbs);
        dirty = false;
        writeError = undefined;
      } catch (error) {
        // Not thrown, but not forgotten either. Failing here would kill an
        // article that may have no use for a checkpoint at all — one that fits
        // in a single run never reads it back. But an article that does not fit
        // depends on it entirely, so the failure is recorded and the caller
        // must consult `writeError` before claiming a resumable stop.
        writeError = error;
        log(`could not write checkpoint ${pathAbs}: ${String(error)}`);
      }
    },
    async discard() {
      blocks = {};
      dirty = false;
      await discardTranslationCache(pathAbs);
    },
  };
}
