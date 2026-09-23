import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type ArticleFrontmatter,
  isValidCollectionId,
  type ParsedCollection,
  parseArticle,
  parseCollection,
} from "@tiro/shared";
import { vaultDir } from "./vault.ts";

export interface VaultEntry {
  /** The directory name, which is the article's whole identity (ADR 0007). */
  slug: string;
  frontmatter: ArticleFrontmatter;
  body: string;
  /** `zh.md` verbatim, or null when the article has no translation yet. */
  zhBody: string | null;
}

let cache: VaultEntry[] | null = null;
let cacheSignature: string | null = null;
let collectionCache: ParsedCollection[] | null = null;
let collectionCacheSignature: string | null = null;

/** A build reads the vault once; `astro dev` has to notice edits. NODE_ENV is
 * "production" during `astro build` and "development" under `astro dev`, and is
 * readable both here and from `astro.config.mjs` — unlike `import.meta.env`,
 * which does not exist when the config imports this module directly. */
const REVALIDATE = process.env.NODE_ENV !== "production";

function stamp(parts: string[], path: string): void {
  try {
    const stat = statSync(path);
    parts.push(`${path}:${stat.mtimeMs}:${stat.size}`);
  } catch {
    // Absent is a state worth noticing too — a deleted zh.md changes it.
  }
}

/**
 * Cheap proof the vault has not changed: every article's and collection's
 * mtime and size, no file contents. ~100 stats, only in dev.
 *
 * One signature covers both readers rather than one each. A collection edit
 * then also invalidates the article memo, which costs a re-read in dev and
 * nothing in a build — against the alternative of two signatures that can
 * disagree about which vault they describe.
 */
function vaultSignature(base: string): string {
  const parts: string[] = [];
  const articlesDir = join(base, "articles");
  for (const dirent of readdirSync(articlesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    for (const file of ["index.md", "zh.md"]) {
      stamp(parts, join(articlesDir, dirent.name, file));
    }
  }
  for (const path of collectionFiles(base)) stamp(parts, path);
  return parts.join("\n");
}

/** Absolute paths of the vault's collection files, sorted, or none at all —
 * a vault that has never had a collection simply has no directory. */
function collectionFiles(base: string): string[] {
  const dir = join(base, "collections");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".md"))
    .map((dirent) => join(dir, dirent.name))
    .sort();
}

/**
 * Every article in the vault, read straight off the filesystem.
 *
 * This is the site's **only** reader of the vault (ADR 0020). It used to go
 * through Astro's content layer, which supplied none of what the site needs —
 * no schema (the shared Zod contract validates here), no rendering
 * (`render.ts` does that), no asset handling (ADR 0006 copies them) — while
 * insisting on work the site actively could not use: it rendered every
 * article's markdown to collect the images it references, then measured each
 * one. A single asset it could not measure took down the whole build, and one
 * 30-byte tracking pixel blocked every deploy for four hours.
 *
 * Reading the files is also what collapses the site's two readers of the
 * contract into one. The sitemap could never use the content layer — it is
 * configured in `astro.config.mjs`, which is evaluated before that layer
 * exists — so `unlisted-slugs.ts` already did exactly this, separately.
 *
 * Synchronous on purpose: `sitemap({ filter })` is sync, and this is the same
 * whole-vault read that helper already performed. Memoized, because both that
 * filter and every page build ask for it.
 *
 * Throws on unparseable frontmatter, naming the file. The build would fail on
 * it a moment later regardless; failing here with the path is the better error.
 */
export function readVault(): VaultEntry[] {
  const base = vaultDir();
  const articlesDir = join(base, "articles");
  let signature: string | null = null;
  if (REVALIDATE) {
    signature = vaultSignature(base);
    // Returning the *same array reference* is what lets callers memoize off it
    // without repeating this check — see `getAllArticles`.
    if (cache !== null && signature === cacheSignature) return cache;
  } else if (cache !== null) {
    return cache;
  }
  const entries: VaultEntry[] = [];

  for (const dirent of readdirSync(articlesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const slug = dirent.name;
    const indexPath = join(articlesDir, slug, "index.md");
    if (!existsSync(indexPath)) continue; // not an article; the old glob skipped it too

    let parsed: ReturnType<typeof parseArticle>;
    try {
      parsed = parseArticle(readFileSync(indexPath, "utf8"));
    } catch (error) {
      throw new Error(`${indexPath}: ${(error as Error).message}`);
    }

    // zh.md is a body and nothing else — the processor never writes frontmatter
    // into it (0 of 101 in the live vault). Read verbatim rather than through a
    // frontmatter splitter, which would eat a translation that happens to open
    // with a thematic break.
    const zhPath = join(articlesDir, slug, "zh.md");
    entries.push({
      slug,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      zhBody: existsSync(zhPath) ? readFileSync(zhPath, "utf8") : null,
    });
  }

  // Committed only now. Storing it above would mean that a read which threw
  // still recorded the broken vault as "seen": the next read would match the
  // signature and hand back the pre-edit articles, so a malformed article would
  // report itself once and then serve stale content as though it were fixed.
  cacheSignature = signature;
  cache = entries;
  return entries;
}

/**
 * Every collection in the vault (ADR 0029), read the same way and from the
 * same module, because ADR 0020's point is that the site has *one* reader of
 * the vault — a second one would be a second place for the guards, the memo
 * and the dev signature to drift.
 *
 * A vault with no `collections/` has no collections; that is the state every
 * vault starts in, not an error. A collection file that cannot be parsed, or
 * one named something that cannot be a route, does throw — the same call a
 * malformed article gets. Skipping it silently would drop a curated list from
 * the site and report success.
 */
export function readCollections(): ParsedCollection[] {
  const base = vaultDir();
  let signature: string | null = null;
  if (REVALIDATE) {
    signature = vaultSignature(base);
    if (collectionCache !== null && signature === collectionCacheSignature) {
      return collectionCache;
    }
  } else if (collectionCache !== null) {
    return collectionCache;
  }

  const entries: ParsedCollection[] = [];
  for (const path of collectionFiles(base)) {
    const id = basename(path, ".md");
    if (!isValidCollectionId(id)) {
      throw new Error(
        `${path}: not a usable collection id — expected lowercase ascii words joined by single dashes`,
      );
    }
    try {
      entries.push(parseCollection(id, readFileSync(path, "utf8")));
    } catch (error) {
      throw new Error(`${path}: ${(error as Error).message}`);
    }
  }

  // Committed only after every file parsed, for the reason `readVault` gives.
  collectionCacheSignature = signature;
  collectionCache = entries;
  return entries;
}

/** Drop the memo, for a test that writes a vault and reads it back. Dev picks
 * changes up through the signature above; nothing needs to call this to make
 * the dev server notice an edit. */
export function resetVaultCache(): void {
  cache = null;
  cacheSignature = null;
  collectionCache = null;
  collectionCacheSignature = null;
}
