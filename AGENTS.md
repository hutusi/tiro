# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, …) working in this repository. This file is the single source of truth — CLAUDE.md imports it.

## Project

Tiro is a personal read-it-later tool and external knowledge base: a Chrome MV3 extension clips pages as Markdown into a separate content repo (`hutusi/tiro-vault`, private), a GitHub Actions workflow there summarizes/tags/translates them with an LLM, and an Astro site publishes the result at <https://tiro.ainaive.com/>. TypeScript + Bun workspaces
throughout; Astro 7 + Tailwind 4 for the site.

Product decisions that look odd but are deliberate:

- **The site is fully public** — no auth tier. The owner accepted the trade-off; consequently *all* clipped HTML must be sanitized before rendering (invariant 5 below).
- **All content lives in the vault repo, never here.** This repo is code only; the vault holds articles, config, and the processing workflow. The two meet in CI (the vault workflow checks this repo out; the deploy workflow checks the vault out). **One bounded exception:** `packages/shared/test/fixtures/code-blocks` holds short verbatim **code blocks** taken from real clipped articles, because the language detector's whole job is judging real-world content and a fixture invented by the same person as the rule tests only that person's assumptions — this corpus caught two rule-ordering bugs, a YAML guard that rejected a flow mapping for ending a line with `}`, and a Rust enum whose only signal was its variants, none of which a synthetic block would have exposed. This is an owner decision, taken deliberately against the rule above rather than by oversight. The exception covers code blocks and nothing else: whole articles, frontmatter, prose bodies and assets stay in the vault. One block per file, as it stood in one article — the longest today is 85 lines, and a block that needs trimming to fit is a block whose shape you have stopped testing. Remember this repo is public while the vault is private: keep the count to what the rules actually need, and prefer a block whose licence you would be comfortable quoting. `fixtures/vault` stays fake by contrast — it tests the *contract*, where the shapes are known and can be invented.
- **The LLM is provider-configurable, never hardcoded** — an OpenAI-compatible endpoint set in the vault's `config/tiro.yml` (ADR 0004).
- `vault-template/` is the **bootstrap template** for new vaults; the *live* vault's config evolves independently (it currently runs `glm-5.2` while the template ships a generic default). Editing the template does not change the live vault — propagate deliberate changes by hand.

## Repo map

| Path | What |
| --- | --- |
| `packages/shared` | **The content contract — keystone.** Zod frontmatter schemas, slug rules, block alignment, `tiro.yml` config schema |
| `packages/processor` | LLM pipeline CLI (`tiro-process run\|validate`), run by the vault's workflow |
| `apps/extension` | Chrome MV3 clipper (Readability + Turndown → GitHub Contents API) |
| `apps/site` | Astro site (side-by-side reader, Pagefind search), deployed to Cloudflare Pages |
| `vault-template/` | Files to bootstrap a new vault repo |
| `fixtures/vault` | Fake vault for tests and local site dev — its articles must stay contract-valid (test-enforced) |
| `packages/shared/test/fixtures/code-blocks` | **Real** code blocks from the live vault, one per file, expected language in the filename (`plain-` = leave alone). The language detector's corpus — see the exception above |

## Commands

```sh
bun install                          # workspace install
bun run lint                         # Biome (ts/js/json) + Prettier (.astro only)
bun run fix                          # auto-format both
bun run typecheck                    # tsc per package + astro check — part of the verify gate
bun test                             # bun test across all packages
bun run --cwd apps/extension build   # two-pass Vite build → dist/ (load unpacked from there)
bun run --cwd apps/site dev          # site dev against fixtures/vault — no vault clone needed
bun run --cwd apps/site build        # assets + astro build + pagefind — part of the verify gate
bun run process -- --vault <dir> [--slug S] [--force] [--dry-run]
bun run --cwd apps/extension sweep -- --vault <dir> [--baseline <ref>] [--only S]
bun run --cwd apps/extension sweep -- --vault <dir> --fill-languages [--write]
```

## Development workflow

- **Branch.** Work on a dedicated `<type>/<topic>` branch off `main`, not directly on `main`, unless it's trivial work.
- **Commit in focused slices.** One commit per logical slice; keep lint green at each commit so branches stay bisectable. Conventional Commit messages; no `Co-Authored-By` trailers or AI-attribution lines anywhere (commits, PR descriptions).
- **Explain the why in the commit body.** The subject says what changed; the body explains why — the motivation and any non-obvious decision or trade-off. Required for anything beyond trivial edits; `git log` should make sense without opening the PR.
- **Docs and tests ship *with* the change — not later.** The Docs section below says what each page tracks; update every page covering what you touched, cover new logic with tests.
- **Verify before it lands** — the same list CI runs: `bun run lint`, `bun run typecheck`, `bun test`, plus both builds (`--cwd apps/extension build`, `--cwd apps/site build`). Extension UI changes also need a manual pass (load unpacked, clip a page); pipeline changes are tested against `fixtures/vault` with the fake chat client — don't burn live workflow runs or LLM credit to test what a fixture can prove (a curl against the provider answers model/key questions).
- **Bump the extension version by what changed, not by habit.** `apps/extension/manifest.json` holds the only version string in the repo, and `tiro.clipper_version` records it into every article, so the number is how a later audit asks "which clips predate this fix" *for a released build*. (`tiro.clipper_commit` records the source commit beside it — injected by the Vite build, not stored in the repo — which is what answers the same question for an unpacked build, and within a minor that batched several fixes. A `-dirty` suffix marks a build whose tree differed from that commit, so it narrows rather than settles.) **Patch** (`0.9.1`) for a narrow or per-site fix that leaves output unchanged for most pages; **minor** (`0.10.0`) for a new capability, a batch of fixes, or anything that changes output broadly. Three consecutive single-fix minor bumps (0.7.0 → 0.8.0 → 0.9.0) is what prompted writing this down — at that rate 1.0 arrives for trivia. Only bump when the clipper actually changed: a processor- or site-only change touches no version. **And bump at release time, not in the branch that makes the change** — `manifest.json` is the one line every clipper branch would otherwise touch, so per-branch bumps conflict with each other and inflate the number (one afternoon on a single defect once produced three version decisions). Say in the PR what the bump should be and why; cut it when the release is cut, which is what `release-extension.yml` already describes. Between releases `tiro.clipper_commit` tells builds apart exactly, so nothing is lost by waiting.
- **Pushing and opening PRs are user-authorized** — don't push or open a PR unless asked.
- **Merging: rebase-merge single-commit PRs; merge-commit multi-commit PRs.** Never rebase-merge the base of a stacked PR — SHA rewriting breaks every downstream diff. When unstacking a merged base: merge → retarget the next PR to `main` → delete the branch, in that order (deleting first closes the stacked PR).

## Hard invariants — do not break casually

1. **The content contract is shared by three independently shipping components** (extension writes, processor transforms, site reads). Schema/slug/path changes must keep all three in lockstep and bump `tiro.schema` when breaking (ADR 0002). `tiro.schema` versions the article *document* format, not the vault directory layout — layout changes migrate the vault atomically instead of bumping it (ADR 0007).
2. **Slugs are deterministic from the URL** (normalized URL → slug + 8-hex SHA-256), and articles live flat at `articles/<slug>/` so the path itself is the identity (ADR 0007). Re-clipping must overwrite the same article, never duplicate — trailing-slash and tracking-param variants are one identity by design. `normalizeUrl` stays host-agnostic; the one place a publisher may override it is `canonicalizeUrl`, which runs last and today knows only arXiv (ADR 0013) — and only rewrites on a known host, a known paper route and an exact identifier match, because the cost of a wrong rewrite is a silently merged article. Changing a rule renames existing articles: `validate` detects the mismatch, `sweep --recanonicalize` repairs it, and the vault must be migrated in lockstep the way a layout change is.
3. **"Needs processing" = `tiro.processed_at` absent.** The processor is idempotent and retry-safe; never select work by push diffs. Pending articles run cheapest-first under a self-enforced wall-clock budget (`processing.run_budget_ms`), so no single article can starve the queue (ADR 0008).
4. **`zh.md` must be strictly 1:1 block-aligned** with the `index.md` body, `code` and `math` blocks byte-identical (`VERBATIM_BLOCK_TYPES` in `packages/shared/src/blocks.ts`; the processor never sends those to the LLM). A misaligned `zh.md` must never be written; the site falls back to stacked rendering rather than misaligned rows (ADR 0003). The shared parser includes remark-math so `$$…$$` is one block — without it, display math containing a blank line splits in two and can neither be rendered nor translated (ADR 0009).
5. **All clipped HTML passes rehype-sanitize** in `apps/site/src/lib/render.ts` before reaching the public site. Never reintroduce `allowDangerousHtml` at the stringify stage; extend the sanitize schema instead if legitimate tags get stripped. **Anything that generates its own markup runs *after* the sanitize step** — Shiki today — so the allowlist never has to admit the `class`/`style` those emit, which would admit them from clipped markup too (ADR 0009).
6. **`@tiro/shared`'s root export stays browser-safe** (it is bundled into the extension). Anything touching `node:` APIs goes in a subpath export (`@tiro/shared/config`).
7. **Per-article fault isolation in the processor:** a hard failure logs, leaves the article pending, and must never fail the workflow before its commit step. Per-image failures fall back to the hotlink; downloads are guarded (non-public-host rejection, streaming byte cap).
8. **Long work must be resumable, and a stop must always be able to commit.** Translation checkpoints each batch to `articles/<slug>/.tiro-zh-cache.json`, so a run that ends early hands its work to the next one instead of repeating it — written atomically (write-then-rename), non-fatal to read/write/remove *only while nothing depends on it* — a budget deferral does depend on it, so an unwritable checkpoint must surface there as a hard failure rather than a resumable stop — and settled only after the article is recorded as processed — kept on success so a re-clip reuses every unchanged block, dropped on misalignment so a broken translation is never resumed — a torn write, an early discard, or a throw between the `index.md` write and the record silently costs the whole article, the last by reporting a finished one as pending and pruning the assets it points at; the processor's own budget is one absolute deadline that must bind every stage, retry, and HTTP request (the chat client clamps each request to the time left) — checking only between articles and batches lets one article overrun by ~40 minutes; and the commit step runs `if: always()`. Breaking any one of these puts an over-long article back in the state where no number of retries can finish it (ADR 0008).

## Toolchain notes

- **TypeScript is pinned to 6.x** — `astro check` needs the programmatic API the native TS 7 compiler doesn't expose. Don't bump until it does.
- Biome owns ts/js/json; Prettier owns `.astro` only; the Tailwind 4 stylesheet is excluded from Biome (it can't parse `@plugin`/`@custom-variant`).
- `@tiro/shared` ships TypeScript source directly — no build step; every consumer is TS-native (ADR 0001).
- Use the structural `FetchLike` type for injectable fetch, not `typeof fetch` (Bun's type demands `preconnect`).
- The extension clipper must stay an **IIFE** (second Vite pass) — `executeScript`-injected files are classic scripts (ADR 0005).
- Astro glob loaders read `TIRO_VAULT_DIR` (default `fixtures/vault`); a bad base yields a *silently empty* collection, so the guards in `apps/site/src/lib/{vault,articles}.ts` must stay (ADR 0006).
- `wrangler` is pinned in devDependencies so the deploy action never installs it mid-workflow (a historic flake).

## Docs

Update whichever of these covers what you changed — in the same change:

- [docs/architecture.md](docs/architecture.md) — system diagram, data flow, contract summary, credentials table, risk register. Tracks: pipeline stages, workflows, cross-repo wiring.
- [docs/adr/](docs/adr/) — decision records 0001–0014. A reversed decision gets a superseding ADR, not a silent edit.
- [docs/operations.md](docs/operations.md) — day-2 runbook. Tracks: secrets and PAT scopes, LLM config, reprocess/deploy procedures, failure signatures. Anything touching workflows, secrets, or config lands here.
- [vault-template/README.md](vault-template/README.md) — vault bootstrap instructions. Tracks: vault layout, required secrets, manual operations.
- `CHANGELOG.md` — release-worthy milestones under `[Unreleased]`; fine-grained history is the git log.
- `README.md` — repo map and quick start for humans.
