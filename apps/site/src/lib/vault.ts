import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The largest vault asset the site will serve. Cloudflare Pages rejects files
 * over 25 MB; the processor caps downloads at 10 MB, so anything bigger is
 * unexpected. `copy-assets` skips it loudly, and a cover must never name one,
 * or it would point at a file that was never copied.
 */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/**
 * Where the vault content lives. Defaults to the in-repo fixture vault so
 * local dev needs no vault clone; deploys set TIRO_VAULT_DIR to a checkout
 * of tiro-vault. Asserting existence up front guards against Astro's
 * silent-empty-collection failure mode on a bad glob base (ADR 0006).
 */
/**
 * Find `fixtures/vault` by walking up from a starting directory.
 *
 * Not a fixed number of `..` segments: this module is imported by the page
 * graph now, so it is bundled into `dist/.prerender/chunks/` for the build and
 * `import.meta.dirname` is not where the source sits. Counting levels silently
 * produced `apps/fixtures/vault` and only the guard below caught it.
 */
function findFixtureVault(start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = resolve(dir, "fixtures/vault");
    if (existsSync(`${candidate}/articles`)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function vaultDir(): string {
  const configured = process.env.TIRO_VAULT_DIR;
  const dir =
    configured !== undefined && configured !== ""
      ? resolve(configured)
      : (findFixtureVault(import.meta.dirname) ??
        findFixtureVault(process.cwd()) ??
        resolve(import.meta.dirname, "../../../../fixtures/vault"));
  if (!existsSync(`${dir}/articles`)) {
    throw new Error(
      `TIRO_VAULT_DIR does not look like a vault (no articles/ directory): ${dir}`,
    );
  }
  return dir;
}
