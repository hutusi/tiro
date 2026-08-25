# ADR 0007: Flat article layout — `articles/<slug>/`, path as identity

Status: accepted (2026-08). Supersedes the layout portion of ADR 0002
(`articles/<year>/<slug>/`); everything else in ADR 0002 stands.

## Context

ADR 0002 partitioned the vault by clip year: `articles/<year>/<slug>/`. In
practice the year segment carried no meaning and worked against the identity
contract:

- Nothing consumed it. The site sorts by `clipped_at` frontmatter and groups
  by month derived from it; there are no year archives. Every component
  parsed the year out of the path only to pass it through as a label.
- It weakened dedup. Identity is the slug alone, but the path added a year
  partition on top, so "re-clip overwrites" depended on the extension probing
  every year directory for the slug (N+1 Contents API calls). The site had no
  collision check — the same slug under two years would have built two pages.
- The semantic was awkward: the year was the UTC year of *clipping*, not
  publication, frozen at first clip.

A real duplicate (the same article under two slugs after a query-param
variant clip) prompted a review of identity handling; alongside a wider
tracking-param blocklist in `normalizeUrl`, flattening removes the one place
where identity and layout could disagree.

## Decision

- Layout: `articles/<slug>/` containing `index.md`, `zh.md`, and `assets/` —
  no year segment. The path is deterministic from the slug, so the layout
  itself enforces re-clip-overwrites; the extension's year-directory scan
  collapses to a single GET of the known path (only to fetch the blob sha).
- Site URLs become `/articles/<slug>/`, asset copies `/vault-assets/<slug>/`.
  No redirects from the old year URLs: the site was days old at migration.
- **`tiro.schema` stays at 1.** The article *document* format is unchanged —
  this is a repo-layout change, migrated atomically (code in all three
  components plus a one-commit `git mv` in the vault), so no article ever
  needs to know which layout it lives in.
- Slug identity itself is unchanged (same normalization + hash), except that
  `normalizeUrl` now strips a wider referral-param blocklist (`ref`,
  `source`, `from`, `si`, `spm`, `scm`, `igshid`, `mc_cid`, `mc_eid`, `wfr`,
  `isappinstalled`, plus the existing `utm_*`/`fbclid`/`gclid`). Blocklist,
  not allowlist: a missed tracker yields a visible duplicate; a stripped
  content-identifying param (`?v=`, `?id=`, `?p=`) would silently merge
  distinct pages — data loss.

## Consequences

- Duplicate-by-layout is structurally impossible: one slug, one path.
- All globs are one level (`*/index.md`, `*/zh.md`, `*/assets/*`).
- The extension no longer lists `articles/` at all, so GitHub's 1000-entry
  directory-listing cap stops being a future concern rather than becoming one.
- Year-based browsing, if ever wanted, derives from `clipped_at` frontmatter,
  not from paths.
- Existing vaults migrate with `git mv articles/<year>/<slug> articles/<slug>`
  in a single commit, pushed immediately after the code lands on `main`.
