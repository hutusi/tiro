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
- **Oversized blocks.** `translation.max_block_chars` (default 20000) is not a
  batching knob: a top-level block is the unit alignment is built on and is
  never split, so a block bigger than this would be sent alone and expect an
  equally large response. Above it the block is copied through untranslated and
  the log says how many — look for `block(s) over N chars kept untranslated`.
  The case it exists for is a long reference list (an arXiv bibliography ran to
  47K chars as a single list), which is not worth translating anyway.
- **A batch that fails in transport falls back to per-block**, the same as one
  whose markers came back wrong — `batch N/M failed (…)` then
  `falling back to per-block translation`. Slower, but a single slow batch no
  longer ends the article, which mattered once checkpoints made the next run
  resume at exactly that batch.
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
  - A `--force` article the budget defers has its `processed_at` cleared and
    returns to pending, so an ordinary run finishes it — expect a
    marker-stripping commit for it. Its summary, tags and `zh.md` are untouched,
    so the site keeps rendering it meanwhile.
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

## Repairing clip-time markdown defects

A clipper fix only helps the *next* clip: the vault keeps whatever Turndown
produced at the time. `repair` rewrites the defects the clipper used to emit —
link titles that span lines (which markdown reads as a setext heading, turning
a paragraph into a giant `<h1>`), links whose text was pushed onto its own
lines by a block child, synthesized empty table header rows, LaTeXML's
duplicated list-item labels, the permalink `#` a generator appends to every
heading, and images indented far enough that markdown reads them as code.

Two of those have no clipper counterpart, so a re-clip reproduces them: the
split footnote labels Readability itself creates on `<br><br>` pages, and the
heading permalinks. The indented-image repair is the one transform that runs
*before* the verbatim masking rather than inside it — the block it fixes is a
code block, so the protection that keeps every other transform from touching
code would otherwise hide it. It asks the parser for top-level code blocks
whose every line is an image, which is also why content legitimately indented
inside a list is out of reach: that belongs to a `list` block, never a
top-level `code` block.

```sh
bun run packages/processor/src/cli.ts repair --vault ../tiro-vault --dry-run
bun run packages/processor/src/cli.ts repair --vault ../tiro-vault
```

It takes no LLM calls and no budget. `--slug` limits it to one article;
`--dry-run` reports without writing. Read the diff before committing the vault.

`index.md` and `zh.md` are rewritten together or not at all. These transforms
change block structure by design, and `zh.md` must stay strictly 1:1 aligned
with the body (invariant 4), so the result is checked before anything is
written and a pair that no longer aligns is left untouched and reported. That
exit is non-zero: a refusal is the guard working, but it is also the only
signal that an article still carries a defect.

Killing the process can still tear a pair. Both files are staged and then
renamed, so everything that can realistically fail happens while the originals
are intact — but a kill landing between the two renames leaves one file repaired
and one original. That state is not silent: `validate` reports it immediately as
an alignment error, and `git checkout` on the article undoes it. A write-ahead
log with startup recovery would close the window and is not worth its own
failure modes here — unlike the processor's checkpoint (ADR 0008), which exists
because the workflow kills it on a timer, `repair` is hand-run, interactive, on
git-tracked files, and ends in reading the diff.

**A refusal means re-clip, not retry.** It happens when the two sides were not
damaged identically — usually because the translator shifted content across the
damaged blocks — and no symmetric text edit can fix that. Re-clip the page with
a current extension (the slug is deterministic, so it overwrites in place), then
delete `tiro.processed_at` to have it re-summarized and re-translated.

Re-clipping is also the only fix for math clipped before the extension
recovered LaTeX: those equations hold the MathML's rendered glyphs concatenated
with escaped LaTeX, and nothing can reliably tell the two apart afterwards.

## Reprocessing articles

Articles are selected by the missing `tiro.processed_at` frontmatter marker,
so re-runs are always safe no-ops for finished articles.

- **Retry pending/failed articles**: tiro-vault → Actions → Process articles
  → Run workflow (no inputs), or `gh workflow run process.yml -R hutusi/tiro-vault`.
- **Redo one article** (e.g. after a bad summary):
  Run workflow with `force: true` and the article's `slug`. Handy too when one
  oversized article is monopolising runs: dispatching a specific slug skips the
  queue entirely.
- **Redo everything**: `force: true`, no slug. Re-runs images, summaries and
  tags for every article. Translations are *reused* where the block's source
  text is unchanged — the checkpoint is content-addressed, so a reuse is only
  ever the same input translated by the same model (ADR 0008). To genuinely
  re-translate, change `llm.model` or `translation.target` in `tiro.yml`, which
  invalidates every checkpoint wholesale, or delete the article's
  `.tiro-zh-cache.json`.
- **Locally**: `TIRO_LLM_API_KEY=… bun run process -- --vault ../tiro-vault`
  (then commit/push the vault yourself).
- **Contract check over the whole vault**:
  `bun run packages/processor/src/cli.ts validate --vault ../tiro-vault`.
  Checks frontmatter schema, that each directory name still equals the slug
  derived from its `url` (invariant 2), that no article is nested below
  `articles/<slug>/`, and that every `zh.md` belongs to an article that should
  have one and stays block-aligned with it. Exits non-zero on any of these —
  `run` only warns, so this is the only thing that fails on a violation.

### Math rendering

The site reads `$…$` as a math delimiter only for articles whose frontmatter
says `has_math: true`. Everywhere else only `$$…$$` typesets, so prose like
"it costs $5 to $10" is never mistaken for a formula (ADR 0009).

`has_math: true` is a **promise about the file**, not a note that it contains
maths: *every literal `$` in the prose is escaped as `\$`, so every bare `$…$`
is a formula.* The clipper keeps that promise by escaping as it converts. Set
the flag by hand only if you keep it too.

- **An article's inline math is not typeset**: escape every literal `$` in its
  prose as `\$`, then add `has_math: true`. Push — no reprocessing needed, the
  flag is read at site build time. Adding the flag *without* escaping is how
  you get the next bullet.
- **Prose is being typeset as a formula**: either escape that `$` as `\$`, or
  set `has_math: false` if the article has no inline math worth keeping.
  Block-level `$$…$$` still renders either way.
- **A paragraph is one red error blob, or the article is half untranslated**:
  a line beginning `$$` that never closes runs to the end of the document, the
  way an unterminated code fence does. `splitBlocks` re-reads it as prose, so
  this should not happen — if it does, escape the `$$` as `\$\$`.
- **The clipper missed the math entirely** (the source page ships no LaTeX,
  only rendered glyphs): the formulas are gone from the markdown, and the flag
  cannot bring them back. MathJax v4 in its default configuration is the case
  to expect — it keeps no TeX in the page at all — and the symptom is prose
  with a gap in it, like "the quadratic formula is and it solves any
  quadratic". Nothing marks the article, so it is worth a glance after clipping
  a page you know had formulas. Re-clip if the page has since changed; otherwise fix
  the markdown by hand.

Both panes of a translated article render with the same setting, so a formula
in the original is a formula in the translation.

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
- **Redirects** live in two places on purpose: `apps/site/public/_redirects`
  is what Cloudflare Pages serves as real 301s at the edge, and the
  `redirects` map in `apps/site/astro.config.mjs` mirrors it so `astro dev`
  redirects too and the static build carries meta-refresh pages as a
  fallback. Today both map `/tags/` and `/categories/` to `/search/`
  (ADR 0014); change them together.
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

## Slug migrations

A *layout* change moves every article; a **slug-rule** change moves only the
articles whose URLs the rule touches, and it is the identity itself that moves.
Adding arXiv canonicalization (ADR 0013) renamed 2 of 36 articles. The gate is
`validate`, which recomputes `slugForUrl(frontmatter.url)` per article and exits
non-zero when it disagrees with the directory name; the repair is
`sweep --recanonicalize`, which is the only thing that can carry it out.

Why it matters: an article under a stale name is invisible to the next clip of
its own page. The clip derives the new slug, finds nothing there, and creates a
second article beside the first.

```sh
# 1. Land the code on main. The vault workflow checks out tiro@main, so the
#    window between this and step 3 must stay deploy-free.

# 2. Report first — this run writes nothing.
bun run --cwd apps/extension sweep -- --vault ../tiro-vault --recanonicalize

# 3. Apply, then check the diff before committing.
bun run --cwd apps/extension sweep -- --vault ../tiro-vault --recanonicalize --write
git -C ../tiro-vault status

# 4. The gate. Must report 0 errors.
bun run packages/processor/src/cli.ts validate --vault ../tiro-vault

# 5. Commit in the vault, then deploy by hand: a hand-pushed vault change
#    never dispatches vault-updated, so the site would keep serving old
#    content silently.
gh workflow run "Deploy site" --repo hutusi/tiro --ref main
```

- **Bodies and `zh.md` are never touched.** Block alignment cannot move,
  `tiro.processed_at` survives, and nothing is re-queued — the migration costs
  no LLM calls. Re-clipping the two arXiv articles instead would have meant
  re-translating ~2,100 lines with no `.tiro-zh-cache.json` to resume from.
- **Site URLs change and there are no redirects.** The moved articles 404 at
  their old paths; the feed and sitemap regenerate on deploy.
- **Don't clip during the window**, for the same reason as a layout migration:
  a new extension against an unmigrated vault duplicates the article at the new
  slug.
- **An existing target is refused, not renamed onto** — `rename` nests the
  source inside an existing directory rather than failing. The run reports it
  and exits non-zero.

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

### The arXiv permission

`https://arxiv.org/*` is an **optional** host permission, not one held at
install (`optional_host_permissions` in `manifest.json`). The popup asks for it
the first time you clip an arXiv paper, from the Clip flow's own user gesture —
`chrome.permissions.request` refuses without one, which is why an already-granted
popup skips the call rather than making it on open.

- Granted: an arXiv page behaves like any other — preview on open, one click.
- Not granted: nothing is fetched. The tab is previewed as usual and a
  "Fetch HTML full text" button appears beside it.
- Revoking it (`chrome://extensions` → Details → Site access) returns the
  extension to clipping whatever the tab shows.

Being optional is what keeps an update from being disabled pending re-approval;
a required host permission would add an install-time warning and force one.

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
  policy also requires. It is at **2**: adding the optional arxiv.org fetch put
  a second network destination in the disclosure, and a new destination is a
  practice change whichever way the permission is answered. Both language
  tables have to say so — a test in `test/i18n.test.ts` asserts that every host
  named in the disclosure is named in both, because an edit once landed in the
  English copy and silently missed the Chinese one that this extension actually
  shows.
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

### Sweeping the corpus for clip damage

A clipper failure is silent by construction: an image Readability deleted leaves
nothing behind to notice, so nothing in the vault records that it is missing.
Two of the three articles that lost every image to `MEDIA-DROP` had been live
for a week. The sweep asks the only question that finds those — clip the page
again and compare.

```sh
# Which articles would gain from a re-clip? (the usual one)
bun run --cwd apps/extension sweep -- --vault ../../../tiro-vault

# Did my clipper change break anything on the corpus?
bun run --cwd apps/extension sweep -- --vault ../../../tiro-vault --baseline main

# One article, by slug fragment
bun run --cwd apps/extension sweep -- --vault ../../../tiro-vault --only apple
```

Everything lives under `apps/extension/.sweep-cache/` (gitignored), in two
directories that are deliberately separate. `pages/` holds the fetched HTML, so
the first run costs one request per article and later runs cost none — which is
also what makes a `--baseline` comparison compare the *clipper* rather than
whatever the sites served that minute. **Delete `pages/` to refresh; leave
`baselines/` alone.** `baselines/` holds git worktrees, and deleting a
registered worktree's directory by hand leaves git refusing to re-create it at
that path (the sweep runs `git worktree prune` first to recover from exactly
that, but `git worktree remove` is the tidy way). Worktrees are named by the
resolved commit, never by the ref, so a `--baseline main` run after `main` moves
checks out the new commit instead of silently reusing the old one.

#### Backfilling fence languages

`--fill-languages` is the third mode. It and `--recanonicalize` (see **Slug
migrations** above) are the two that write to the vault.
It re-clips each page and copies the fence languages today's clipper recovers
onto the bare fences already committed — which is how a clip taken before the
language chain existed gets its labels without a re-clip (ADR 0012).

```sh
# What would it label? (reports only)
bun run --cwd apps/extension sweep -- --vault ../../../tiro-vault --fill-languages

# Apply it
bun run --cwd apps/extension sweep -- --vault ../../../tiro-vault --fill-languages --write
```

Read the report before passing `--write`, and commit the vault separately from
anything else so the diff stays reviewable. Lines beginning `!` are fences left
bare because the page's declared language and the site's inference disagree —
pages do get this wrong, and `claude.com/blog` mislabelled 4 of its own 13
blocks. Judge those by hand; writing one in makes it permanent. The edit touches nothing but each
fence's opening line, and it rewrites `index.md` and `zh.md` together — a
language in one file alone breaks the byte-identity `checkAlignment` requires of
code blocks, which drops the article out of side-by-side rendering silently. An
article whose two files do not correspond is refused rather than half edited,
and an article with no `zh.md` has only its `index.md` written. Both files go
through a temporary and a rename, so an interrupted run leaves the article as it
was rather than half-labelled.

It does not touch `tiro.processed_at`, so nothing becomes pending and the
processor will not re-run. `.tiro-zh-cache.json` is keyed by content hash but
holds no verbatim blocks, so relabelling a fence orphans nothing.

Read the output as a prompt for judgement, not a verdict:

- **A positive delta is a re-clip candidate**, and worth confirming is caused by
  a fix rather than by the page having changed since it was clipped. Run again
  with `--baseline <the ref that shipped the fix>` to separate them.
- **A negative delta needs a look before acting.** Both that the first run found
  were fine: one article's four "lost" images are commenter avatars, and the
  other is a pre-existing extraction gap both clipper versions share. Two clips
  differing is not the same as the newer one being wrong.
- **`?` lines are the sweep's own blind spots**, not findings. Fetch failures,
  and pages that clip to almost nothing because they build their article in
  JavaScript (`--min-chars`, default 500). Every article failing exits non-zero;
  some failing does not, because that is a fact about those articles.

Refreshing `pages/` is not free: several sites in the corpus answer a second
cold run with 403 or 429, so a refresh can leave you with fewer readable
articles than you started with. Refresh when you mean to re-measure against
today's web, not as routine hygiene.

#### What it cannot see

Three limits, each of which can make a result *wrong* rather than merely
incomplete. A sweep that is quietly unsound is worse than no sweep.

1. **It reads raw HTML; the extension reads Chrome's rendered DOM.** A page that
   builds its article in JavaScript arrives as a shell — four articles in the
   current corpus do — and lazy-loaded images resolve in a browser and not here.
   Those are flagged, but the flag is a heuristic on length. Only a headless
   browser fixes this properly, and that is a different tool.
2. **`--baseline` resolves dependencies from the working tree.** The worktree
   holds source, not `node_modules`, so both sides import today's Readability
   and Turndown. That is what you want when judging your own change and exactly
   wrong when judging a dependency bump, which would read as byte-identical. The
   run warns when the baseline's `bun.lock` differs; believe the warning.
   The shell heuristic is suspended in `--baseline` mode unless *both* sides are
   thin — when the baseline reads a page fine and the working tree gets nothing
   from it, that is the worst regression the clipper can have, not a shell.
3. **The corpus contains the shapes it contains.** Every guard in
   `unwrapMediaWrappers` exists for a failure this sweep reports as
   byte-identical, because no vault page wraps a lone figure in a sidebar. It
   finds corpus regressions; a green sweep is not a safety argument, and
   adversarial shapes belong in `apps/extension/test/dom-prepare.test.ts`.

### Cutting an extension release

`apps/extension/manifest.json` holds the only version string in the repo.

1. Bump `version` there and commit — **patch** for a narrow or per-site fix,
   **minor** for a new capability or a batch of them. The number is what
   `tiro.clipper_version` stamps into every article, so it is how a later audit
   identifies which clips predate a given fix; a version that moves for reasons
   other than what changed makes that question harder to answer.

   A build with git available also records `tiro.clipper_commit` — `git
   describe --tags --always --dirty --match 'ext-v*'`, run by the Vite build —
   so provenance does not depend on remembering to bump. Use it when the
   version cannot answer the question: an unpacked build reports the release it
   is *near*, and a minor that batched several fixes cannot say which of them a
   clip predates. The field is absent entirely from a build with no git to ask
   (a source zip, a checkout without history), which is why it is optional.

   To ask whether a clip contains a given fix, **strip any `-dirty` suffix
   first** — git rejects the full description as a revision:

   ```sh
   commit=${recorded%-dirty}
   git merge-base --is-ancestor <fix-commit> "$commit" && echo "has the fix"
   ```

   A `-dirty` suffix means the build came from a modified tree, so it records
   *the commit the build was based on, plus the fact that it differed* — not
   the build itself. Two different dirty builds off the same commit record the
   same value, so it narrows an investigation rather than settling it; only the
   artifact or the diff identifies such a build exactly. Expect this on
   anything loaded unpacked.
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
| Site build logs `shiki: no grammar for "x"` | a fence whose language is outside the curated grammar list in `apps/site/src/lib/highlight.ts` | harmless — the block renders as plain text. Add the grammar there if the language is worth supporting |
| A code block is highlighted as the wrong language | a bare fence, inferred wrongly by `packages/shared/src/detect-language.ts` (ADR 0012) | add the block to `packages/shared/test/fixtures/code-blocks/` with the right answer in its filename, then tighten the rule that fired. Nothing is wrong in the vault — the guess is made at build time |
| A code block that is prose is highlighted at all | the same, and the more serious direction: about 16 of the vault's fenced blocks are prose | as above, expecting `plain-` — and prefer narrowing the rule over adding a prose test, since nothing should fire without a positive signature |
| A red formula on the page, `katex-error` in the HTML | the clipped LaTeX does not parse | by design: KaTeX never fails the build. Hover the formula for KaTeX's own message, then fix the markdown in the vault |
| A formula renders as literal `$x$` text | the article has no `has_math: true` | see Math rendering above |
| A price renders as a formula | `has_math: true` on an article whose literal dollars are not escaped | escape them as `\$`, or clear the flag |
| The search page shows "搜索索引在构建后生成" in production | `pagefind --site dist` did not run after `astro build`, so `dist/pagefind/` is missing | check the deploy log for the pagefind step; the results UI imports `/pagefind/pagefind.js` and shows the notice when that import fails |
| `zh.md` contains `TIROMATH0` | a checkpoint written before math restoration — should be impossible | delete `.tiro-zh-cache.json` and reprocess with `force` + slug |
