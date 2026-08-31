# Icon source

`icon.svg` is the source for `../public/icons/icon-*.png`, which is what the
manifest and the Web Store listing load. Vite copies `public/` into `dist/`
on the first build pass, so the PNGs need no build wiring.

A bookmark, not a wordmark: at 16 px in the toolbar a letterform is mud. The
terracotta is `#b4452f` — the site's accent and the popup's primary button
color, so the toolbar icon, the popup and the site read as one thing.

## Regenerating the PNGs

From the repo root, after editing `icon.svg` (macOS, headless Chrome — no
extra toolchain):

**The 128 is not rendered like the others.** It is the store and install icon,
and Chrome's listing guidance asks for 96×96 of artwork centred in the 128×128
canvas with 16px of transparent padding on each side. The toolbar sizes stay
full-bleed, where padding would just make the icon look small.

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
tmp="$(mktemp -d)"

# Toolbar sizes: full bleed.
for s in 16 32 48; do
  cat > "$tmp/icon-$s.html" <<HTML
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}
img{display:block;width:${s}px;height:${s}px}</style>
<img src="file://$PWD/apps/extension/icons/icon.svg" alt="">
HTML
done

# Store/install icon: 96 of artwork, 16 of transparent margin.
cat > "$tmp/icon-128.html" <<HTML
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}
img{display:block;width:96px;height:96px;margin:16px}</style>
<img src="file://$PWD/apps/extension/icons/icon.svg" alt="">
HTML

for s in 16 32 48 128; do
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 --force-device-scale-factor=1 \
    --window-size=$s,$s \
    --screenshot="apps/extension/public/icons/icon-$s.png" \
    "file://$tmp/icon-$s.html"
done
```

The HTML wrapper is not ceremony — it is the part that works. Screenshotting
`icon.svg` directly gives you the top-left `NxN` crop of a 128 px document at
every size but 128, and swapping the SVG's `width`/`height` for percentages
renders a differently-broken partial square. Sizing an `<img>` in CSS is what
makes the viewport and the drawing agree.

Two failure modes worth knowing, because neither returns a non-zero exit code:

- A malformed SVG screenshots Chrome's XML error page into your icon. (XML
  comments cannot contain `--`, which rules out pasting the command above into
  the SVG itself.)
- A viewport/document mismatch silently yields a crop or a blank file.

So check the output rather than trusting the command:

```sh
file apps/extension/public/icons/*.png   # expect exact 16/32/48/128 squares
open apps/extension/public/icons/icon-16.png
```

## Site assets

The site reuses this mark; its copies live in `apps/site/public/` and are
committed, not built:

- `favicon.svg` — a copy of `icon.svg` with the `<title>` changed to "Tiro"
  (the site is Tiro, the extension is Tiro Clipper). Edit both when the mark
  changes.
- `favicon-32.png` and `favicon.ico` — byte copies of
  `../public/icons/icon-32.png`. The `.ico` holds PNG bytes: every current
  browser accepts that at `/favicon.ico`, and it spares the repo an ico
  toolchain for the one path browsers request blindly.
- `apple-touch-icon.png` — 180×180, rendered with the same headless-Chrome
  recipe but with `background:#1f883d` on the wrapper and the image at
  180px: the rounded rect blends into the background, giving the full-bleed
  square iOS expects (iOS applies its own corner mask; transparent corners
  would go black).
- `og.png` — the 1200×630 social card: white background, centered 160px
  mark, "Tiro" and the tagline, same wrapper technique with
  `--window-size=1200,630`. Render it on macOS (the tagline needs
  PingFang SC).

```sh
tmp="$(mktemp -d)"
cat > "$tmp/apple-touch-icon.html" <<HTML
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#1f883d}
img{display:block;width:180px;height:180px}</style>
<img src="file://$PWD/apps/site/public/favicon.svg" alt="">
HTML
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=180,180 \
  --screenshot=apps/site/public/apple-touch-icon.png \
  "file://$tmp/apple-touch-icon.html"
```
