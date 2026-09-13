import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ArticleFrontmatter, parseArticle } from "@tiro/shared";
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

/** A build reads the vault once; `astro dev` has to notice edits. NODE_ENV is
 * "production" during `astro build` and "development" under `astro dev`, and is
 * readable both here and from `astro.config.mjs` — unlike `import.meta.env`,
 * which does not exist when the config imports this module directly. */
const REVALIDATE = process.env.NODE_ENV !== "production";

/** Cheap proof the vault has not changed: every article's mtime and size, no
 * file contents. ~100 stats, only in dev. */
function vaultSignature(articlesDir: string): string {
  const parts: string[] = [];
  for (const dirent of readdirSync(articlesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    for (const file of ["index.md", "zh.md"]) {
      const path = join(articlesDir, dirent.name, file);
      try {
        const stat = statSync(path);
        parts.push(`${path}:${stat.mtimeMs}:${stat.size}`);
      } catch {
        // Absent is a state worth noticing too — a deleted zh.md changes it.
      }
    }
  }
  return parts.join("\n");
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
  const articlesDir = join(vaultDir(), "articles");
  if (cache !== null) {
    if (!REVALIDATE) return cache;
    const signature = vaultSignature(articlesDir);
    // Returning the *same array reference* is what lets callers memoize off it
    // without repeating this check — see `getAllArticles`.
    if (signature === cacheSignature) return cache;
    cacheSignature = signature;
  } else if (REVALIDATE) {
    cacheSignature = vaultSignature(articlesDir);
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

  cache = entries;
  return entries;
}

/** Drop the memo, for a test that writes a vault and reads it back. Dev picks
 * changes up through the signature above; nothing needs to call this to make
 * the dev server notice an edit. */
export function resetVaultCache(): void {
  cache = null;
  cacheSignature = null;
}
