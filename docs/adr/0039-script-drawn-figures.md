# ADR 0039: A figure the page draws is described by default, and captured on request

Status: accepted (2026-10). Narrows ADR 0002's `assets/` ("images downloaded
by the processor"): the extension may now write there too. Touches neither
identity nor the document format, so `tiro.schema` is unchanged.

## Context

Some articles are built around figures their own script draws: a `<figure>`
whose content is a `<canvas>` filled by a bundle once it scrolls into view.
The one that prompted this, "How Machines Learned Precision", has 29 such
figures. A 1.5 MB Three.js bundle mounts them, and each is described by an
author-written `aria-label`. Clipped at 0.15.0:

- **Unmounted figures vanished.** Before its script runs a figure is an empty
  `<div>`; Readability turns it into a `<p>` and deletes it. The 4 captions
  survived as loose prose ("The figure runs three times slower than life.").
- **Mounted figures leaked their overlays.** Labels, narration and hints are
  HTML laid over the canvas, and they reached the article as stray paragraphs
  ("wooden pattern", "the core", "Ctrl + scroll to zoom").
- **The author's description was never read.**

Interactivity itself cannot be kept: the site runs no publisher script, and
invariant 5 is there to keep it that way. A still of each figure can be,
measured in Chrome:

- Each figure here is a 2D canvas fed by one shared WebGL renderer, so its
  pixels are readable, and a cropped screenshot of the tab holds all 29.
- The labels are HTML, not pixels. `canvas.toDataURL` loses them, and on a page
  using WebGL with `preserveDrawingBuffer: false` returns a blank image.
- Figures mount only once scrolled into view: 2 canvases on load, 40 after
  scrolling through. A read-it-later clip usually happens before reading.
- A still is one moment: one figure was caught mid-intro 1.5 s after mounting.

Two articles in a vault of 252 came from sites known for such figures. Rare,
but when it happens the figure — often the point of the article — is lost
without a trace.

## Decision

### 1. A script-drawn figure becomes a described link

A `<figure>` holding nothing but empty containers, or a `<canvas>` and the
chrome around it, plus at most one direct caption, becomes one block:

```
[Interactive figure](<page>[#id]): <aria-label, else title>
<caption>
```

- **Translated as prose**, and one block, so `zh.md` stays aligned (ADR 0003).
- **The link** is the article's normalized URL, plus the figure's `id` when it
  has one — the one place the figure still works.
- **Overlay text beside a canvas is chrome and is dropped**: "fallback text is
  never content", as for a video.
- **A figure with nothing to say or show** — no label, no caption, no canvas —
  is dropped, as it was before.

Which figures qualify is an allow-list (`isScriptDrawnFigure`). These keep
their earlier output:

- an image, picture or video;
- an `<svg>` with no canvas;
- quotes, code, math, noscript images;
- text of its own outside the caption;
- an attribute Readability's `_fixLazyImages` would turn into an `<img>`;
- a background image;
- a third-party embed loading a `<script src>`, which was the one false
  positive the corpus sweep found (a Buzzsprout player).

The pass mirrors the video pair:

- **Before Readability**, the slot is replaced by a `<span>` holding the label
  between private-use marks. It is a span because a figure Readability renames
  to `<div>` meets `_cleanConditionally`, which measures only text inside
  SPAN/P/DIV.
- **After Readability**, `scriptFiguresIn` finds the figure by
  `data-tiro-figure`, never by tag, and builds the paragraph.
- **Only children change**, so Readability's hidden checks on the figure stand.

This works wherever the clip runs, including the processor's saved-link path,
which sees only the empty shell.

### 2. A picture of it, when the reader asks

For a tab body with such figures, the popup offers "Capture N figures":

1. Scroll the tab to each figure, centred, with `behavior: "instant"`.
2. Wait for something inside it to be laid out, then settle about 1.2 s.
3. Take the visible tab with `captureVisibleTab` and crop it to the parts of
   the figure that hold the drawing (not its caption, not a separate controls
   row).
4. Encode the crop as WebP, at most 1,600 px wide and 1.5 MB.
5. Re-clip the tab with the pictures in place of the links.
6. Put the reader's scroll back.

**Never automatic.** It moves the page for about two seconds a figure.

**Refused rather than taken badly**, leaving the figure a link:

- a figure with nothing drawn in it — a slot whose script never ran, or a
  canvas that comes out one flat colour;
- a figure taller or wider than the viewport;
- a figure with something on top of it, such as a sticky header or a banner;
- a page that reflows under the picture twice;
- a picture over budget: 1.5 MB each, 20 MB for the clip.

**It stops when the tab is no longer the active one.** `captureVisibleTab`
takes whatever tab is visible.

**A watchdog restores the scroll** if the popup closes mid-capture.

**Permissions.** `captureVisibleTab` rides the `activeTab` grant the toolbar
click already gives. No new permission is requested. The disclosure gains a
sentence: capture is a new kind of page data reaching the vault.

### 3. The extension may write into `assets/`

A captured figure becomes `[![label](./assets/<id>.webp)](page)` and its
caption beneath; with no caption, the label, since alt text reaches no reader.
That is the shape the fold builds for an image, so the processor and the site
handle it with no change.

The file is `<id>.webp`, where `id` is the first 12 hex digits of SHA-256 of
the bytes. That is the processor's own asset name, on purpose: `reconcileAssets`
considers only that shape. So a snapshot is kept while `index.md` names it, and
pruned once a re-clip without a capture no longer does.

`index.md` and its snapshots land in one Git Data API commit. Blobs are
uploaded first, once, outside the commit's retry cycle. A body naming a file
not yet written would publish a broken image, and a commit per file would be
a push, a processing run and a deploy each. A clip without snapshots is the
same one-file PUT as before.

### 4. How a figure is named across runs

A figure's index is its place among the page's `<figure>`s as the clip
received them, and the payload lists the indices of the drawn figures
(`scriptFigures`).

- **Element identity carries it between clips.** `clipper.js` leaves the live
  figure list in the extension's isolated world, the scout frames those very
  elements, and the re-clip maps the request onto its own list by element.
  A figure the page re-rendered in between is not found and stays a link, so
  one figure's picture can never land over another's caption.
- **The snapshot id crosses Readability bare**, on `data-tiro-snapshot`: an
  attribute ending in `.webp` would make `_fixLazyImages` add a page-absolute
  `<img>`.
- **The relative path is written after Readability**, which would otherwise
  make it absolute.
- **Page-authored markers are stripped.** Only the extension's own map writes
  them.
- **The re-clip must come from the page on screen.** The clipper gives each
  document a random id in the isolated world, and a navigation starts a new
  world. The popup takes a capture's clip only when it carries the same
  document id *and* the same address as the body on screen, and checks the
  tab's address before re-clipping at all. A reload is a new document; an
  infinite scroll that rewrites the address is a new address. Either way the
  original body stands, with its links, rather than another article being
  saved under this one's Clip.

## Rejected

- **`data:` URIs in the markdown.** The site's sanitizer drops them, the
  processor skips them, and the translator would be handed the base64.
- **Capturing on every clip.** It scrolls the page for tens of seconds.
- **`canvas.toDataURL`.** It loses the HTML overlays, and is blank for WebGL
  without `preserveDrawingBuffer`.
- **The service worker owning the loop.** The popup already holds the
  activeTab grant and a DOM for the crop; the worker has neither need nor
  business seeing page pixels.
- **One Contents API PUT per file.** N commits, N processing runs, N deploys.
- **An index-only map between runs, or stamping the live page.** The first
  puts the wrong picture over a caption when mount state shifts the count; the
  second edits the page the reader is using.

## Consequences

- A captured figure costs 13–41 KB measured, and the commit grows by about
  100 KB a figure at most.
- **A re-clip without capture goes back to links**, and the processor prunes
  the old snapshots. To keep pictures, capture again.
- **A snapshot is one frame** of an animation, at the reader's window size and
  device pixel ratio.
- **Capture is checked only live.** The sweep and the unit tests cover the
  placeholder and the DOM transform; the scroll, the screenshot and the crop
  need a real browser.
- **Out of scope:**
  - bare canvases with no `<figure>` round them (Bartosz Ciechanowski's
    articles);
  - `[role=figure]`;
  - a caption reached through `aria-labelledby`;
  - figures taller than the viewport.
