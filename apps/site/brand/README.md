# Brand assets

The site's mark is the oxblood monogram from the "Later Reader" design
(ADR 0014): a rounded square in `#8f2f2f` carrying Spectral's "T" in cream.
The header and footer use the two-bar wordmark instead, which is inline HTML
(`.logo-bars` in `src/styles/global.css`) and needs no asset.

Everything in `public/` below is **generated and committed** — run
`bun run brand` from `apps/site` after changing the mark, then look at the
output before committing it.

| File | What | How it is made |
| --- | --- | --- |
| `favicon.svg` | The badge (radius 16 on a 72 box) | The "T" is outlined from `@fontsource/spectral`'s 600 WOFF with opentype.js into a `<path>`: browsers draw SVG favicons without webfonts, and a system-serif fallback would change the letter. |
| `favicon-32.png` | 32×32 raster of the badge, transparent corners | Headless Chrome screenshot of an `<img>` sized in CSS (see below) |
| `favicon.ico` | Byte copy of `favicon-32.png` | Every current browser accepts PNG bytes at `/favicon.ico`; it spares the repo an ico toolchain for the one path browsers request blindly. |
| `apple-touch-icon.png` | 180×180, full-bleed square (radius 0) | iOS applies its own corner mask; transparent corners would go black. |
| `og.png` | 1200×630 social card: paper, the badge at 160px, "Tiro" outlined from Spectral, the tagline in the system CJK sans | One SVG, screenshotted by Chrome. The tagline needs macOS for PingFang SC — the same constraint the old card had. |

## Why headless Chrome

`scripts/brand.ts` writes each SVG to a scratch dir, wraps it in a one-line
HTML page whose `<img>` is sized in CSS to the target pixel size, and runs
`Google Chrome --headless --screenshot`. The wrapper is the part that works:
screenshotting an SVG directly yields a crop of the SVG's own canvas at any
size but its native one. `apps/extension/icons/README.md` documents the same
recipe (and its failure modes) for the extension's icons. Point `CHROME` at
another binary if Chrome lives elsewhere.

Do not pass `--user-data-dir`: with a throwaway profile Chrome writes the
file and then sits in first-run/updater work until killed.

## Checking the output

```sh
file apps/site/public/*.png   # expect 32×32, 180×180, 1200×630
open apps/site/public/og.png
```

## The extension's icon

The Chrome extension still ships the old bookmark mark
(`apps/extension/icons/icon.svg`); it changes with the popup redesign, which
is its own PR. Until then the two marks differ on purpose rather than by
accident.
