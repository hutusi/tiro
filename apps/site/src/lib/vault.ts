import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Where the vault content lives. Defaults to the in-repo fixture vault so
 * local dev needs no vault clone; deploys set TIRO_VAULT_DIR to a checkout
 * of tiro-vault. Asserting existence up front guards against Astro's
 * silent-empty-collection failure mode on a bad glob base (ADR 0006).
 */
export function vaultDir(): string {
  const configured = process.env.TIRO_VAULT_DIR;
  const dir =
    configured !== undefined && configured !== ""
      ? resolve(configured)
      : resolve(import.meta.dirname, "../../../../fixtures/vault");
  if (!existsSync(`${dir}/articles`)) {
    throw new Error(
      `TIRO_VAULT_DIR does not look like a vault (no articles/ directory): ${dir}`,
    );
  }
  return dir;
}
