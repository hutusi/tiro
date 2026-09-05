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

The site no longer reuses this mark. Its favicon, touch icon and social card
are the oxblood "T" monogram of the Later Reader design (ADR 0014), generated
by `apps/site/scripts/brand.ts` with the same headless-Chrome wrapper recipe
described above — see `apps/site/brand/README.md`. The extension keeps the
bookmark until the popup is redesigned to match, which is its own PR.
