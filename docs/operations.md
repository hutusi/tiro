# Operations Runbook

Day-2 operations for the running Tiro system.

## The moving parts

| Thing | Where |
| --- | --- |
| Live site | <https://tiro-36s.pages.dev/> (Cloudflare Pages project `tiro`, direct upload) |
| Content vault | <https://github.com/hutusi/tiro-vault> (private) |
| Processing workflow | tiro-vault → Actions → "Process articles" |
| Deploy workflow | tiro → Actions → "Deploy site" |
| LLM config | `config/tiro.yml` in the vault |

## Secrets and tokens

All fine-grained PATs expire (max ~1 year) — when clips or deploys start
failing with 401/404, check these first and rotate.

| Secret | Lives in | Scope | Purpose |
| --- | --- | --- | --- |
| `TIRO_LLM_API_KEY` | tiro-vault | Bailian API key | LLM calls |
| `TIRO_DISPATCH_TOKEN` | tiro-vault | PAT: `tiro`, Contents RW | fire `repository_dispatch` after processing |
| `VAULT_READ_TOKEN` | tiro | PAT: `tiro-vault`, Contents R | deploy checks out the private vault |
| `CLOUDFLARE_API_TOKEN` | tiro | Account → Cloudflare Pages: Edit | `wrangler pages deploy` |
| `CLOUDFLARE_ACCOUNT_ID` | tiro | (not sensitive) | wrangler target account |
| extension PAT | Chrome options page only | PAT: `tiro-vault`, Contents RW | clip commits |

Rotate a GitHub secret with `gh secret set NAME -R hutusi/<repo>` (prompts for
the value); the extension PAT is re-pasted in its options page.

## LLM configuration

`config/tiro.yml` in the vault sets `base_url`, `model`, optional
`summary_model`/`translation_model`, and `api_key_env`. Any OpenAI-compatible
endpoint works.

- **Current working setup**: `https://dashscope.aliyuncs.com/compatible-mode/v1`
  with `model: glm-5.2`. This key has **GLM access only** — `qwen-*` and the
  docs' prefixed `ZHIPU/GLM-*` ids return `model_access_denied`.
- The summary call needs a model supporting JSON mode
  (`response_format: json_object`); translation does not.
- **`translation.target` is `zh` and nothing else.** The schema rejects other
  values on purpose: the artifact is always named `zh.md` and the language
  detector only distinguishes Chinese from non-Chinese, so any other target
  would translate every article — Chinese originals included.
- **Image downloads** are bounded per image (`images.max_bytes`,
  `images.timeout_ms`) and per article (`images.max_count`,
  `images.total_max_bytes`, `images.stage_timeout_ms`). Hitting an aggregate
  cap leaves the remaining images hotlinked and logs one line — it never fails
  the article. Raise them only if the process job has headroom under its
  `timeout-minutes`.
- **Translation speed** is governed by `translation.batch_chars` (default
  10000): chars of source text per LLM call. Bigger batches = fewer, faster
  runs, but the translated output must fit the provider's per-request output
  cap — raise cautiously; lower it if the log shows repeated
  "batch marker mismatch" lines. A slow run's log now shows per-batch
  progress and per-attempt summary failures; the process job is bounded by
  `timeout-minutes: 30` (a killed run loses nothing — uncommitted articles
  retry next run, though their LLM calls are re-billed).
- Self-test a key/model without burning workflow runs:

  ```sh
  curl -s https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}]}'
  ```

## Reprocessing articles

Articles are selected by the missing `tiro.processed_at` frontmatter marker,
so re-runs are always safe no-ops for finished articles.

- **Retry pending/failed articles**: tiro-vault → Actions → Process articles
  → Run workflow (no inputs), or `gh workflow run process.yml -R hutusi/tiro-vault`.
- **Redo one article** (e.g. after a bad summary):
  Run workflow with `force: true` and the article's `slug`.
- **Redo everything**: `force: true`, no slug. Re-bills every article.
- **Locally**: `TIRO_LLM_API_KEY=… bun run process -- --vault ../tiro-vault`
  (then commit/push the vault yourself).
- **Contract check over the whole vault**:
  `bun run packages/processor/src/cli.ts validate --vault ../tiro-vault`.
  Checks frontmatter schema, that each directory name still equals the slug
  derived from its `url` (invariant 2), that no article is nested below
  `articles/<slug>/`, and that every `zh.md` belongs to an article that should
  have one and stays block-aligned with it. Exits non-zero on any of these —
  `run` only warns, so this is the only thing that fails on a violation.

### Failure markers

| Marker | Meaning | Fix |
| --- | --- | --- |
| `tiro.summary_failed: true` | the model returned unusable JSON three times; excerpt used | reprocess with `force` + slug |
| `tiro.translation_failed: true` | translation misaligned/failed; no `zh.md` | reprocess with `force` + slug |
| article stays unprocessed + run warning `failed and stays pending` | hard error (e.g. provider 403, timeout, network) at either LLM stage | fix the cause; next run retries automatically |
| run fails at "Commit results back" with `could not apply` | rebase conflict with a concurrent commit (was: queued runs checking out the stale trigger SHA) | re-run the workflow; pending articles retry. Guarded by `ref: main` checkout + `git pull --rebase -X theirs` |

## Deploys

Triggered by: push to `main` in tiro, `vault-updated` dispatch from the vault,
or manually (Actions → Deploy site → Run workflow). Wrangler is pinned in
devDependencies — the action must log "using pre-installed wrangler".

- A failed deploy is always safe to **Re-run** from the Actions UI.
- **Empty-vault guard**: the build refuses to publish a site with zero
  articles. Keep at least one article in the vault.
- Deleting an article: remove its directory from the vault and push — the
  push triggers processing (a no-op) which triggers a redeploy.

## Vault layout migrations

The vault layout is `articles/<slug>/` (flat, ADR 0007). A layout change is
a lockstep event: land the code on `main` first, then immediately push one
`git mv` commit in tiro-vault moving every article to the new scheme — the
vault workflow always checks out tiro@`main`, so the window between the two
pushes must stay deploy-free (the empty-glob guard fails any deploy in that
window safely). The 0007 migration was
`git mv articles/<year>/<slug> articles/<slug>` for each article.

- **Preflight**: check that no slug appears under more than one year
  (`ls -d articles/*/*/ | awk -F/ '{print $3}' | sort | uniq -d` must print
  nothing) — `git mv` onto an existing target directory silently nests the
  source into it instead of failing. `validate` reports the same state
  afterwards, as `nested article`.
- **Don't clip during the window.** The extension deploys by hand (rebuild +
  reload), so the order is: land the code, migrate the vault, reload the
  extension, then clip. An old extension against a migrated vault re-creates
  year directories; a new extension against an unmigrated vault duplicates
  the article at the flat path.

## Extension

- Loaded unpacked from `apps/extension/dist`. After pulling extension
  changes: `bun run --cwd apps/extension build`, then the reload icon on
  `chrome://extensions`. Saved settings survive reloads.
- Settings: owner `hutusi`, repository `tiro-vault` (name only, no owner
  prefix), branch `main`, plus the extension PAT.

## Known failure signatures

| Symptom | Cause | Action |
| --- | --- | --- |
| `403 model_access_denied` in processing | model not activated for the key's Bailian workspace, or wrong model id | curl self-test; fix activation or `tiro.yml` |
| Deploy fails in "Deploy to Cloudflare Pages" with tarball/network errors | transient infra | Re-run; wrangler is pinned so the historic install-flake is gone |
| Extension "Repository not found" | wrong owner/repo field values, or PAT lacks the repo | curl `api.github.com/repos/hutusi/tiro-vault` with the PAT: 200 → fields, 404 → token access |
| `image kept as hotlink (…)` in processing logs | per-image guard (non-public host, size cap, non-image response, fetch error) | by design; article still processes |
| Article on site but raw (no summary/translation) | it's still pending after a failed run | see Reprocessing |
