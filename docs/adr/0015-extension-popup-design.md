# ADR 0015: The extension popup follows the "Tiro Clipper" design

Status: accepted (2026-09). Companion to ADR 0014 for `apps/extension`; the
clipping pipeline, the content contract and the disclosure (see
`docs/operations.md`, "Data disclosure and the token") are unchanged.

## Context

The site adopted the Claude Design "Later Reader" system in ADR 0014. The same
design project has a `Tiro Clipper` page — four frames of the extension popup
(saved, saving, a Chinese page, already saved) — and the `Tiro Logo` page whose
monogram the site's favicon already uses. The popup meanwhile still looked like
its first cut: a 320px system-ui panel in GitHub's grey palette with the old
terracotta button and a bookmark toolbar icon. Two products, two looks.

The frames also propose behaviour the extension does not have: saving on the
first click of the toolbar icon, tag chips with a "+ tag" field, a per-clip
translate toggle, a Remove button, a reading-progress bar.

## Decision

**Look.** The popup and the options page take the site's tokens — cream or
dark paper by the OS colour scheme, oxblood accent, the two-bar wordmark —
with Spectral and JetBrains Mono bundled from the same `@fontsource` packages
the site uses (same-origin assets, no CSP change, ~100 KB in the zip). The
toolbar and store icons become the monogram, written by the site's brand
script (`apps/site/scripts/brand.ts`) so the two marks cannot drift.

**Frames onto states.** Each popup state maps to a frame: a short header
label beside the wordmark (Reading…, Ready, Saved ✓, Saved Sep 2, Failed) and
the full sentence under the card; a skeleton with a 2 px sweep while the page
is read; the meta line in mono — domain · reading time · word count — the title
and the excerpt Readability already produced; the arXiv standing note in its
own slot rather than sharing the readability warning's.

**After a clip: two links.** "Open in Tiro →" goes to the article's page on the
site, built from the manifest's `homepage_url` and the slug the popup already
holds; because the site is static, a hint says the page appears once
processing finishes. "View in vault" keeps the instant GitHub link. A page
clipped from this machine before shows the same pair with Re-clip as an
outline: opening it is then the likelier intent.

**A pure view model.** Rendering goes through `popupView(state, m)` in
`src/popup/view.ts`; `popup.ts` keeps its facts and every ordering guard
(`committing`, `best`, `tabResolved`, the abstract-only note) and paints from
the result in one place. The popup never had a DOM harness; every state is now
a unit test. A development build (`bun run build:dev`) additionally paints a
canned state for `popup.html?state=<name>` — how the frames were checked in
both languages and both papers — and the production build removes that
branch and the fixtures module.

## Deliberately not adopted

- **Saving on the toolbar click.** The first-run disclosure and the store
  listing promise that nothing leaves the browser until Clip is pressed; the
  explicit step stays, so the disclosure copy and `DISCLOSURE_VERSION` stay.
- **Tags at clip time.** `tags` is written by the processor. User tags need
  the clip schema to carry them and the processor to merge rather than
  overwrite — a contract change (ADR 0002) for its own ADR.
- **A per-clip translate toggle.** Translation is vault configuration; an
  opt-out needs a frontmatter flag the processor honours.
- **Remove.** A delete path from the popup, with a confirmation, is a new
  capability, not a restyle.
- **Reading progress.** Nothing records it.

## Consequences

- The extension's output is byte-identical; the release bump is minor (a new
  look and a new icon), taken at release time, not in the branch.
- The store images are regenerated and committed; the upload waits for the
  next release, since a new upload restarts the pending review.
- The 16 px toolbar icon is a letterform in a filled square. It reads at that
  size; if it ever does not, the remedy is a heavier or larger T in the brand
  script, recorded in `apps/extension/icons/README.md`.
- Reading time moved to `@tiro/shared` so the popup and the site cannot
  disagree about it.
