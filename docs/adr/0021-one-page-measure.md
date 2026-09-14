# ADR 0021: One page measure — the chrome aligns with the content

Status: accepted (2026-09). Supersedes the *sticky toolbar under a sticky
header* half of ADR 0014's reader description; everything else in ADR 0014
stands — the palette, the type pairing, the reader's grid rows, the two reading
measures and which of them is on the Settings dial.

## Context

Three complaints about the layout, measured at a 1920px viewport with the
Settings width on 宽:

- The article text began at **x=293** while the toolbar's 返回 sat at **x=40**
  and the header logo at **x=61**. On the home page the gap was 332px; on
  `/settings/` it was **592px**.
- Two sticky bars stacked above every article — the site header (56px) and the
  reader's toolbar (~41px) — about 97px of chrome. At 390px the toolbar wraps,
  so it was **146px**, worst where there is least room.
- A suggestion to centre the view/font controls in the toolbar.

The cause of the first was that `<header>`'s inner bar was the **only**
full-bleed element on the site. `<main>` and `<footer>` already centred
themselves on `--w-library`, so the footer lined up with the content and the
header did not. That reads as an accident rather than as a deliberate
full-width bar — which is exactly what it was.

Underneath it: there was no container primitive. The centring string was
copy-pasted in four places, and `--gutter` existed only inside `.reader` as a
hand-rolled mirror of `px-4 sm:px-6 lg:px-10`. Every band decided its own left
edge independently, so they disagreed.

## Decision

- **`--w-page` is what every horizontal band measures**, and `.measure` is the
  one class that applies it: the header bar, `main`, the footer, and on an
  article the reader's toolbar and text. `--gutter` moves to `:root` in rem, the
  units Tailwind's own utilities emit, so the two cannot drift apart.

- **A page's measure is its own.** `--w-library` for lists, and on an article
  the measure of the text being shown — `--w-reader` in 中文/原文,
  `--w-reader-wide` in 左右对照. `data-page` and `data-paired` are
  server-rendered onto `<html>` because the header renders outside the article,
  where `.reader[data-paired]` is not visible; with `data-reader-mode` already
  set pre-paint, every branch resolves before the first frame. JavaScript off
  falls to the single-column measure, which is the layout the pane rules fall
  back to anyway.

- **The settings page keeps the library-width header** and narrows only its own
  column to `--w-narrow`. A 680px header would strand the logo 613px from the
  edge and squeeze four nav items, Star and three paper dots into ~600px, and it
  would shift on every navigation to and from Settings. `privacy.astro` and
  `404.astro` already put a narrow column inside a library-width main; this is
  that idea lifted to the layout rather than an exception to it.

- **On an article the site header is not sticky**; the toolbar takes the top.
  One bar while reading, the nav back at the top of the page, and 返回 as the way
  out from anywhere between. This is the clause that supersedes ADR 0014.

- **The view and font controls stay left-aligned**, on the article's left edge,
  rather than centred. Once the toolbar shares the text's measure they already
  sit above the text they act on, which is what centring was reaching for.
  Centred, they float with a dead gap after 返回 — and in 左右对照 the page centre
  *is* the gutter between the two columns, so they would hover over the seam.

- **The toolbar is two elements.** The rule and the paper must span the viewport
  or the page shows through the gutters as it scrolls underneath, while the
  controls stop where the text does. The sticky shell keeps
  `data-pagefind-ignore`, which still covers everything inside it.

## Consequences

- **The header is no longer a full-width bar anywhere.** On the home page the
  logo moves from x=40 to x=472. This is the most visible diff in the change.

- **Switching 左右对照 ↔ 中文 moves the header and footer too**, in the same paint
  as the text; before, only the article's own bands moved. Everything moving as
  one column reads as intentional where one thing moving reads as a bug. The
  alternative — pinning the chrome to the wide measure — re-breaks alignment in
  中文, so this was a genuine either/or rather than a free choice.

- **The header's left edge differs between pages** (home 472 → article 372 →
  article in 中文 592, at 1920 and the standard width). These are full document
  loads, so nothing animates: it is a differently centred page, not a jump.

- **The share controls are hidden below 688px.** A phone's browser carries a
  share control in its own chrome and the source link is in the title block and
  the end-note, so the page was repeating what is a tap away and paying a whole
  row of sticky toolbar for it — 90px rather than 51px, on the screens with
  least room. What is genuinely lost is the short link, the one thing those
  buttons carry that the browser's share cannot: it sends whatever is in the
  address bar, which is the long URL. Accepted, because on a phone you reach
  for the browser's share anyway. The breakpoint is measured, not picked — it
  is where the controls stop wrapping — so it tracks their combined width and
  wants re-measuring if a label changes. Hiding only some of them was checked
  first and saves nothing: the first row already fills the bar, so any
  surviving chip wraps regardless.

- **A long domain no longer fits** beside the other controls at the
  single-column measure — 28 of the vault's 102 articles have one over 17
  characters — so the domain chip is capped at 16ch and ellipsizes, with the
  full value in `aria-label` and `title`.

- `--header-h` is gone; the toolbar's sticky offset was its only consumer.

- An in-page anchor still lands under the sticky toolbar. Pre-existing, and
  strictly better than before: one ~40px bar instead of two ~96px. Not fixed
  here.

## Rejected

- **Centring the controls** — see above.
- **Freezing the header at `--w-library` sitewide.** It would fix the toolbar
  and leave the logo misaligned with the article text, which was the original
  complaint.
- **Merging the toolbar into the site header** on article pages. One row rather
  than two, but it mixes global chrome with per-article controls, makes the
  header's contents page-dependent, and wraps badly on a narrow screen.
