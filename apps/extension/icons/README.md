# Icon source

`icon.svg` and `../public/icons/icon-{16,32,48,128}.png` are **generated** —
by the site's brand script, so the toolbar icon and the site's favicon are one
mark and cannot drift. Do not hand-edit them; change the mark in
`apps/site/scripts/brand.ts` and run, from the repo root:

```sh
bun run --cwd apps/site brand
```

It writes the site's favicon, touch icon and social card, then these files.
`apps/site/brand/README.md` documents the recipe (headless Chrome rasterizes a
CSS-sized `<img>`) and its one trap (never pass `--user-data-dir`).

The mark is the two-bar tile (ADR 0018, superseding the oxblood "T" monogram of
ADR 0014; the popup is ADR 0015): a cream rounded square carrying an ink bar and
an oxblood bar — the same pair the site header sets beside the wordmark. Vite
copies `public/` into `dist/` on the first build pass, so the PNGs need no build
wiring; the manifest references them as `icons/icon-N.png`.

**The 128 is not rendered like the others.** It is the store and install icon,
and Chrome's listing guidance asks for 96×96 of artwork centred in the 128×128
canvas with 16 px of transparent padding on each side. The toolbar sizes stay
full-bleed, where padding would just make the icon look small. The store
compositions in `../store/` point at `icon.svg` rather than the PNG for exactly
that reason.

**On legibility at 16 px.** This mark has no letterform to lose — two bars are
about the most robust thing there is at toolbar size, which is part of why it
won. What it can lose is its *ground*: the tile is cream, and on light chrome
that is a far weaker edge than the oxblood square it replaced. Measured at size,
the bars stay legible on both light and dark Chrome tab strips; on a white
active tab the tile effectively disappears and the bars stand alone, which is
the header treatment and reads as the mark rather than as damage. Check it
against neighbouring extension icons after a rebuild — if it ever stops reading,
the answer is a darker tile or a hairline border in `brand.ts`, not a
letterform.

Two failure modes of the rasterizer worth knowing, because neither returns a
non-zero exit code: a malformed SVG screenshots Chrome's XML error page into
the icon, and a viewport/artwork mismatch yields a crop or a blank file. So
look at the output rather than trusting the command:

```sh
file apps/extension/public/icons/*.png   # expect exact 16/32/48/128 squares
open apps/extension/public/icons/icon-16.png
```
