# AGENTS.md

Guidance for AI agents (and future humans) working on Tiro. Claude Code loads
this file via `CLAUDE.md`.

Tiro is a personal read-it-later tool: a Chrome extension clips pages as
Markdown into a separate content repo (`hutusi/tiro-vault`, private), a GitHub
Actions workflow there summarizes/tags/translates them with an LLM, and an
Astro site publishes the result at <https://tiro-36s.pages.dev/>. This repo
holds all the code; the vault holds all the content. Design details live in
[docs/architecture.md](docs/architecture.md) and [docs/adr/](docs/adr/);
day-2 operations live in [docs/operations.md](docs/operations.md).

## Repo map

| Path | What |
| --- | --- |
| `packages/shared` | **The content contract — keystone.** Zod frontmatter schemas, slug rules, block alignment, `tiro.yml` config schema |
| `packages/processor` | LLM pipeline CLI (`tiro-process run\|validate`), run by the vault's workflow |
| `apps/extension` | Chrome MV3 clipper (Readability + Turndown → GitHub Contents API) |
| `apps/site` | Astro site (Tailwind 4, Pagefind search), deployed to Cloudflare Pages |
| `vault-template/` | Files to bootstrap a new vault repo |
| `fixtures/vault` | Fake vault for tests and local site dev — its articles must stay contract-valid (test-enforced) |

## Commands

```sh
bun install                # workspace install
bun run lint               # Biome (ts/js/json) + Prettier (.astro only)
bun run fix                # auto-format both
bun run typecheck          # tsc per package + astro check
bun test                   # bun test across all packages
bun run --cwd apps/extension build   # two-pass Vite build → dist/
bun run --cwd apps/site dev          # site dev against fixtures/vault
bun run --cwd apps/site build        # assets + astro build + pagefind
bun run process -- --vault <dir> [--slug S] [--force] [--dry-run]
```

## Hard invariants — do not break casually

1. **The content contract is shared by three independent components** that
   ship separately (extension writes, processor transforms, site reads).
   Schema/slug/path changes must keep all three in lockstep and bump
   `tiro.schema` when breaking (ADR 0002).
2. **Slugs are deterministic from the URL** (normalized URL → slug + 8-hex
   SHA-256). Re-clipping must overwrite the same article, never duplicate.
3. **"Needs processing" = `tiro.processed_at` absent.** The processor is
   idempotent and retry-safe; never select work by push diffs.
4. **`zh.md` must be strictly 1:1 block-aligned** with the `index.md` body,
   code blocks byte-identical. A misaligned `zh.md` must never be written;
   the site falls back to stacked rendering rather than misaligned rows
   (ADR 0003).
5. **The site is fully public** — all clipped HTML must pass rehype-sanitize
   in `apps/site/src/lib/render.ts`. Never reintroduce `allowDangerousHtml`
   at the stringify stage; extend the sanitize schema instead if legitimate
   tags get stripped.
6. **`@tiro/shared`'s root export must stay browser-safe** (it is bundled
   into the extension). Anything touching `node:` APIs goes in a subpath
   export (`@tiro/shared/config`).
7. **Per-article fault isolation in the processor**: a hard failure logs,
   leaves the article pending, and must never fail the workflow before its
   commit step. Per-image failures fall back to the hotlink; downloads are
   guarded (non-public-host rejection, streaming byte cap).

## Toolchain notes

- **TypeScript is pinned to 6.x** — `astro check` needs the programmatic API
  that the native TS 7 compiler doesn't expose. Don't bump to 7 until it does.
- Biome owns ts/js/json; Prettier owns `.astro` only; the Tailwind 4
  stylesheet is excluded from Biome (it can't parse `@plugin`/`@custom-variant`).
- `@tiro/shared` ships TypeScript source directly — no build step, every
  consumer is TS-native (ADR 0001).
- Use the structural `FetchLike` type for injectable fetch, not
  `typeof fetch` (Bun's type demands `preconnect`).
- The extension clipper must stay an **IIFE** (second Vite pass):
  `executeScript`-injected files are classic scripts (ADR 0005).
- Astro glob loaders read `TIRO_VAULT_DIR` (default `fixtures/vault`); a bad
  base yields a silently empty collection, so the guards in
  `apps/site/src/lib/{vault,articles}.ts` must stay (ADR 0006).

## Conventions

- Conventional Commits; the body explains **why**; no AI-attribution lines
  or `Co-Authored-By` trailers anywhere.
- Features → `<type>/<topic>` branch + PR; doc edits and small fixes may go
  straight to `main`. CI must be green before anything lands.
- Merging: **rebase-merge single-commit PRs; merge-commit multi-commit PRs.**
  Never rebase-merge the base of a stacked PR (it breaks downstream diffs).
- CodeRabbit reviews PRs (rate limit: 1/hour; trigger manually with a
  `@coderabbitai review` comment). Verify each finding against the code;
  reply on the thread with fixed-in-`<sha>` or a reasoned decline.
- `CHANGELOG.md` is updated per release-worthy milestone; fine-grained
  history is the git log.
