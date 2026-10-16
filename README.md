# Tiro

A personal read-it-later tool and external knowledge base.

Clip a page from Chrome → it lands as Markdown in a GitHub repo (the
"vault") → a job — a GitHub Actions workflow, or the same scripts on a server
of your own — summarizes, tags, and translates it to Chinese with an LLM → an
Astro site publishes original and translation side by side with full-text
search.

This monorepo holds all the code; content lives in a separate vault repo
(`tiro-vault`, bootstrapped from [`vault-template/`](./vault-template/)).

## Layout

| Path | What |
| --- | --- |
| `packages/shared` | The content contract: frontmatter schema, slug rules, block alignment, config schema |
| `packages/clip` | Page → Markdown (Readability + Turndown and the repair pass around them), shared by the extension and `sweep` |
| `packages/processor` | LLM pipeline CLI, and the vault job's scripts (`job/`) — run by the vault's GitHub Actions workflow, or on another host |
| `apps/extension` | Chrome MV3 clipper: popup, options, worker; clips with `packages/clip`, commits via the GitHub API |
| `apps/shortcut` | The "Save to Tiro" iPhone shortcut: saves a shared link into the vault's inbox (`bun run --cwd apps/shortcut build` on a Mac) |
| `apps/site` | Astro site, deployed to Cloudflare Pages (<https://tiro.ainaive.com/>) |
| `vault-template/` | Files to bootstrap a new `tiro-vault` repo |
| `fixtures/vault` | A tiny fake vault for tests and local site development |
| `docs/` | [Architecture](./docs/architecture.md), [ADRs](./docs/adr/), and the [operations runbook](./docs/operations.md) |

## Development

Requires [Bun](https://bun.sh) (version pinned in `package.json`).

```sh
bun install
bun run lint       # Biome + Prettier (.astro only) + shellcheck (job scripts)
bun run typecheck  # tsc across all packages
bun test           # bun test across all packages
```

## License

[MIT](./LICENSE).
