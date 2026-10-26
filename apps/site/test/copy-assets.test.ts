import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  CACHE_VERSION,
  cacheKey,
  copyAssets,
  isAnimatedPng,
} from "../scripts/copy-assets.ts";
import { resetAssetManifest, servedCopy } from "../src/lib/asset-manifest.ts";

let root: string;
let articlesDir: string;
const warn = spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tiro-copy-assets-"));
  articlesDir = join(root, "vault/articles");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.TIRO_ASSET_MANIFEST;
  resetAssetManifest();
  warn.mockClear();
});

function asset(slug: string, file: string, bytes: Uint8Array): void {
  const dir = join(articlesDir, slug, "assets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), bytes);
}

/** A photo-like image: random noise, which PNG cannot shrink and WebP can. */
async function photo(width: number, height: number): Promise<Uint8Array> {
  const pixels = new Uint8Array(width * height * 3);
  // getRandomValues fills at most 64 KiB at a time.
  for (let at = 0; at < pixels.length; at += 65536) {
    crypto.getRandomValues(pixels.subarray(at, at + 65536));
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** The PNG made animated, as an APNG encoder writes it: an `acTL` chunk
 * (two frames, looping) between `IHDR` and the image data. */
function animate(png: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(20);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 8);
  chunk.set(new TextEncoder().encode("acTL"), 4);
  view.setUint32(8, 2);
  view.setUint32(12, 0);
  view.setUint32(16, Bun.hash.crc32(chunk.subarray(4, 16)));
  // Signature (8) and IHDR (25) come first.
  return new Uint8Array([
    ...png.subarray(0, 33),
    ...chunk,
    ...png.subarray(33),
  ]);
}

function options(derive = true) {
  return {
    articlesDir,
    outRoot: join(root, "public/vault-assets"),
    derive,
    cacheDir: join(root, ".tiro/derivatives"),
    manifestPath: join(root, ".tiro/assets.json"),
  };
}

function manifest(): Record<string, { width: number; height: number }> {
  return JSON.parse(readFileSync(join(root, ".tiro/assets.json"), "utf8"));
}

describe("copyAssets", () => {
  test("a wide image gets a 1600px WebP copy beside its original", async () => {
    asset("a", "wide.png", await photo(2400, 1200));
    const result = await copyAssets(options());

    const out = join(root, "public/vault-assets/a");
    expect(readdirSync(out).sort()).toEqual(["wide.png", "wide.png.1600.webp"]);
    const copy = await sharp(join(out, "wide.png.1600.webp")).metadata();
    expect([copy.format, copy.width, copy.height]).toEqual(["webp", 1600, 800]);
    expect(manifest()).toEqual({ "a/wide.png": { width: 1600, height: 800 } });
    expect(result).toMatchObject({ copied: 1, encoded: 1, derived: 1 });
  });

  test("a small image and a non-raster one are only copied", async () => {
    asset("a", "small.png", await photo(64, 64));
    asset("a", "logo.svg", new TextEncoder().encode("<svg/>"));
    const result = await copyAssets(options());
    expect(readdirSync(join(root, "public/vault-assets/a")).sort()).toEqual([
      "logo.svg",
      "small.png",
    ]);
    expect(manifest()).toEqual({});
    expect(result).toMatchObject({ copied: 2, encoded: 0, derived: 0 });
  });

  test("a second run takes the copy from the cache", async () => {
    asset("a", "wide.png", await photo(2400, 1200));
    await copyAssets(options());
    const again = await copyAssets(options());
    expect(again).toMatchObject({ encoded: 0, derived: 1 });
    expect(
      existsSync(join(root, "public/vault-assets/a/wide.png.1600.webp")),
    ).toBe(true);
  });

  test("the cache drops copies the vault no longer has", async () => {
    asset("a", "wide.png", await photo(2400, 1200));
    await copyAssets(options());
    rmSync(join(articlesDir, "a"), { recursive: true });
    asset("b", "small.png", await photo(64, 64));
    await copyAssets(options());
    const cached = readdirSync(join(root, ".tiro/derivatives"), {
      recursive: true,
    }).filter((name) => String(name).endsWith(".webp"));
    expect(cached).toEqual([]);
  });

  // ADR 0020's lesson: one image must never fail the deploy.
  test("an image that will not encode is served as it is", async () => {
    const broken = new Uint8Array(400 * 1024);
    broken.set([0x89, 0x50, 0x4e, 0x47]);
    asset("a", "broken.png", broken);
    asset("a", "wide.png", await photo(2400, 1200));
    const result = await copyAssets(options());
    expect(Object.keys(manifest())).toEqual(["a/wide.png"]);
    expect(result).toMatchObject({ copied: 2, derived: 1 });
    expect(warn).toHaveBeenCalled();
  });

  // libvips decodes an APNG's first frame and reports no `pages` for it, so
  // only the chunk check stops a still copy replacing the animation.
  test("an animated PNG keeps its original", async () => {
    asset("a", "moving.png", animate(await photo(2400, 1200)));
    const result = await copyAssets(options());
    expect(readdirSync(join(root, "public/vault-assets/a"))).toEqual([
      "moving.png",
    ]);
    expect(manifest()).toEqual({});
    expect(result).toMatchObject({ copied: 1, derived: 0 });
  });

  // The animation check used to run only when an image was encoded, so a
  // still copy cached before the check existed was served on every later
  // build. Whether an image gets a copy is now decided before the cache.
  test("a still copy already in the cache is not served for an animation", async () => {
    const moving = animate(await photo(2400, 1200));
    asset("a", "moving.png", moving);
    // The cache as a build without the check left it.
    const versionDir = join(root, ".tiro/derivatives", CACHE_VERSION);
    mkdirSync(versionDir, { recursive: true });
    const key = cacheKey(moving);
    writeFileSync(
      join(versionDir, `${key}.webp`),
      await sharp(await photo(1600, 800))
        .webp()
        .toBuffer(),
    );
    writeFileSync(
      join(versionDir, "index.json"),
      JSON.stringify({ [key]: { width: 1600, height: 800 } }),
    );

    const result = await copyAssets(options());
    expect(readdirSync(join(root, "public/vault-assets/a"))).toEqual([
      "moving.png",
    ]);
    expect(manifest()).toEqual({});
    expect(result).toMatchObject({ derived: 0 });
    // And the stale copy is pruned rather than kept for the next build.
    expect(existsSync(join(versionDir, `${key}.webp`))).toBe(false);
  });

  test("without sharp, every image is served full size", async () => {
    asset("a", "wide.png", await photo(2400, 1200));
    const result = await copyAssets({
      ...options(),
      loadSharp: async () => {
        throw new Error("no prebuilt binary for this platform");
      },
    });
    expect(manifest()).toEqual({});
    expect(result).toMatchObject({ copied: 1, derived: 0 });
  });

  test("dev copies only, and writes no manifest", async () => {
    asset("a", "wide.png", await photo(2400, 1200));
    await copyAssets(options(false));
    expect(readdirSync(join(root, "public/vault-assets/a"))).toEqual([
      "wide.png",
    ]);
    expect(existsSync(join(root, ".tiro/assets.json"))).toBe(false);
  });
});

describe("servedCopy", () => {
  test("serves the copy the manifest names, keeping the src's escaping", async () => {
    asset("a", "photo#one.png", await photo(2400, 1200));
    await copyAssets(options());
    process.env.TIRO_ASSET_MANIFEST = join(root, ".tiro/assets.json");
    resetAssetManifest();
    expect(servedCopy("/vault-assets/a/photo%23one.png")).toEqual({
      src: "/vault-assets/a/photo%23one.png.1600.webp",
      width: 1600,
      height: 800,
    });
    expect(servedCopy("/vault-assets/a/other.png")).toBeNull();
    expect(servedCopy("https://example.com/a.png")).toBeNull();
  });

  test("serves originals when no manifest is named", () => {
    expect(servedCopy("/vault-assets/a/wide.png")).toBeNull();
  });
});

describe("isAnimatedPng", () => {
  test("finds acTL before the image data, and nothing in a still PNG", async () => {
    const still = await photo(16, 16);
    expect(isAnimatedPng(still)).toBe(false);
    expect(isAnimatedPng(animate(still))).toBe(true);
    // Not a PNG at all, and a PNG cut short inside its first chunk.
    expect(isAnimatedPng(new TextEncoder().encode("GIF89a........"))).toBe(
      false,
    );
    expect(isAnimatedPng(still.subarray(0, 20))).toBe(false);
  });
});

/** ADR 0055: a saved site's screenshot, beside the articles' assets. */
describe("copyAssets, for saved sites", () => {
  test("copies a site's screenshot under sites/<slug>/, apart from the article of its slug", async () => {
    asset("same-1234abcd", "0123456789ab.webp", new Uint8Array([1, 2, 3]));
    const sitesDir = join(root, "vault/sites");
    mkdirSync(join(sitesDir, "same-1234abcd", "assets"), { recursive: true });
    writeFileSync(
      join(sitesDir, "same-1234abcd", "assets", "0123456789ab.webp"),
      new Uint8Array([4, 5, 6]),
    );
    const result = await copyAssets({ ...options(false), sitesDir });
    expect(result.copied).toBe(2);
    const out = join(root, "public/vault-assets");
    expect([
      ...readFileSync(join(out, "same-1234abcd", "0123456789ab.webp")),
    ]).toEqual([1, 2, 3]);
    expect([
      ...readFileSync(join(out, "sites", "same-1234abcd", "0123456789ab.webp")),
    ]).toEqual([4, 5, 6]);
  });

  test("a vault with no sites directory copies its articles as before", async () => {
    asset("a", "x.png", new Uint8Array([1]));
    const result = await copyAssets({
      ...options(false),
      sitesDir: join(root, "vault/sites"),
    });
    expect(result.copied).toBe(1);
  });

  test("a heavy screenshot gets a copy the site page serves", async () => {
    mkdirSync(articlesDir, { recursive: true });
    const sitesDir = join(root, "vault/sites");
    mkdirSync(join(sitesDir, "m-1234abcd", "assets"), { recursive: true });
    writeFileSync(
      join(sitesDir, "m-1234abcd", "assets", "wide.png"),
      await photo(2400, 1200),
    );
    await copyAssets({ ...options(), sitesDir });
    expect(manifest()["sites/m-1234abcd/wide.png"]).toEqual({
      width: 1600,
      height: 800,
    });
    process.env.TIRO_ASSET_MANIFEST = join(root, ".tiro/assets.json");
    resetAssetManifest();
    expect(servedCopy("/vault-assets/sites/m-1234abcd/wide.png")).toEqual({
      src: "/vault-assets/sites/m-1234abcd/wide.png.1600.webp",
      width: 1600,
      height: 800,
    });
  });
});
