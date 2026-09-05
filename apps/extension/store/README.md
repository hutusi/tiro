# Store assets

Listing copy, declarations, and images for the Chrome Web Store submission.
`listing.md` is the source of truth for the text; this file covers the images.

Google requires exactly three kinds of image, and all three are accounted for:
"Only the extension icon, a small promotional image, and a screenshot are
mandatory."

| File | Role |
| --- | --- |
| `../public/icons/icon-128.png` | **Store icon** — required. Shipped in the ZIP, so the listing and the toolbar cannot drift apart |
| `promo-tile-440x280.png` | **Small promo tile** — required, and easy to miss because nothing prompts for it until submission |
| `promo-tile-440x280.html` | The composition it is rendered from |
| `screenshot-1-settings.png` | **Screenshot** — required, 1280×800 (minimum 1, maximum 5) |
| `screenshot-1-settings.html` | The composition it is rendered from |
| `options-ui.png` | Raw 2× capture of the options page, placed by the composition |

The 1400×560 marquee tile is *not* required — it only matters if you want the
item considered for featuring, which an unlisted personal tool does not.

**Note on the store icon**: `icon-128.png` carries 16px of transparent padding
around 96×96 of artwork, which is what Chrome's listing guidance asks for. The
16/32/48 toolbar icons are deliberately full-bleed. The compositions here point
at `../icons/icon.svg` rather than the PNG for exactly that reason — using the
padded file would render the mark inset inside its own box.

## Optional: a screenshot of the popup mid-clip

Not required — one screenshot satisfies the store — but a better listing has
two. It cannot be rendered headlessly: the popup's useful state (page title
resolved, "Clip to vault" enabled) only exists once the extension is running
against a tab, and faking it in HTML would put a picture in the listing that
misrepresents the product.

Capture it by hand: load the extension, open an article, click the toolbar
button, and screenshot the popup (⌘⇧4 then Space on macOS). Then either pad it
to exactly 1280×800 or drop it into a copy of the composition below in place of
`options-ui.png`.

## Regenerating the images

From the repo root. The options capture needs a **development build served
over HTTP**: the page's stylesheet and fonts are external assets with
absolute `/assets/…` paths (they were inline before the redesign), so
`file://` cannot load them, and `?preview` — honoured only by a development
build — shows the empty first-run form instead of the "could not load saved
settings" error the page shows when there is no `chrome.storage` around.
The two compositions still render over `file://`.

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
bun run --cwd apps/extension build:dev

# Serve dist/ for the options capture; stop it again when done, and wait
# for it to answer before pointing Chrome at it.
(cd apps/extension/dist && python3 -m http.server 4322 --bind 127.0.0.1 &)
trap 'pkill -f "http.server 4322"' EXIT
until curl -sf -o /dev/null http://127.0.0.1:4322/src/options/options.html; do sleep 0.2; done

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=560,600 \
  --screenshot="apps/extension/store/options-ui.png" \
  "http://127.0.0.1:4322/src/options/options.html?preview"

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1280,800 \
  --screenshot="apps/extension/store/screenshot-1-settings.png" \
  "file://$PWD/apps/extension/store/screenshot-1-settings.html"

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=440,280 \
  --screenshot="apps/extension/store/promo-tile-440x280.png" \
  "file://$PWD/apps/extension/store/promo-tile-440x280.html"
```

Then run a production build again before packaging — `build:dev` leaves a
development bundle in `dist/`.

Confirm the sizes afterwards — the store rejects anything off by a pixel:

```sh
file apps/extension/store/*.png
# expect 1280x800 (screenshot) and 440x280 (promo tile) — the store uploads.
# options-ui.png is 1120x1200: the 2x intermediate capture the screenshot
# composition embeds, never uploaded itself.
```

Notes that will save you a confused half hour:

- `--window-size` is the crop, not a scale. 600 fits the settings card with
  its paper margin above and below; the card grew with the redesign, so an
  older 500 crops the buttons away.
- The compositions load Spectral from `../node_modules/@fontsource/spectral/`
  — the same files the popup ships — so they need `bun install` to have run.
  Their palette is the site's (ADR 0014): cream `#f4efe4`, oxblood `#8f2f2f`,
  ink `#1e1b16`.
- Chrome writes a screenshot whether or not the page loaded, so look at the
  result. A "This site can't be reached" listing image is a real failure mode
  (a system proxy can swallow `http://127.0.0.1`; if it does, unset the proxy
  for the capture rather than falling back to `file://`, which cannot load
  the stylesheet).
- Never pass `--user-data-dir`: with a throwaway profile Chrome writes the
  file and then sits in first-run work until killed.
