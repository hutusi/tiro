# ADR 0006: Site loads vault content via Astro glob loader from an external directory

Status: accepted (2026-08)

## Context

The Astro site (in `tiro`) builds from content in `tiro-vault`, checked out as
a sibling directory at build time. Locally, developers should not need a
vault clone.

## Decision

- Astro 5 Content Layer `glob()` loaders with `base` pointing at
  `$TIRO_VAULT_DIR/articles` (default: the in-repo `fixtures/vault`). Two
  collections: `articles` (`*/*/index.md`, schema from `@tiro/shared`) and
  `translations` (`*/*/zh.md`), joined by their `year/slug` entry id.
- Guardrails for the known failure mode where a bad `base` yields a
  **silently empty collection** (withastro/astro#12795): `lib/vault.ts`
  asserts the directory exists, and production builds fail if the articles
  collection is empty.
- Vault images bypass Astro's image pipeline: a prebuild script copies
  `assets/` into `public/vault-assets/<year>/<slug>/` and a rehype plugin
  rewrites relative URLs. (Astro image optimization for out-of-project
  content is historically fragile; deliberately not attempted in v1.)
- Search is Pagefind (extended build — CJK segmentation), run after
  `astro build`; deploys go to Cloudflare Pages via wrangler from a GitHub
  Actions workflow triggered by push to main or `repository_dispatch` from
  the vault.

## Consequences

- Fast local dev loop against `fixtures/vault`; the same fixtures double as
  the CI integration test of the content contract.
- The fixture vault must stay schema-valid or CI builds fail — by design.
