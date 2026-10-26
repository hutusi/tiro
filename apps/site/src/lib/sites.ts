/**
 * Saved sites (ADR 0055): pages kept as a picture and a description rather
 * than as text. They have their own gallery and their own pages, and they
 * appear beside articles wherever a list is about a topic rather than about
 * reading — tags, categories, collections, search.
 *
 * A site and an article of the same URL share a slug and nothing else. That
 * is why everything here speaks of `ref` — `sites/<slug>`, the form the vault
 * itself names a site by — wherever a site meets something keyed by slug.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareInstants,
  previewFile,
  type SiteFrontmatter,
  siteRef,
} from "@tiro/shared";
import type { Article } from "./articles.ts";
import { type ImageSize, imageSize } from "./image-size.ts";
import { vaultDir } from "./vault.ts";
import { readSites } from "./vault-read.ts";
import { isUnlisted } from "./visibility.ts";

export interface Site {
  slug: string;
  /** `sites/<slug>`: how a collection, a cover and the clipper name it. */
  ref: string;
  frontmatter: SiteFrontmatter;
}

/** One entry of a list that holds both kinds, in the list's own order. */
export type Member =
  | { kind: "article"; article: Article }
  | { kind: "site"; site: Site };

let cache: Site[] | null = null;
let listedCache: Site[] | null = null;
let cacheSource: unknown = null;

/**
 * Every site, unlisted ones included, newest first — for the site's own page,
 * which must still build for an unlisted one (ADR 0017). Every list reads
 * `getSites` instead.
 *
 * No guard against there being none: an empty `sites/` is how every vault
 * starts, and the articles guard already catches a wrong vault path.
 */
export function getAllSites(): Site[] {
  const entries = readSites();
  if (cache !== null && cacheSource === entries) return cache;
  cacheSource = entries;
  listedCache = null;
  const sites = entries.map(
    (entry): Site => ({
      slug: entry.slug,
      ref: siteRef(entry.slug),
      frontmatter: entry.frontmatter,
    }),
  );
  sites.sort((a, b) =>
    compareInstants(b.frontmatter.clipped_at, a.frontmatter.clipped_at),
  );
  cache = sites;
  return sites;
}

/** The sites every list is built from — unlisted ones removed, as
 * `getArticles` does for articles. */
export function getSites(): Site[] {
  const all = getAllSites();
  listedCache ??= all.filter((site) => !isUnlisted(site.frontmatter));
  return listedCache;
}

export function siteUrl(site: Site): string {
  return `/sites/${site.slug}/`;
}

/** The gallery's page `page`; page 1 is `/sites/`. */
export function sitesPageUrl(page: number): string {
  return page <= 1 ? "/sites/" : `/sites/page/${page}/`;
}

/**
 * Where "open the site" goes: the exact address that was saved, which keeps a
 * single-page app's view in its fragment, else the site's URL.
 *
 * Only ever an http(s) address. Both values come from the vault, which a hand
 * edit reaches, and this one becomes an `href` on a public page; a
 * `javascript:` URL there would run in the site's origin. Nothing the
 * extension writes is anything else, so refusing costs no real site a link.
 */
export function siteHref(site: Site): string | null {
  for (const candidate of [
    site.frontmatter.tiro.source_url,
    site.frontmatter.url,
  ]) {
    if (candidate === undefined) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") {
        return url.href;
      }
    } catch {
      // Not a URL; try the next.
    }
  }
  return null;
}

/** The screenshot's public path, or null for a site saved without one. It is
 * copied to `/vault-assets/sites/<slug>/`, which no article's path can be:
 * an article slug always ends in its hash, so it is never `sites`. */
export function previewSrc(site: Site): string | null {
  const file = previewFile(site.frontmatter.preview);
  return file === null ? null : `/vault-assets/${site.ref}/${file}`;
}

/** The screenshot's pixel size, read from its header, or null when there is
 * none to read — so the site page can reserve its box before it loads. */
export function previewSize(site: Site): ImageSize | null {
  const file = previewFile(site.frontmatter.preview);
  if (file === null) return null;
  try {
    return imageSize(
      readFileSync(join(vaultDir(), "sites", site.slug, "assets", file)),
    );
  } catch {
    return null;
  }
}
