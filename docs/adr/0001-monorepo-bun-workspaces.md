# ADR 0001: Bun-workspaces monorepo; shared package ships TypeScript source

Status: accepted (2026-08)

## Context

Tiro has four TypeScript components (extension, processor, site, shared
contract) that must stay in lockstep, plus a separate content repo
(`tiro-vault`). Every runtime that consumes shared code is TS-native: Bun
(processor, tests), Vite (extension), Astro/Vite (site).

## Decision

- One monorepo with Bun workspaces (`packages/*`, `apps/*`); `bun test` as the
  test runner; pinned `packageManager`.
- `@tiro/shared` exports **TypeScript source directly** (no build step, no
  dist). Browser-safe modules are re-exported from the root entry; modules
  touching `node:` APIs are exposed only via subpath exports so the extension
  bundle stays clean.
- Lint/format: Biome for ts/js/json; Prettier (with `prettier-plugin-astro`)
  scoped to `**/*.astro` only, because Biome cannot format Astro templates.
  The two tools have zero file overlap.

## Consequences

- No stale-artifact bugs and no per-package build orchestration.
- `@tiro/shared` is unusable from plain Node; acceptable — nothing in the
  system runs on plain Node.
- Two formatters exist but never disagree (disjoint file sets, enforced by
  `biome.json` excludes and `.prettierignore`).
