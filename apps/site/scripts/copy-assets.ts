#!/usr/bin/env bun
/**
 * Copy vault article assets into public/vault-assets/<year>/<slug>/ before
 * the Astro build. Vault images deliberately bypass Astro's image pipeline
 * (ADR 0006); this plain copy has no Astro-version risk and re-clips
 * overwrite cleanly.
 */
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { vaultDir } from "../src/lib/vault.ts";

// Cloudflare Pages rejects files over 25 MB; the processor caps downloads at
// 10 MB, so anything bigger here is unexpected — skip it loudly.
const MAX_BYTES = 20 * 1024 * 1024;

const articlesDir = `${vaultDir()}/articles`;
const outRoot = resolve(import.meta.dirname, "../public/vault-assets");

rmSync(outRoot, { recursive: true, force: true });

let copied = 0;
let skipped = 0;
for (const relPath of new Bun.Glob("*/*/assets/*").scanSync({
  cwd: articlesDir,
})) {
  const source = join(articlesDir, relPath);
  if (statSync(source).size > MAX_BYTES) {
    console.warn(`skipping oversized asset (> ${MAX_BYTES} bytes): ${relPath}`);
    skipped += 1;
    continue;
  }
  const [year, slug, , file] = relPath.split("/");
  if (year === undefined || slug === undefined || file === undefined) continue;
  const targetDir = join(outRoot, year, slug);
  mkdirSync(targetDir, { recursive: true });
  cpSync(source, join(targetDir, file));
  copied += 1;
}
console.log(
  `vault assets: ${copied} copied${skipped > 0 ? `, ${skipped} skipped` : ""}`,
);
