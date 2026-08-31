# Operations Runbook

Day-2 operations for the running Tiro system.

## The moving parts

| Thing | Where |
| --- | --- |
| Live site | <https://tiro.ainaive.com/> (Cloudflare Pages project `tiro`, direct upload) |
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
| extension PAT | Chrome options page only (one per machine) | PAT: `tiro-vault`, Contents RW | clip commits |

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
  "batch marker mismatch" lines. A slow run's log shows per-batch progress and
  per-attempt summary failures.
- **Run budget and long articles** (ADR 0008). `processing.run_budget_ms`
  (default 50 min) is a wall-clock budget the processor enforces itself, sitting
  under the job's `timeout-minutes: 60`. Pending articles are processed
  cheapest-first, and translation is checkpointed per batch into
  `articles/<slug>/.tiro-zh-cache.json`, so an article too long for one run
  resumes on the next instead of restarting — successive runs converge. Nothing
  needs doing when a run reports `budget reached; resuming next run: <slug>`:
  the next push, or a manual dispatch, picks it up.
  - The budget binds every stage, retry, and HTTP request: the chat client
    refuses to start a call with no budget left and clamps each request to
    `min(llm.timeout_ms, remaining)`, and the image stage is clamped the same
    way. Overrun past the budget is therefore at most one already-clamped
    request, so the gap to `timeout-minutes` only needs to cover that. Raise
    both together.
  - A checkpoint is dropped automatically when the article finishes, when its
    translation misaligns, and when `llm.model` or `translation.target` changes.
    Delete the file by hand for a genuinely clean retranslation — `--force`
    deliberately reuses it, or an over-long article could never be retried.
- **LLM request bounds**: `llm.timeout_ms` (default 120000) is per HTTP request,
  `llm.max_retries` (3) per logical call. A *timed-out* request is retried only
  once regardless, since a timeout has already spent its full budget — one stuck
  call costs at most 2x `timeout_ms`, not 4x.
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
  Run workflow with `force: true` and the article's `slug`. Handy too when one
  oversized article is monopolising runs: dispatching a specific slug skips the
  queue entirely.
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
| article stays unprocessed + run line `budget reached; resuming next run` | too long to finish in one run; its checkpoint is committed | nothing — the next run resumes it. Dispatch the workflow to hurry it along |
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

### Domain

`tiro.ainaive.com` is a Pages **custom domain**, configured in the
Cloudflare dashboard (Workers & Pages → `tiro` → Custom domains) — there is
no `wrangler.toml` and the deploy is a direct upload, so no repo config
controls it. Cloudflare owns the proxied `CNAME tiro → tiro-36s.pages.dev`
record itself; don't hand-edit it.

- **`ainaive.com` apex and `www` are a different site** (GitHub Pages,
  `ainaive.github.io`). Never touch those records while working on Tiro.
- `tiro-36s.pages.dev` still serves the same deployments; Cloudflare has no
  way to retire it.
- The domain is mirrored in `apps/site/astro.config.mjs` (`site:`) for
  absolute-URL generation, and hardcoded in `apps/site/public/robots.txt`
  (the `Sitemap:` line) — keep all three in sync if the domain ever moves.
- `robots.txt` welcomes search — traditional engines and AI search or
  user-request agents alike (they cite with links) — and disallows
  AI-training and bulk-scraping crawlers by user agent (the site republishes
  clipped third-party content). The line is drawn by what the agent does
  with the content, not who runs it; new scrapers appear, extend the list
  as they do.

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

### Development machine

- Loaded unpacked from `apps/extension/dist`. After pulling extension
  changes: `bun run --cwd apps/extension build`, then the reload icon on
  `chrome://extensions`. Saved settings survive reloads.
- Settings: owner `hutusi`, repository `tiro-vault` (name only, no owner
  prefix), branch `main`, plus the extension PAT.
- `Alt+Shift+C` (`Option+Shift+C` on macOS) opens the popup. If another
  extension already claimed it, Chrome leaves it unassigned — rebind at
  `chrome://extensions/shortcuts`.

### Data disclosure and the token

Two decisions worth not relitigating:

- **The popup reads the page when it opens**, not when you click Clip — that is
  what builds the preview. The Web Store requires the disclosure and consent for
  that to live *in the product UI* (a privacy page or store listing explicitly
  does not count), so the popup gates the first extraction behind a one-time
  panel. Acceptance is stored under its own `tiroDisclosure` key, not inside
  `tiroConfig`, because the options page saves a freshly built config object and
  would otherwise wipe it on every Save. If the disclosure ever changes what it
  says about data handling, bump `DISCLOSURE_VERSION` in
  `apps/extension/src/storage.ts` — that re-prompts existing users, which the
  policy also requires.
- **The "already clipped" state is local-only by design.** The popup keeps a
  record of successful clips (`tiroClipHistory` in `chrome.storage.local`,
  `owner/repo#branch::slug` → timestamp, capped at 500 — scoped so a vault
  change cannot surface another vault's clips) and checks it on open: a match
  makes the status read "Already clipped \<date\> — clipping again updates
  it." with a "Re-clip to vault" button. It deliberately does *not* ask GitHub,
  because
  the disclosure promises nothing is sent before the Clip click. The state is
  therefore blind to clips made on other machines; the clip flow itself still
  checks GitHub and reports "Updated existing clip." Clearing the record
  (remove the key, or reinstall) only costs the already-clipped statuses.
- **UI language follows the browser, overridable in Settings.** Chrome's
  `_locales` system cannot honor a per-extension override, so the extension
  ships its own en/zh message tables (`apps/extension/src/i18n.ts`). The
  choice lives under its own `tiroLanguage` key (same wipe-on-Save rationale
  as `tiroDisclosure`) and defaults to `auto` — the browser's UI language.
- **The PAT stays in `chrome.storage.local`**, in plaintext. `storage.session`
  is cleared on every browser restart, which would mean re-pasting the token
  daily; and any key the extension could use to encrypt it is reachable by
  anything that has already compromised the profile. The real control is the
  token itself: fine-grained, one repository, Contents RW, one per machine,
  revocable in seconds. That trade is disclosed on the privacy page rather than
  hidden.

### Installing on another computer

No clone or toolchain needed — every `ext-v*` tag publishes a zip.

1. Download `tiro-clipper-<version>.zip` from the repo's Releases page.
2. Unzip it into a **permanent** folder (e.g. `~/Applications/tiro-clipper`).
   Chrome reads an unpacked extension from that path forever — moving or
   deleting the folder breaks the install.
3. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   pick that folder.
4. Open the extension's Settings and fill in owner, repository, branch, and a
   PAT, then hit **Test connection**.

Two things follow from how the extension stores its config
(`chrome.storage.local`, see `apps/extension/src/storage.ts`):

- **Settings do not sync between machines.** Each install is configured by
  hand. This is deliberate — `chrome.storage.sync` would upload the PAT to
  Google.
- **Mint a separate fine-grained PAT per machine** (`tiro-vault`, Contents:
  Read and write) so a lost laptop can be revoked without breaking the other.

An unpacked extension's ID is derived from its folder path, so the ID differs
per machine. Harmless here: nothing depends on a stable ID (no OAuth redirect,
no `externally_connectable`).

### Cutting an extension release

`apps/extension/manifest.json` holds the only version string in the repo.

1. Bump `version` there and commit.
2. Tag `ext-v<version>` (matching exactly) and push the tag.
3. "Release extension" builds, verifies the tag against the manifest, zips
   `dist/` with `manifest.json` at the archive root, and attaches it to a new
   GitHub Release.

A tag that disagrees with the manifest fails the run before publishing
anything. `bun run --cwd apps/extension package` produces the same zip
locally; `workflow_dispatch` builds one as a workflow artifact without
publishing a release.

### Chrome Web Store

Published **unlisted**: installable from the link, invisible in search. That
buys auto-updates, a stable extension ID, and no Developer-mode banner — worth
the $5 one-time registration for a tool installed on more than one machine.

Everything the dashboard asks for is drafted in
`apps/extension/store/listing.md` (description, single-purpose statement,
per-permission justifications, data-use declarations) with the images and their
regeneration steps in `apps/extension/store/README.md`. Keep that file honest:
a listing that disagrees with the manifest is how a review gets rejected.

The privacy policy Google requires — the extension handles a GitHub token, which
counts as authentication information — is a page on the site,
<https://tiro.ainaive.com/privacy/> (`apps/site/src/pages/privacy.astro`). It
must stay reachable for as long as the item is published.

**Publishing an update**: cut an `ext-v*` release as above, then upload that
same zip in the dashboard as a new version. The manifest version is what
triggers client updates, so it must be higher than the published one — the tag
guard in the release workflow is what keeps that number trustworthy.

On a machine that installs from the store, **remove the unpacked copy** —
otherwise two copies of the extension are clipping. The store assigns its own
permanent extension ID, unrelated to the unpacked one.

## Known failure signatures

| Symptom | Cause | Action |
| --- | --- | --- |
| `403 model_access_denied` in processing | model not activated for the key's Bailian workspace, or wrong model id | curl self-test; fix activation or `tiro.yml` |
| Deploy fails in "Deploy to Cloudflare Pages" with tarball/network errors | transient infra | Re-run; wrangler is pinned so the historic install-flake is gone |
| Extension "Repository not found" | wrong owner/repo field values, or PAT lacks the repo | curl `api.github.com/repos/hutusi/tiro-vault` with the PAT: 200 → fields, 404 → token access |
| `image kept as hotlink (…)` in processing logs | per-image guard (non-public host, size cap, non-image response, fetch error) | by design; article still processes |
| Article on site but raw (no summary/translation) | it's still pending after a failed run | see Reprocessing |
| One article's `processing <slug>` line with no completion, run after run | the run budget is too small for it, or it is failing mid-translation | check for `.tiro-zh-cache.json` growing between runs — growing means it is converging, static means a real failure |
| Several articles pending while only one is ever attempted | pre-ADR-0008 alphabetical ordering starved the rest | fixed: articles now run cheapest-first under a budget |
