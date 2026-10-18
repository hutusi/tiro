# ADR 0049: Large vault images are served as resized copies

Status: accepted (2026-10). Amends ADR 0006 and ADR 0020, under which vault
images reached the site only as plain copies of the originals. The originals
are still published. Changes nothing in the vault or the document format, so
`tiro.schema` is unchanged.

## Context

The processor stores each article image as downloaded, up to 10 MB, and the
site served those bytes as they were. On 2026-10-18 the vault held 1,276
images totalling 319 MB. The median was 100 KB, but 141 were over 500 KB and
70 over 1 MB. The heaviest were 3–4 MB PNG screenshots and magazine
photographs, shown in a text column about 800 CSS pixels wide. A collection
card shows three images in 260 px tiles, and with originals one card cost
1–2 MB.

ADR 0020 removed the only image processing the site ever had, Astro's, and
for a good reason: it measured every image at build time, and one image it
could not measure failed every deploy. Whatever resizes images must not
bring that failure back.

## Decision

At build time, a large raster image gets a WebP copy at most 1600 px wide,
and the pages serve the copy in its place.

- **Which images.** PNG, JPEG and WebP over 300 KB, or wider than 1600 px.
  1600 px covers the text column at 2× density. GIF (animation), SVG and AVIF
  are left alone, and so is an animated WebP, which the encoder would cut to
  its first frame.
- **Kept only when it pays.** A copy that does not save at least a fifth of
  the original's bytes is not served. The original stays.
- **Where.** `scripts/copy-assets.ts --derivatives` encodes with sharp at
  quality 80, auto-oriented by EXIF, and writes `<file>.1600.webp` beside the
  original in `public/vault-assets/<slug>/`. It records each copy and its
  pixel size in `.tiro/assets.json`. Only the `build` script passes the flag
  and names the manifest (`TIRO_ASSET_MANIFEST`). Dev and tests serve
  originals, so a test's output never depends on whether a build ran on this
  machine.
- **Who uses it.** The renderer's image pass (`render.ts`) swaps an
  article image's `src` for its copy and takes `width`/`height` from the
  copy. `CollectionCover` swaps its tiles. The social card keeps the original,
  for crawlers that do not read WebP. The copy's src is the original's with
  the suffix appended, so an escaped character in a filename stays escaped.
- **Never fatal.** An image that fails to encode warns and is served as it
  is. If sharp cannot load at all, every image is served as it is. Either
  way the build carries on. This is ADR 0020's rule, kept: one image costs at
  most its own bytes, never the deploy.
- **Cached by content.** Copies are cached in `apps/site/.tiro/derivatives/`,
  keyed by a hash of the original's bytes, under a directory named for the
  encoding settings. Changing a setting starts a fresh directory and removes
  the old one. Copies the vault no longer uses are pruned. The deploy
  restores the cache before building and saves it right after, so a deploy
  encodes only images it has not seen. It saves only when something was
  encoded.

## Measured

Against the live vault on 2026-10-19:

- 297 images got a copy; 38 more were candidates whose copy did not pay.
- Those 297 went from 203 MB to 29 MB (86% less). Every article image as
  served went from 319 MB to 145 MB.
- The heaviest original, a 4.2 MB PNG, became a 245 KB WebP.
- Encoding all of them took 10 s on a laptop. With the cache warm the asset
  step took under a second, and the whole build 52 s.
- A text-heavy screenshot compared at 1:1 showed no visible difference.

## Rejected

- **Re-encoding in the processor, as images are downloaded.** It would
  shrink the vault too, but it replaces the archived original with a lossy
  copy, for good, and needs a one-off rewrite of every existing article. The
  vault is the knowledge base; the site is one way of reading it.
- **Cloudflare's image transformations.** No build step, and AVIF for free,
  but it ties every picture on the site to a zone setting and a monthly
  quota. When either lapses, every image breaks at once, which is ADR 0020's
  failure mode moved to the edge.
- **`<picture>` with several widths.** The copy is already a fraction of the
  original. A second width would double the files for the small part of a
  small page.

## Consequences

- A deploy uploads two files for a resized image, though only the copy is
  linked. The original stays reachable at its old URL, so nothing that
  linked to it breaks. The build has about 4,200 files, well under Cloudflare
  Pages' per-deployment limit.
- `sharp` becomes a direct dependency of the site. It was already installed,
  as Astro's optional dependency, with prebuilt binaries for the platforms
  the deploy and local builds use.
- The first deploy after this change encodes every candidate, about 10 s of
  work. Later deploys encode only new images.
