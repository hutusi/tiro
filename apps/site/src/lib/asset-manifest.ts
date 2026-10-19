import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resized copies of large vault images (ADR 0049).
 *
 * `scripts/copy-assets.ts --derivatives` writes a WebP copy of each large
 * raster image beside the original, named `<file>.<DERIVED_WIDTH>.webp`. It
 * records each copy in a manifest, keyed `<slug>/<file>`, with the copy's own
 * pixel size. The pages serve the copy in the original's place.
 *
 * Only a build reads the manifest: the `build` script names it in
 * `TIRO_ASSET_MANIFEST`. With the variable unset (tests, `astro dev`) every
 * image is served as its original. A test's output therefore never depends
 * on whether this machine happened to run a build.
 */

export const DERIVED_WIDTH = 1600;

/** The copy's own size, which can differ from the original's header: an
 * EXIF-rotated JPEG is upright in the copy. */
export interface DerivedSize {
  width: number;
  height: number;
}

export type AssetManifest = Record<string, DerivedSize>;

/** The copy's filename, beside the original's. */
export function derivedName(file: string): string {
  return `${file}.${DERIVED_WIDTH}.webp`;
}

let loaded: Map<string, DerivedSize> | null = null;

function manifest(): Map<string, DerivedSize> {
  if (loaded !== null) return loaded;
  loaded = new Map();
  const path = process.env.TIRO_ASSET_MANIFEST;
  if (path === undefined || path === "") return loaded;
  try {
    const parsed = JSON.parse(
      readFileSync(resolve(path), "utf8"),
    ) as AssetManifest;
    for (const [key, size] of Object.entries(parsed)) loaded.set(key, size);
  } catch (error) {
    // The originals are all published, so a missing manifest costs speed,
    // never a picture.
    console.warn(
      `asset manifest ${path} could not be read; serving original images: ${(error as Error).message}`,
    );
  }
  return loaded;
}

/** Forget the loaded manifest, for a test that points the variable elsewhere. */
export function resetAssetManifest(): void {
  loaded = null;
}

const VAULT_ASSET = /^\/vault-assets\/([^/]+)\/([^/]+)$/;

/**
 * The resized copy to serve for a vault asset's public path, or null to serve
 * the original.
 *
 * The copy's src is the original's src with the suffix appended, not a path
 * rebuilt from the decoded name, so an escaped character stays escaped: a
 * rebuilt `photo#one.jpg` would read as a fragment.
 */
export function servedCopy(
  src: string,
): ({ src: string } & DerivedSize) | null {
  const match = VAULT_ASSET.exec(src);
  if (match === null) return null;
  let file: string;
  try {
    file = decodeURIComponent(match[2] ?? "");
  } catch {
    return null;
  }
  const size = manifest().get(`${match[1]}/${file}`);
  if (size === undefined) return null;
  return {
    src: `${src}.${DERIVED_WIDTH}.webp`,
    width: size.width,
    height: size.height,
  };
}
