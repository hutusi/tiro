# Tiro

A personal read-it-later tool and external knowledge base.

Clip a page from Chrome → it lands as Markdown in a GitHub repo (the
"vault") → a GitHub Actions workflow summarizes, tags, and translates it to
Chinese with an LLM → an Astro site publishes original and translation side
by side with full-text search.

This monorepo holds all the code; content lives in a separate vault repo
(`tiro-vault`, bootstrapped from [`vault-template/`](./vault-template/)).

## Layout

| Path | What |
| --- | --- |
| `packages/shared` | The content contract: frontmatter schema, slug rules, block alignment, config schema |
| `packages/processor` | LLM pipeline CLI, run by the vault's GitHub Actions workflow |
| `apps/extension` | Chrome MV3 clipper (Readability + Turndown → GitHub Contents API) |
| `apps/site` | Astro site, deployed to Cloudflare Pages (<https://tiro.ainaive.com/>) |
| `vault-template/` | Files to bootstrap a new `tiro-vault` repo |
| `fixtures/vault` | A tiny fake vault for tests and local site development |
| `docs/` | [Architecture](./docs/architecture.md), [ADRs](./docs/adr/), and the [operations runbook](./docs/operations.md) |

## Development

Requires [Bun](https://bun.sh) (version pinned in `package.json`).

```sh
bun install
bun run lint       # Biome + Prettier (.astro only)
bun run typecheck  # tsc across all packages
bun test           # bun test across all packages
```

## License

[MIT](./LICENSE).
