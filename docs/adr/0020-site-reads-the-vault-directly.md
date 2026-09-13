# ADR 0020: The site reads the vault directly, not through Astro's content layer

Status: accepted (2026-09). Supersedes ADR 0006's loader decision; everything
else in ADR 0006 stands — vault images still bypass Astro's image pipeline and
are still plain copies under `/vault-assets/<slug>/`, and the guards against a
bad vault base are still load-bearing.

## Context

ADR 0006 loaded the vault with Astro's `glob()` content loader. That decision
came with a failure mode nobody had reason to predict.

On 2026-09-13 a clip from xeiaso.net brought in the site's view counter as if it
were a content image: thirty bytes of `<svg><!-- View Proxy --></svg>`, with no
`width`, no `height` and no `viewBox`. Astro could not measure it, threw
`NoImageMetadata`, and failed the build. Every deploy failed from 06:40 — not
that article's, *every* article's — and because `deploy.yml` builds before it
uploads, the previous deployment stayed live and nothing announced the problem.
The site quietly served four-hour-old content until someone went looking.

The reason Astro was measuring that file at all is that the glob loader renders
each article's markdown at load time to collect the local images it references,
then emits a module import for each one.

**And the site uses none of it.** It declares no Astro-side schema — the shared
Zod contract validates in `lib/articles.ts`. It does not use Astro's renderer —
`lib/render.ts` runs its own unified pipeline, which is where the sanitize step
that invariant 5 depends on lives. It does not use Astro's processed images —
`render.ts` rewrites `./assets/` to `/vault-assets/`, which `copy-assets.ts`
fills by plain copy (ADR 0006). Measured on the live vault: **not one
`/_astro/` asset path in any of 102 built article pages**, while `dist/_astro`
held **119 MB** of processed images that nothing referenced and every deploy
uploaded.

So the content layer was supplying file discovery and a cache — and
`getCollection` had exactly one caller in the whole site.

`deferRender: true` was tried first and rejected on evidence: it does stop the
load-time render (`content-assets.mjs` comes back empty), but Astro then emits a
dynamic import of every markdown file instead, which reaches the same image
handling by another road. It relocates the work rather than removing it.

## Decision

- **`lib/vault-read.ts` reads the vault from the filesystem**, parsing each
  `index.md` with the shared `parseArticle` and attaching `zh.md` verbatim.
  `getAllArticles` maps over it; `content.config.ts` is deleted.

- **One reader, not two.** The sitemap could never use the content layer —
  `@astrojs/sitemap` is configured in `astro.config.mjs`, evaluated before that
  layer exists, and its `filter` is synchronous — so `unlisted-slugs.ts` already
  read the vault itself. ADR 0017 had to warn about keeping the two definitions
  of "unlisted" in step. Now there is one reader and the warning is moot.

- **The body is what the contract says it is.** `parseArticle` is the same
  parser the processor uses and the same one block alignment is checked with, so
  the site and the processor can no longer disagree about where an article's
  body starts. One consequence is visible: Astro trimmed leading whitespace that
  `parseArticle` keeps, and one arXiv author line's U+2003 em-spaces now survive
  into the page. That is the more faithful rendering, and it was the *only*
  content difference across 102 articles.

- **Dev reload is bought back explicitly.** The content layer gave it for free;
  it was measured before the change (an edit appeared about four seconds later)
  rather than assumed unimportant. Two pieces are needed, and one alone is not
  enough: the reader revalidates against the vault's mtimes when `NODE_ENV` is
  not `production`, returning the *same array reference* while nothing has
  changed so callers can memoize off its identity; and a small integration
  watches the vault, invalidates the SSR module graph — `getStaticPaths` results
  are cached per route in dev, so the page would otherwise re-render the
  articles it was handed first — and tells the browser to reload.

- **A dimensionless SVG lives in `fixtures/vault`**, referenced from a
  single-pane article. It fails the build on the old loader and passes on this
  one, so CI holds the line. Biome no longer lints `fixtures/vault/**/assets`:
  those are clipped content, whatever a publisher served, not source anyone
  wrote.

## Consequences

- **A malformed asset costs one image, not every deploy.** The site copies it
  and carries on. This is the site's counterpart to the processor's per-article
  fault isolation (invariant 7), which it had no equivalent of.

- **119 MB → 1.5 MB of `_astro` output**, and that much less uploaded to
  Cloudflare on every deploy.

- **Astro coupling shrinks**, which ADR 0001 and ADR 0006 both valued: the
  site's view of the vault no longer moves when Astro's content layer does.

- **Resolving the default `fixtures/vault` path is no longer a count of `..`
  segments.** `vault.ts` is in the page module graph now and gets bundled into
  `dist/.prerender/chunks/`, where a fixed depth resolved to `apps/fixtures/vault`.
  It searches upward instead. ADR 0006's guard is what caught this, and it stays.

- The site reads every article's `index.md` and `zh.md` on first use, where
  before the loader cached across builds. On 102 articles this is not
  measurable, and `unlistedSlugs()` already did exactly this read.
