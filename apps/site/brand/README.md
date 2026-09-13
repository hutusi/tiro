# Brand assets

Tiro has **one** mark: the two bars — an ink bar and an oxblood bar — on a cream
rounded square (ADR 0018, superseding the oxblood "T" monogram of ADR 0014).

It appears two ways. As a **tile** it is the favicon, touch icon and extension
icon, generated below. As an **inline lockup** — bars set beside the "Tiro"
wordmark, sharing a baseline — it is the site header and footer, which are HTML
(`.logo-bars` in `src/styles/global.css`) and need no asset, and the social card,
which draws that same lockup. Same bars, same proportions, container or not.

Everything in `public/` below, and the extension's icons, is **generated and
committed** — run `bun run brand` from `apps/site` after changing the mark,
then look at the output before committing it.

| File | What | How it is made |
| --- | --- | --- |
| `favicon.svg` | The tile (radius 14 on a 64 box) | Plain `<rect>`s — the design project's own `favicon.svg`, copied rather than re-derived. Bars 12 wide and 36 tall, 8 apart, centred both ways. No font is involved, which is the point: browsers draw SVG favicons without webfonts, so the old monogram had to outline its "T" into a path. |
| `favicon-32.png` | 32×32 raster of the tile, transparent corners | Headless Chrome screenshot of an `<img>` sized in CSS (see below) |
| `favicon.ico` | Byte copy of `favicon-32.png` | Every current browser accepts PNG bytes at `/favicon.ico`; it spares the repo an ico toolchain for the one path browsers request blindly. |
| `apple-touch-icon.png` | 180×180, full-bleed square (radius 0) | iOS applies its own corner mask; transparent corners would go black. |
| `og.png` | 1200×630 social card: paper, then the **inline lockup** — bars beside "Tiro" outlined from Spectral, on a shared baseline — over the tagline in the system CJK sans | One SVG, screenshotted by Chrome. It draws the lockup rather than the tile because the card's paper *is* the tile's cream, so a tile would be invisible. The tagline needs macOS for PingFang SC. |

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

Check the tile at size too, against a light **and** a dark tab strip. The cream
ground has much less contrast on light chrome than the oxblood square it
replaced: on a white active tab it effectively disappears and the bars stand
alone, which is the header treatment and reads correctly. If it ever stops
reading, the answer is a darker tile or a hairline border — not a letterform.

## The extension's icon

The same script writes the Chrome extension's icons —
`apps/extension/icons/icon.svg` and `apps/extension/public/icons/icon-{16,32,48,128}.png`
— so the toolbar and the site are one mark, byte for byte: `icon-32.png` and
`favicon-32.png` have the same checksum, and that is worth re-checking after any
change here. The 16/32/48 are full-bleed; the
128 carries 16 px of transparent padding around 96 px of artwork, which is what
Chrome's listing guidance asks for. `apps/extension/icons/README.md` has the
extension-side notes.
