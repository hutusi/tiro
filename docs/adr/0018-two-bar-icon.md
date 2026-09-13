# ADR 0018: One mark — the two bars become the icon

Status: accepted (2026-09). Supersedes the **Marks** paragraph of
[ADR 0014](0014-later-reader-design.md), which assigned the header one mark and
the icon another. Nothing else in 0014 changes, and [ADR 0015](0015-extension-popup-design.md)'s
rule that one script writes both site and extension icons is kept, not reversed.

## Context

Tiro had two marks. The site header and footer set a **two-bar lockup** — an ink
bar, an accent bar, then "Tiro" — inline HTML with no asset behind it. The
favicon, touch icon, social card and the extension's toolbar and store icons
were an **oxblood "T" monogram**, a rounded square with Spectral's capital
outlined into a path.

ADR 0014 recorded that split as deliberate, and a wordmark lockup differing from
an app icon is ordinary practice. The trouble is that the design project it came
from endorses *both*, in the same breath:

- `Tiro Logo.dc.html` offers three directions and labels 1a "Two columns —
  original | translation (used in the app)" and 1c "Monogram badge — works as
  favicon / extension icon". Read that way, the implementation was faithful.
- The same project's own `favicon.svg` is the two bars on a cream tile.

So "what is Tiro's icon" had two supported answers and no decision between them.
That is the actual defect — not the difference itself, which had a case, but that
nobody had chosen, so the difference could not be defended or corrected without
re-running the argument. It surfaced as the obvious question: why does the tab
not look like the header?

## Decision

**The two bars are the mark, everywhere.** The favicon, `favicon.ico`, the touch
icon, the social card and all four extension icons are now the bars; the
monogram is gone from the codebase.

The tile is the design's `favicon.svg` copied rather than re-derived — bars 12
wide and 36 tall, 8 apart, centred in a 64 square, cream ground, one bar ink and
one oxblood. Its radius of 14/64 is the proportion the badge used at 16/72, so
the silhouette in a tab strip is unchanged even though the artwork inside it is
not.

Three things follow, each of which had to be decided rather than inherited.

**The social card draws the lockup, not the tile.** Its paper is the same cream
as the tile, so swapping the badge for the tile would have left two bars on an
invisible square. It now sets the bars *beside* the wordmark on a shared
baseline, in the proportions of the design's large logo cell. The share image
and the site header are consequently the same lockup, which the stacked badge
never was.

**The mark no longer needs a font.** The monogram existed as an outlined path
because browsers draw SVG favicons without webfonts and a system-serif fallback
would have changed the letter; it also needed a 2px optical lift to sit right in
its square. Rectangles need neither, so `centred()` and `monogram()` are
deleted. opentype.js stays, for the social card's wordmark only.

**One script still writes both sides.** ADR 0015 made the extension's icons an
output of the site's brand script so the two could not drift;
`apps/extension/public/icons/icon-32.png` and `apps/site/public/favicon-32.png`
remain byte-identical, and that check belongs in any future change here.

## Consequences

The cream tile has less contrast against a light Chrome tab strip than the
oxblood square did. Checked at size rather than assumed: on a white active tab
the tile effectively disappears and the two bars stand alone, which reads as the
mark — it is the header treatment — rather than as a broken icon. The bars stay
legible at 16px on both light and dark strips. If that ever stops being true the
answer is a darker tile or a hairline border, not a return to a letterform.

The extension's published icon changes, so the next store upload carries a
visibly different item. It cannot ship until 0.13.0 clears review: replacing a
pending submission restarts the clock. `manifest.json` is untouched by this
change, per the repo's rule that the version is a release-time decision.

`apps/extension/icons/README.md` previously argued that a bold serif capital
survives the toolbar better than a lowercase wordmark, and that a badly-reading
mark should be answered with "a heavier or larger T". That reasoning is retired
with the monogram.

## Rejected

**Keeping the split and doing nothing.** Defensible — the design supports it, the
monogram is the stronger standalone icon, and changing the extension icon costs a
store round-trip. Rejected because the owner wants one identity, and because a
difference nobody had decided is one that keeps being re-litigated.

**Moving the header to the monogram instead.** The cheaper direction: site-only,
no store impact, and it unifies on the mark that works better alone. Rejected
because the bars are what the site has taught readers to recognise on every page,
and because the design's "used in the app" note points at the bars, not away from
them.

**Forking the two — bars on the site, monogram on the extension.** Rejected
outright: it trades a benign difference for a real one. A favicon and a toolbar
icon sit in far more similar contexts than a favicon and an inline header
lockup, and it would break the ADR 0015 guarantee that one generator writes both.
