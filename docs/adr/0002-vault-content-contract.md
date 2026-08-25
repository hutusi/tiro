# ADR 0002: Vault content contract — per-article folders, deterministic slugs, frontmatter marker

Status: accepted (2026-08). The `articles/<year>/<slug>/` layout described
below is superseded by ADR 0007 (flat `articles/<slug>/`); the slug,
frontmatter-marker, and schema decisions stand.

## Context

Three independent components (extension writes, processor transforms, site
reads) share one content store: the `tiro-vault` git repo. The contract
between them must survive retries, re-clips, and concurrent runs.

## Decision

- Layout: `articles/<year>/<slug>/` containing `index.md` (original +
  frontmatter), `zh.md` (translation, absent for Chinese originals), and
  `assets/` (images downloaded by the processor). `config/tiro.yml` holds LLM
  config and the category taxonomy.
- **Slug** is deterministic from the URL: normalize (strip fragment,
  `utm_*`/`fbclid`/`gclid`, trailing slash), slugify host+path truncated to
  ~60 chars, append `-` + first 8 hex of SHA-256 of the normalized URL.
  Re-clipping a URL therefore overwrites the same article and reprocesses it.
- **Processing state lives in frontmatter**: an article needs processing iff
  `tiro.processed_at` is absent. The processor scans for this marker instead
  of diffing pushes — idempotent and retry-safe.
- Frontmatter is validated by a Zod schema in `@tiro/shared`; the extension
  writes clip fields (`url`, `title`, `domain`, `clipped_at`, …), the
  processor adds derived fields (`lang`, `summary`, `category`, `tags`,
  `tiro.processed_at`, `tiro.processor_version`).
- Categories come from the taxonomy in `config/tiro.yml` and are assigned by
  the LLM (with free-form tags); there is no clip-time taxonomy UI.

## Consequences

- Any component can be re-run safely; a failed workflow just runs again.
- Cross-year re-clips need the extension to search existing year directories
  for the slug before choosing a path.
- Schema evolution is explicit via `tiro.schema` version field.
