# Changelog

Notable, release-worthy changes to Tiro. The fine-grained history lives in
the git log (Conventional Commits with reasoning in the bodies); this file
records milestones. Format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow the `0.x` line while Tiro is a personal system.

## [Unreleased]

### Changed

- **Flat vault layout** (breaking, ADR 0007): articles moved from
  `articles/<year>/<slug>/` to `articles/<slug>/` — the path is now the
  identity, so a re-clip structurally cannot duplicate. Site URLs changed to
  `/articles/<slug>/` (no redirects). Existing vaults migrate with one
  `git mv` commit; `tiro.schema` stays 1 (document format unchanged).
- URL normalization strips a wider referral-param blocklist (`ref`, `source`,
  `from`, `si`, `spm`, `scm`, `igshid`, `mc_cid`, `mc_eid`, `wfr`,
  `isappinstalled`) so share-link noise dedups to one article.
- The extension stores the *normalized* URL in frontmatter (previously the
  raw `location.href`), so tracking params never reach the vault or the
  public site's source links.
- Translation batches grew from 2,500 to 10,000 source chars per LLM call
  (~4× fewer calls on long articles) and became tunable via
  `translation.batch_chars` in the vault's `tiro.yml`.
- The processor logs per-batch translation progress and per-attempt summary
  failures; the vault-template process job is bounded by
  `timeout-minutes: 30`.

### Fixed

- Queued process runs checked out the vault at their trigger SHA, so they
  re-processed articles the previous run had just committed and then failed
  the push with a rebase conflict — discarding all their LLM work. The vault
  checkout is now pinned to `ref: main` and the commit-back rebase resolves
  same-article conflicts with `-X theirs`.

## [0.1.0] - 2026-08-24

First complete, live system: clip → summarize/tag/translate → publish,
verified end to end with real articles in both languages.

### Added

- **Content contract** (`@tiro/shared`): Zod frontmatter schemas, deterministic
  URL→slug rules (re-clip overwrites), `tiro.processed_at` needs-processing
  marker, strict 1:1 block-alignment model for translations, `tiro.yml`
  config schema with per-task model overrides.
- **Processor** (`@tiro/processor`): marker-scan discovery, CJK-ratio language
  detection, image localization into `assets/`, JSON-mode summary/category/tags
  with validated retries, sentinel-batched block translation with a hard
  alignment gate, `run`/`validate` CLI.
- **Chrome MV3 extension**: on-demand Readability + Turndown clipping,
  options page with connection test, single-file commits via the GitHub
  Contents API with cross-year re-clip overwrite and stale-sha retry.
- **Astro site**: month-grouped index, categories/tags, side-by-side
  original/translation reader with 原文/译文/对照 toggle, Chinese UI, dark
  mode, Pagefind full-text search (CJK-aware), deployed to Cloudflare Pages.
- **Automation**: vault processing workflow (concurrency-grouped, rebase-retry
  push-back, `repository_dispatch` to the site) and the dual-checkout deploy
  workflow; CI with lint, per-package typecheck, `astro check`, tests, and
  both app builds.
- Docs: architecture overview, ADRs 0001–0006, operations runbook, this file.

### Fixed

- Slug generation survives malformed percent escapes in URLs.
- Pipeline survives hard per-article failures (provider 403s leave the
  article pending instead of killing the run before its commit step) and
  clears stale `summary_failed`/`translation_failed` markers on reprocess.
- Image downloads: streaming size cap, targeted URL rewriting (no prefix
  corruption), per-image hotlink fallback.
- Extension options placeholders no longer masquerade as filled-in values;
  empty fields get a clear message instead of a misleading 404.
- Deploy no longer installs wrangler mid-workflow (pinned as a dev
  dependency after a transient install failure).

### Security

- Rendered article HTML is sanitized (rehype-raw + rehype-sanitize) — the
  public site never publishes scripts/event handlers smuggled through
  clipped pages.
- Processor rejects image downloads from non-public hosts (loopback,
  link-local/cloud-metadata, RFC1918) and caps response sizes.
- CI and deploy workflows run with read-only tokens and without persisted
  git credentials.

[Unreleased]: https://github.com/hutusi/tiro/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hutusi/tiro/releases/tag/v0.1.0
