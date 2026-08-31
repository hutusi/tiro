import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";

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
  get(blockText: string): string | undefined;
  set(blockText: string, translation: string): void;
  /** Write pending entries. Called after every batch, so a hard kill costs at
   * most one batch of work. No-op when nothing changed. */
  flush(): Promise<void>;
  /** Drop the checkpoint — the article is finished and needs it no longer. */
  discard(): Promise<void>;
}

function keyFor(blockText: string): string {
  return createHash("sha256").update(blockText).digest("hex");
}

export async function loadTranslationCache(
  pathAbs: string,
  header: CacheHeader,
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
      raw.blocks !== null
    ) {
      blocks = { ...(raw.blocks as Record<string, string>) };
    }
  } catch {
    // Absent or corrupt checkpoint just means no resume, never a failure:
    // this is an optimisation, and the article translates fine without it.
  }

  const restored = Object.keys(blocks).length;
  let dirty = false;

  return {
    restored,
    get(blockText) {
      return blocks[keyFor(blockText)];
    },
    set(blockText, translation) {
      blocks[keyFor(blockText)] = translation;
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
      await Bun.write(pathAbs, `${JSON.stringify(file, null, 2)}\n`);
      dirty = false;
    },
    async discard() {
      blocks = {};
      dirty = false;
      await rm(pathAbs, { force: true });
    },
  };
}
