#!/usr/bin/env bun
/**
 * Copy vault article assets into public/vault-assets/<slug>/ before the
 * Astro build. Vault images deliberately bypass Astro's image pipeline
 * (ADR 0006); this plain copy has no Astro-version risk and re-clips
 * overwrite cleanly.
 *
 * With `--derivatives`, which the `build` script passes and `dev` does not, a
 * large raster image also gets a resized WebP copy beside it. The pages serve
 * that copy in its place (ADR 0049). The original is still published.
 * Encoding is per image and never fatal: an image that will not encode, or
 * whose copy would not be meaningfully smaller, is served as it is. If sharp
 * cannot load at all, every image is. One bad file must not fail a deploy,
 * which is the lesson of ADR 0020.
 *
 * Copies are cached by the original's content hash in `.tiro/derivatives/`,
 * which the deploy workflow keeps between runs, so a deploy encodes only the
 * images it has not seen.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MAX_SERVED_ASSET_BYTES } from "@tiro/shared";
import {
  type AssetManifest,
  DERIVED_WIDTH,
  type DerivedSize,
  derivedName,
} from "../src/lib/asset-manifest.ts";
import { imageSize } from "../src/lib/image-size.ts";
import { vaultDir } from "../src/lib/vault.ts";

/** An image this heavy is resized even when it is narrow enough. */
export const DERIVE_OVER_BYTES = 300 * 1024;
/** A copy must save at least this share of the original's bytes to be served. */
const MIN_SAVING = 0.2;
const QUALITY = 80;
/** Changing any encoding setting changes this, so old copies are not reused. */
const CACHE_VERSION = `w${DERIVED_WIDTH}-q${QUALITY}`;
const RASTER = /\.(?:png|jpe?g|webp)$/i;
const CONCURRENCY = 4;

type Sharp = typeof import("sharp").default;

/** What the cache remembers per original: the copy's size, or that no copy
 * was worth serving. A failed encode is not remembered; the next run tries
 * again. */
type CacheIndex = Record<string, DerivedSize | null>;

export interface CopyAssetsOptions {
  articlesDir: string;
  outRoot: string;
  /** Resize large images; needs the two paths below. */
  derive: boolean;
  cacheDir: string;
  manifestPath: string;
  /** Replaced only by tests. */
  loadSharp?: () => Promise<Sharp>;
}

export interface CopyAssetsResult {
  copied: number;
  skipped: number;
  /** Copies encoded this run. */
  encoded: number;
  /** Copies served, encoded now or taken from the cache. */
  derived: number;
}

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 24);
}

function readIndex(path: string): CacheIndex {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CacheIndex;
  } catch {
    return {};
  }
}

/** Is this image worth a copy at all? Decided from its byte count, or for a
 * light one from its header, before anything is encoded. A light file is read
 * whole, which is at most `DERIVE_OVER_BYTES`. */
function wantsCopy(file: string, path: string, bytes: number): boolean {
  if (!RASTER.test(file)) return false;
  if (bytes > DERIVE_OVER_BYTES) return true;
  const size = imageSize(readFileSync(path));
  return size !== null && size.width > DERIVED_WIDTH;
}

/**
 * Whether a PNG is animated (APNG): an `acTL` chunk before the first `IDAT`.
 * libvips decodes only an APNG's default image and reports no `pages` for
 * it, so the metadata check in `encode` cannot see the animation, and the
 * copy would be a still frame standing in for it.
 */
export function isAnimatedPng(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    // Length, type and CRC around the chunk's data.
    at += 12 + view.getUint32(at);
  }
  return false;
}

async function encode(
  sharp: Sharp,
  bytes: Uint8Array,
): Promise<{ data: Uint8Array; size: DerivedSize } | null> {
  // An animation would be cut to its first frame: an APNG, which libvips
  // does not report, and an animated WebP, which it does.
  if (isAnimatedPng(bytes)) return null;
  const meta = await sharp(bytes).metadata();
  if ((meta.pages ?? 1) > 1) return null;
  const { data, info } = await sharp(bytes)
    // Upright by its EXIF orientation, since the copy carries no EXIF.
    .rotate()
    .resize({ width: DERIVED_WIDTH, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer({ resolveWithObject: true });
  if (data.length > bytes.length * (1 - MIN_SAVING)) return null;
  return { data, size: { width: info.width, height: info.height } };
}

export async function copyAssets(
  options: CopyAssetsOptions,
): Promise<CopyAssetsResult> {
  const { articlesDir, outRoot, derive, cacheDir, manifestPath } = options;
  rmSync(outRoot, { recursive: true, force: true });

  const result: CopyAssetsResult = {
    copied: 0,
    skipped: 0,
    encoded: 0,
    derived: 0,
  };
  // Paths, not bytes: a vault's large images together run to hundreds of MB.
  const candidates: { slug: string; file: string; source: string }[] = [];

  for (const relPath of new Bun.Glob("*/assets/*").scanSync({
    cwd: articlesDir,
  })) {
    const source = join(articlesDir, relPath);
    const bytes = statSync(source).size;
    if (bytes > MAX_SERVED_ASSET_BYTES) {
      console.warn(
        `skipping oversized asset (> ${MAX_SERVED_ASSET_BYTES} bytes): ${relPath}`,
      );
      result.skipped += 1;
      continue;
    }
    const [slug, , file] = relPath.split("/");
    if (slug === undefined || file === undefined) continue;
    const targetDir = join(outRoot, slug);
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(source, join(targetDir, file));
    result.copied += 1;
    if (derive && wantsCopy(file, source, bytes)) {
      candidates.push({ slug, file, source });
    }
  }

  if (!derive) return result;

  const manifest: AssetManifest = {};
  const versionDir = join(cacheDir, CACHE_VERSION);
  const indexPath = join(versionDir, "index.json");
  const previous = readIndex(indexPath);
  const index: CacheIndex = {};
  let sharp: Sharp | null = null;
  if (candidates.length > 0) {
    try {
      sharp = await (
        options.loadSharp ?? (async () => (await import("sharp")).default)
      )();
    } catch (error) {
      console.warn(
        `sharp could not be loaded, so every image is served full size: ${(error as Error).message}`,
      );
    }
  }

  if (sharp !== null) {
    const encoder = sharp;
    mkdirSync(versionDir, { recursive: true });
    const work = candidates.map((candidate) => async () => {
      const { slug, file, source } = candidate;
      const bytes = readFileSync(source);
      const hash = hashOf(bytes);
      const cachedFile = join(versionDir, `${hash}.webp`);
      let size: DerivedSize | null | undefined = previous[hash];
      if (size !== undefined && size !== null && !existsSync(cachedFile)) {
        size = undefined;
      }
      if (size === undefined) {
        try {
          const made = await encode(encoder, bytes);
          size = made?.size ?? null;
          if (made !== null) writeFileSync(cachedFile, made.data);
          result.encoded += 1;
        } catch (error) {
          console.warn(
            `could not resize ${slug}/${file}; serving the original: ${(error as Error).message}`,
          );
          return;
        }
      }
      index[hash] = size;
      if (size === null) return;
      copyFileSync(cachedFile, join(outRoot, slug, derivedName(file)));
      manifest[`${slug}/${file}`] = size;
      result.derived += 1;
    });
    // A few at a time: sharp already spreads one image over several threads.
    let next = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < work.length) {
          const job = work[next];
          next += 1;
          await job?.();
        }
      }),
    );
  }

  // Keep only the copies this vault still uses, and only this version's. Not
  // after sharp failed to load: that run judged nothing, and the cache is
  // still good for the next one.
  if (sharp !== null || candidates.length === 0) {
    if (existsSync(versionDir)) {
      writeFileSync(indexPath, JSON.stringify(index));
      for (const entry of readdirSync(versionDir)) {
        const hash = entry.replace(/\.webp$/, "");
        if (entry.endsWith(".webp") && index[hash] == null) {
          rmSync(join(versionDir, entry));
        }
      }
    }
    if (existsSync(cacheDir)) {
      for (const entry of readdirSync(cacheDir)) {
        if (entry !== CACHE_VERSION) {
          rmSync(join(cacheDir, entry), { recursive: true, force: true });
        }
      }
    }
  }

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return result;
}

if (import.meta.main) {
  const siteRoot = resolve(import.meta.dirname, "..");
  const derive = process.argv.includes("--derivatives");
  const result = await copyAssets({
    articlesDir: `${vaultDir()}/articles`,
    outRoot: join(siteRoot, "public/vault-assets"),
    derive,
    cacheDir: join(siteRoot, ".tiro/derivatives"),
    manifestPath: join(siteRoot, ".tiro/assets.json"),
  });
  const parts = [`${result.copied} copied`];
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
  if (derive) {
    parts.push(
      `${result.derived} served resized (${result.encoded} encoded this run)`,
    );
  }
  console.log(`vault assets: ${parts.join(", ")}`);
  // Tells the deploy whether the cache gained anything worth saving.
  const output = process.env.GITHUB_OUTPUT;
  if (derive && output !== undefined && output !== "") {
    appendFileSync(output, `derivatives_encoded=${result.encoded}\n`);
  }
}
