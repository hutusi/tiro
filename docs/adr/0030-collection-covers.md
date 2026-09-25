# ADR 0030: A collection's cover is built from its members, and can be pinned by path

Status: accepted (2026-09). Extends ADR 0029; nothing in it is reversed.

## Context

ADR 0029 gave collections a title, an optional description and an ordered
list, and the site showed them as a text list. The owner wanted them to read
as shelves: a picture, a line about what the shelf is for, and a gallery.

A picture has to come from somewhere, and each obvious source has a cost:

- **A new required field** makes every collection a small chore, including
  the one the clipper creates on the first tick, and it is the clipper that
  creates most of them.
- **A URL** is one line for the owner, but the site is public and a hotlinked
  image breaks, silently, the day its host moves it. It also tells that host
  who viewed the page.
- **The members' own images** are already in the vault, already copied to
  `/vault-assets/`, and cost nothing to maintain. In the live vault 94 of 178
  articles reference a local image, and every member of every live collection
  has one. But an article's first image is often not a picture: the live vault
  opens articles with 40–96px author avatars, badges, spacers and 7:1 page
  banners.

## Decision

### Derived by default, pinned by an asset path

The cover is a list of 0–3 images:

1. **A hand-set `cover:`** wins, as its one image:

   ```yaml
   cover: "articles/<slug>/assets/<file>"
   ```

   It is a vault path to an existing article asset, not a URL, so `validate`
   can check it. It may name any article's asset, not only a member's. The
   schema holds both halves to the alphabet the pipeline writes (loosened only
   enough for a hand-placed file name), so the path cannot climb out of
   `assets/`.
2. **Otherwise the members' lead images**, in the owner's order, up to three:
   one fills the cover, two split it, and three make a mosaic of one large tile
   and two stacked.
3. **Otherwise nothing**, which the gallery draws as the title's first
   character on ruled paper. That is a valid cover, not a missing one.

It is optional and additive, so `tiro.schema` stays 1 (ADR 0002). It still has
to be *declared* in the shared schema, although only a person writes it: the
clipper parses a collection before rewriting it and zod drops undeclared keys,
so an undeclared `cover` would be erased by the next toggle. The collections
clipper had not been released when this landed, so no shipped build can
strip it.

### A lead image is measured, cheaply

An article's lead image is the first local image the article *renders* that
meets the rules below. The images are read off the renderer's own sanitized
tree, not the markdown source. A regex over the source missed an `<img>` in raw
HTML (the processor localizes those as well as markdown images) and an alt text
containing brackets, and it picked up a reference quoted inside a code block,
which renders as text. An image qualifies when it:

- is a JPEG, PNG, WebP or AVIF. SVG and GIF are never picked automatically:
  clipped SVGs are mostly line art on a transparent ground, which reads as a
  blank tile when cropped, and one moving tile pulls the eye off a grid of
  still ones. A hand-set cover may be either.
- is served. It must exist and be under the size `copy-assets` skips.
- has a shorter side of at least 150px, and is no more than 3:1.

A byte threshold was tried first and failed calibration. lithub's real 300×172
figure weighs 5.7 KB and pbs's 64×82 avatar weighs 7.5 KB, so no byte count
separates them. So `apps/site/src/lib/image-size.ts` reads pixel dimensions
from PNG, JPEG and WebP headers. It matched `sips` on all 631 such images in
the live vault. Bytes (at least 5 KB) remain the fallback only for what it
cannot read, such as AVIF.

This is not the measurement ADR 0020 removed. There, one unmeasurable asset
failed every deploy. Here nothing can fail a build: an unreadable image just
stops being a candidate.

### Only listed articles lend a picture

The cover's image path carries the article's slug. On a public list page, that
names the article, which is the enumeration ADR 0017 removes. So:

- an unlisted member lends no lead image
- a hand-set cover naming an unlisted article is ignored
- `validate` reports a hand-set cover naming an unlisted article

### A pinned cover must be something the site can show

The schema checks only the path's shape. Being an image the site will publish
is checked by `validate` and by the site, so a wrong file blocks neither the
build nor the clipper. That means an image extension (JPEG, PNG, WebP, AVIF,
GIF or SVG), a regular file, and no larger than the 20 MiB `copy-assets`
publishes. The limit lives in `@tiro/shared` as `MAX_SERVED_ASSET_BYTES`, so
`validate` and the copy cannot disagree about it.

### The site degrades, `validate` refuses

A hand-set cover can go stale: its article can be deleted, or a re-clip can
prune the very asset the owner picked. The site never fails a build over it.
It warns and shows the cover it would have built anyway. `validate` is the gate
that reports it: a missing article, a missing or non-image file, one too large
to publish, or an unlisted article. This is the same split as a dangling member
(ADR 0029).

`sweep --recanonicalize` rewrites a cover pointing into a moved article's
`assets/` in the same write as the memberships. It does so whether or not that
article is a member, since the cover may name any article.

### Where it shows

- **`/collections/`**: a card gallery with the cover at 16:10, the title, the
  description clamped to two lines, and a meta line.
- **A collection page**: the cover as a 3:1 banner (2:1 on a phone), but only
  when it has pictures. On the page, the typographic cover would restate the
  heading beneath it.
- **The page's `og:image`** is the cover's first image, so a shared link
  previews the shelf. A collection without pictures keeps the site card.

## Consequences

- The owner gets a gallery without touching a file. Pinning a cover or adding
  a description is a hand edit to `collections/<id>.md`. The clipper does not
  offer either, which keeps its disclosure and queue unchanged.
- Live covers are mostly diagrams and figures, not photos, because that is
  what the vault clips. `object-fit: cover` crops them, sometimes through a
  label. A pinned cover is the remedy for a collection whose derived one reads
  badly.
- A small image passing the 150px floor is upscaled in a large tile and looks
  soft. The floor is a judgment about what counts as a picture, not about
  sharpness. Raising it trades softness for more typographic covers.
