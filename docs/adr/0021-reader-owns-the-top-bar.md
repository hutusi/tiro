# ADR 0021: The article's toolbar owns the top bar; chrome stays viewport-fixed

Status: accepted (2026-09). Supersedes the *sticky toolbar under a sticky
header* half of ADR 0014's reader description; everything else in ADR 0014
stands — the palette, the type pairing, the reader's grid rows, the two reading
measures and which of them is on the Settings dial.

## Context

Three complaints about the layout, measured at a 1920px viewport:

- Two sticky bars stacked above every article — the site header (56px) and the
  reader's toolbar (~41px), about 97px of chrome. At 390px the toolbar wraps, so
  it was **146px**, worst where there is least room.
- The chrome did not line up with the content: article text at **x=293** while
  the toolbar's 返回 sat at **x=40** and the header logo at **x=61**. On
  `/settings/` the gap was **592px**.
- A suggestion to centre the view/font controls in the toolbar.

Underneath the second: there was no container primitive. The centring string was
copy-pasted in four places and `--gutter` existed only inside `.reader`, as a
hand-rolled mirror of `px-4 sm:px-6 lg:px-10`.

## Decision

- **On an article the site header is not sticky**; the toolbar takes the top.
  One bar while reading, the nav back at the top of the page, and 返回 as the way
  out from anywhere between. This is the clause that supersedes ADR 0014.

  `z-20` moves with `sticky` rather than staying behind: `<header>` is a flex
  item of `body`, and a flex item with a `z-index` other than `auto` builds a
  stacking context **even when `position: static`** — a static header keeping
  `z-20` would paint over the sticky toolbar on its way past.

- **The chrome stays at a fixed viewport gutter and does not follow the
  content.** The header bar and the reader's toolbar span the viewport; the
  footer stays pinned to `--w-library`. None of them moves between pages or when
  the reading mode changes.

  This was tried the other way first and reverted — see below. It leaves the
  original misalignment standing: the logo sits at x=40 while the home page's
  content starts at x=480. That is accepted as the price of chrome that holds
  still.

- **`--w-page` is the measure of a page's content column**, applied by
  `.measure`: `main` on list and settings pages, and the reader's title block,
  body and end-note, which follow the text being shown — `--w-reader` in
  中文/原文, `--w-reader-wide` in 左右对照. `--gutter` moves to `:root` in rem, the
  units Tailwind's own utilities emit, so the two cannot drift apart. This is
  what removes the four copies of the container string, and it survives the
  revert because the *content* measure was never the problem.

- **The view and font controls stay left-aligned** rather than centred. Mocked
  up and rejected: in 左右对照 the page centre *is* the gutter between the two
  text columns, so centred controls hover over the seam.

- **The share controls are hidden below 688px.** A phone's browser carries a
  share control in its own chrome, and the source link is in the title block and
  the end-note besides, so the page was repeating what is a tap away and paying
  a whole row of sticky toolbar for it — 90px rather than 51px. What is lost is
  the short link, the one thing those buttons carry that the browser's share
  cannot: it sends whatever is in the address bar, which is the long URL.
  Accepted, because on a phone you reach for the browser's share anyway.

  Hiding only some of them was measured first and saves nothing — the first row
  already fills the bar, so any surviving chip wraps regardless. It is all three
  or none. The breakpoint is measured, not picked: it is where these controls
  stop wrapping, so it tracks their combined width.

## Rejected: aligning the chrome to the content

Built, measured, lived with, and reverted. Every band — header, footer, toolbar,
text — took its left edge from `--w-page`, so they agreed on every page: logo,
返回, heading and footer all at 373 in 左右对照, all at 593 in 中文.

It read badly for a reason the measurements predicted but only use made
obvious. **A page's measure is not constant**, so chrome that follows it is not
either: the header's left edge moved between pages (home 472 → article 372 →
article in 中文 592) and, worse, moved *live* whenever the reading mode changed.
Chrome is the frame; a frame that shifts when the picture changes reads as
instability rather than as design, and the reading-mode toggle is a control
people use often.

The middle option — pinning the chrome to `--w-library` everywhere — keeps it
still and aligns it on the list pages, at the cost of being ~100px off the text
on an article. It was offered and not taken: the owner preferred the chrome to
sit at a fixed distance from both viewport edges, which is also what it did
before any of this.

So the alignment complaint is answered by *not* answering it, and the second and
third complaints are answered on their own terms. Worth knowing if it is ever
revisited: the machinery is still here. `--w-page` and `.measure` exist, and
putting `.measure` back on the header bar and the toolbar is a two-line change.

## Consequences

- **The chrome never moves.** Logo at x=40 and footer at x=480 on every page and
  in both reading modes; only the content column varies, which is the thing that
  is supposed to.
- **The original misalignment stands** — logo at 40, home content at 480. On an
  article the header scrolls away, so the two are rarely seen together.
- **A long domain still wraps the bar between 689px and 780px**, so the domain
  is capped at 16ch and ellipsized in that band only — above it the full domain
  shows, below it the controls are hidden. Full value in `title` and
  `aria-label`.
- **360px still wraps** to two rows: the mode toggle alone overflows there. Not
  something this can fix.
- `--header-h` is gone; the toolbar's sticky offset was its only consumer.
- An in-page anchor still lands under the sticky toolbar. Pre-existing, and
  strictly better than before: one ~50px bar instead of two ~96px.
