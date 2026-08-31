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

From the repo root. The first step re-captures the options UI; the last two
compose the listing images:

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
bun run --cwd apps/extension build

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=560,500 \
  --screenshot="apps/extension/store/options-ui.png" \
  "file://$PWD/apps/extension/dist/src/options/options.html"

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1280,800 \
  --screenshot="apps/extension/store/screenshot-1-settings.png" \
  "file://$PWD/apps/extension/store/screenshot-1-settings.html"

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=440,280 \
  --screenshot="apps/extension/store/promo-tile-440x280.png" \
  "file://$PWD/apps/extension/store/promo-tile-440x280.html"
```

Confirm the sizes afterwards — the store rejects anything off by a pixel:

```sh
file apps/extension/store/*.png
# expect 1280x800 (screenshot) and 440x280 (promo tile) — the store uploads.
# options-ui.png is 1120x1000: the 2x intermediate capture the screenshot
# composition embeds, never uploaded itself.
```

Notes that will save you a confused half hour:

- The options page renders over `file://` because its CSS is inline; only its
  JS is external, and that JS would fail outside an extension context anyway.
  The empty-state form is exactly what should be in the listing.
- `--window-size` is the crop, not a scale. 500 is tuned to end just under the
  Save row — raising it re-introduces dead space, and the old 425 now crops
  the buttons away entirely (the Language select added in 0.4.0 grew the page).
- Chrome writes a screenshot whether or not the page loaded, so look at the
  result. A "This site can't be reached" listing image is a real failure mode
  (a system proxy can swallow `http://127.0.0.1`, which is why these use
  `file://`).
