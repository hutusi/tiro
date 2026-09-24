/**
 * Collection covers (ADR 0030): the images a collection is shown with.
 *
 * A cover is a list of 0–3 public image paths. One hand-set `cover:` gives one;
 * otherwise it is built from the members' own lead images; and none at all is a
 * valid answer that the page draws as a typographic cover. Nothing here ever
 * fails a build — a cover is decoration, and `validate` is what refuses a bad
 * one (the same split as a dangling member).
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseCoverPath } from "@tiro/shared";
import type { Article } from "./articles.ts";
import { imageSize } from "./image-size.ts";
import { MAX_ASSET_BYTES, vaultDir } from "./vault.ts";

/** A mosaic has room for three: one large, two stacked. */
export const MAX_COVER_IMAGES = 3;

/**
 * What an image must be to be picked automatically: big enough to be a
 * picture and not a strip. Calibrated on the live vault, whose first images
 * include 40–96px author avatars and badges (under the side) and 7:1 page
 * banners that a 16:10 crop turns into a smear (over the ratio).
 */
export const MIN_COVER_SIDE = 150;
export const MAX_COVER_RATIO = 3;

/**
 * The fallback when the header cannot be read (AVIF, or anything
 * `imageSize` does not know): a byte count, which still rejects the tracking
 * pixel and the spacer. Never the first test, because on disk a 300px photo
 * and a 64px avatar can weigh the same — the live vault has both at ~6 KB.
 */
export const MIN_COVER_BYTES = 5 * 1024;

/**
 * Formats a picked cover may be. SVG is left out because clipped SVGs are
 * mostly diagrams and line art on a transparent ground, which read as blank
 * tiles when cropped; GIF because a moving tile in a grid of still ones pulls
 * the eye from everything else. A hand-set cover may still be either.
 */
const PHOTO_EXT = /\.(?:jpe?g|png|webp|avif)$/i;

/** Every localized image reference in a body, in order. The processor writes
 * them as exactly `./assets/<file>` (see `renderBlockHtml`). */
const ASSET_IMAGE_RE = /!\[[^\]]*\]\(\.\/assets\/([^\s)]+)/g;

function publicAsset(slug: string, file: string): string {
  return `/vault-assets/${slug}/${file}`;
}

/** The asset's size, or null when it is not a servable file — missing, or over
 * the limit `copy-assets` skips, so it would never reach `/vault-assets/`. */
function servableSize(slug: string, file: string): number | null {
  try {
    const stat = statSync(join(vaultDir(), "articles", slug, "assets", file));
    if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) return null;
    return stat.size;
  } catch {
    return null;
  }
}

function decodeFile(file: string): string {
  try {
    return decodeURIComponent(file);
  } catch {
    return file;
  }
}

function worthACover(slug: string, file: string): boolean {
  const bytes = servableSize(slug, file);
  if (bytes === null) return false;
  let size: ReturnType<typeof imageSize>;
  try {
    size = imageSize(
      readFileSync(join(vaultDir(), "articles", slug, "assets", file)),
    );
  } catch {
    return false;
  }
  if (size === null) return bytes >= MIN_COVER_BYTES;
  const short = Math.min(size.width, size.height);
  const long = Math.max(size.width, size.height);
  return short >= MIN_COVER_SIDE && long <= short * MAX_COVER_RATIO;
}

/** Keyed on the article object, which `articles.ts` replaces when the vault
 * changes — so a dev edit is picked up without a second invalidation path. */
const leadCache = new WeakMap<Article, string | null>();

/**
 * An article's lead image: the first local image in its body worth putting on
 * a cover, as a public path, or null if it has none.
 *
 * The first one that qualifies rather than the first one: an article often
 * opens with an avatar, a badge or a banner, and the picture that stands for
 * it comes a little later.
 */
export function leadImage(article: Article): string | null {
  const cached = leadCache.get(article);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  for (const match of article.body.matchAll(ASSET_IMAGE_RE)) {
    const file = decodeFile(match[1] ?? "");
    if (!PHOTO_EXT.test(file) || file.includes("/")) continue;
    if (!worthACover(article.slug, file)) continue;
    found = publicAsset(article.slug, file);
    break;
  }
  leadCache.set(article, found);
  return found;
}

/**
 * The images a collection is shown with.
 *
 * - A hand-set `cover:` wins, as its one image — but only if it names a listed
 *   article's asset that will actually be served. An unlisted article's asset
 *   would put its slug on a public list page, which is the enumeration ADR 0017
 *   removes, so that cover is ignored just as a missing one is.
 * - Otherwise the lead images of the listed members, in the owner's order,
 *   up to three. `members` is the listed join, so an unlisted member never
 *   lends a picture for the same reason.
 * - Otherwise nothing, and the page draws the typographic cover.
 *
 * `listed` is every listed article, not only members: a cover may name any.
 */
export function coverImages(
  id: string,
  cover: string | undefined,
  members: readonly Article[],
  listed: ReadonlySet<string>,
): string[] {
  if (cover !== undefined) {
    const target = parseCoverPath(cover);
    if (
      target !== null &&
      listed.has(target.slug) &&
      servableSize(target.slug, target.file) !== null
    ) {
      return [publicAsset(target.slug, target.file)];
    }
    console.warn(
      `collections/${id}.md: cover ${cover} is not a listed article's asset; using the members' images instead`,
    );
  }
  const images: string[] = [];
  for (const article of members) {
    const image = leadImage(article);
    if (image === null || images.includes(image)) continue;
    images.push(image);
    if (images.length === MAX_COVER_IMAGES) break;
  }
  return images;
}
