# Icon source

`icon.svg` and `../public/icons/icon-{16,32,48,128}.png` are **generated** —
by the site's brand script, so the toolbar icon and the site's favicon are one
mark and cannot drift. Do not hand-edit them; change the mark in
`apps/site/scripts/brand.ts` and run, from the repo root:

```sh
bun run --cwd apps/site brand
```

It writes the site's favicon, touch icon and social card, then these files.
`apps/site/brand/README.md` documents the recipe (opentype.js outlines
Spectral's "T" into a path; headless Chrome rasterizes a CSS-sized `<img>`) and
its one trap (never pass `--user-data-dir`).

The mark is the oxblood monogram of the Later Reader design (ADR 0014, the
popup in ADR 0015): a rounded square in `#8f2f2f` with a cream "T". Vite copies
`public/` into `dist/` on the first build pass, so the PNGs need no build
wiring; the manifest references them as `icons/icon-N.png`.

**The 128 is not rendered like the others.** It is the store and install icon,
and Chrome's listing guidance asks for 96×96 of artwork centred in the 128×128
canvas with 16 px of transparent padding on each side. The toolbar sizes stay
full-bleed, where padding would just make the icon look small. The store
compositions in `../store/` point at `icon.svg` rather than the PNG for exactly
that reason.

**On the letterform at 16 px.** The previous bookmark mark was chosen because
"at 16 px a letterform is mud"; the monogram is the design's call, and a bold
serif capital in a filled square survives the toolbar better than a lowercase
wordmark would. Check it against neighbouring extension icons after a rebuild
— if it ever reads badly, the answer is a heavier or larger T in
`brand.ts`, not a return to the bookmark.

Two failure modes of the rasterizer worth knowing, because neither returns a
non-zero exit code: a malformed SVG screenshots Chrome's XML error page into
the icon, and a viewport/artwork mismatch yields a crop or a blank file. So
look at the output rather than trusting the command:

```sh
file apps/extension/public/icons/*.png   # expect exact 16/32/48/128 squares
open apps/extension/public/icons/icon-16.png
```
