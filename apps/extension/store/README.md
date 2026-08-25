# Store assets

Listing copy, declarations, and images for the Chrome Web Store submission.
`listing.md` is the source of truth for the text; this file covers the images.

| File | Role |
| --- | --- |
| `screenshot-1-settings.png` | Listing screenshot, 1280×800 (the store's required size) |
| `screenshot-1-settings.html` | The composition it is rendered from |
| `options-ui.png` | Raw 2× capture of the options page, placed by the composition |

The store icon is not here — it is `../public/icons/icon-128.png`, the same file
the extension ships, so the toolbar and the listing cannot drift apart.

## Still needed before submitting

**A screenshot of the popup mid-clip.** It cannot be rendered headlessly: the
popup's useful state (page title resolved, "Clip to vault" enabled) only exists
once the extension is actually running against a tab, and faking it in HTML
would put a picture in the listing that misrepresents the product.

Capture it by hand: load the extension, open an article, click the toolbar
button, and screenshot the popup (⌘⇧4 then Space on macOS). Then either pad it
to exactly 1280×800 or drop it into a copy of the composition below in place of
`options-ui.png`.

## Regenerating the composed screenshot

Both steps, from the repo root. The first re-captures the options UI, the second
composes the 1280×800 listing image:

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
bun run --cwd apps/extension build

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=560,425 \
  --screenshot="apps/extension/store/options-ui.png" \
  "file://$PWD/apps/extension/dist/src/options/options.html"

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1280,800 \
  --screenshot="apps/extension/store/screenshot-1-settings.png" \
  "file://$PWD/apps/extension/store/screenshot-1-settings.html"
```

Notes that will save you a confused half hour:

- The options page renders over `file://` because its CSS is inline; only its
  JS is external, and that JS would fail outside an extension context anyway.
  The empty-state form is exactly what should be in the listing.
- `--window-size` is the crop, not a scale. Raising the height re-introduces
  the dead space under the Save button that 425 was chosen to trim.
- Chrome writes a screenshot whether or not the page loaded, so look at the
  result. A "This site can't be reached" listing image is a real failure mode
  (a system proxy can swallow `http://127.0.0.1`, which is why these use
  `file://`).
