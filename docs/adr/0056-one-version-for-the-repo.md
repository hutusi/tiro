# ADR 0056: One version for the repo

Status: accepted (2026-11). Replaces the two release lines that `ext-v*` and
`v*` tags kept apart since the clipper's first release. No ADR recorded that
split. It lived in `docs/operations.md`, `AGENTS.md` and a comment in
`CHANGELOG.md`, and those now describe one line.

## Context

The clipper and the repo each had a version. The clipper's lived in
`apps/extension/manifest.json`, was tagged `ext-v<version>`, and had its own
GitHub Release, "Tiro Clipper X", carrying the zip. The repo's was a
`CHANGELOG.md` heading, tagged `v<version>`, with a GitHub Release made by
hand, "Tiro X", that linked the clipper's release.

The split assumed they would ship apart. They didn't. Every repo release from
v0.6.0 (2026-09-13) to v0.12.0 (2026-10-26) went out on the same day as a
clipper release, all seven tagged on the same commit or the one after it, the
`docs: cut` commit. The pairing was the only thing the two numbers said, and
the offset hid it: "Tiro 0.12.0, with Clipper 0.18.0".
It cost two tags, two releases, two procedures and two numbers for every
milestone. Nothing used the difference between them.

## Decision

**One version, one tag, one release.**

- `apps/extension/manifest.json` stays the only version string in the repo. It
  is the repo's version now, not just the clipper's. A `CHANGELOG.md` heading
  names the same number.
- A release is a `v<version>` tag. `.github/workflows/release.yml` (formerly
  `release-extension.yml`) builds the clipper and checks the tag against the
  manifest. It also checks that `CHANGELOG.md` has a section for that version.
  It then publishes one GitHub Release, "Tiro <version>", which carries
  `tiro-clipper-<version>.zip` and has that CHANGELOG section as its notes. The
  hand-made repo release is gone.
- **The line continues from the clipper's number.** The first single release is
  0.19.0, the minor bump saved sites (ADR 0055) earned the clipper anyway. The
  repo goes from 0.12.0 straight to 0.19.0. Skipping is allowed by semver and
  by Keep a Changelog, and it keeps `tiro.clipper_version`, already stamped
  into every article the clipper has written, monotonic.
- **Patch or minor is judged across the whole system**: patch for a narrow fix
  anywhere, minor for a new capability, a batch, or a broad change in output.
  The version is still bumped at release time, never in the branch that makes
  the change.
- **`tiro.clipper_commit` describes against `v*`.** The Vite build runs
  `git describe --match 'v[0-9]*'` instead of `'ext-v*'`, so a build reads
  `v0.19.0-3-g<sha>`. Clips made before this change read `ext-v…`. Both name a
  commit, so `git merge-base --is-ancestor` answers the audit question for
  either.
- **The `ext-v*` tags and releases stay.** Clips name them, and deleting one
  would turn a recorded provenance into a dangling name.

## Rejected

- **Same number, two tags.** Keeping `ext-v0.19.0` beside `v0.19.0` would have
  needed no workflow change. It keeps two releases and two procedures for one
  event, which is the cost this decision removes.
- **Cut the clipper only when it changed, at the shared number.** That would
  keep `clipper_version` from moving without a change, but the clipper line
  would skip numbers and the two would drift apart again. The owner wants one
  number.
- **1.0.0 as the meeting point.** 1.0 claims stability that Tiro, a personal
  system on `0.x`, does not offer.

## Consequences

- **`tiro.clipper_version` can move with nothing behind it.** A release that
  changed only the site or the processor still builds a clipper at the new
  number. Clips from that build and the previous one come from identical
  clipper code. An audit asking which clips predate a fix still gets a correct
  answer: an unchanged clipper neither has nor lacks the fix differently from
  its predecessor. But the size of the step between two clipper versions no
  longer says how much the clipper changed. `CHANGELOG.md` and
  `tiro.clipper_commit` do.
- **A Chrome Web Store upload is only needed when the clipper changed.** The
  store requires a strictly higher version, not consecutive ones, so skipping
  uploads costs nothing. It saves a review for a package that would clip
  exactly as the last one did.
- A release's notes come from `CHANGELOG.md`, so a missing section fails the
  release before anything is published rather than shipping empty notes.
- `tiro.processor_version` stays at `0.1.0`, untouched. The processor runs from
  `main` in the vault's job, not from a release, so stamping it with a release
  number would claim a build it isn't. Unifying it is a separate question.
