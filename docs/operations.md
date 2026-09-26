# Operations Runbook

Day-2 operations for the running Tiro system.

## The moving parts

| Thing | Where |
| --- | --- |
| Live site | <https://tiro.ainaive.com/> (Cloudflare Pages project `tiro`, direct upload) |
| Content vault | <https://github.com/hutusi/tiro-vault> (private) |
| Processing workflow | tiro-vault → Actions → "Process articles" |
| Publish workflow | tiro-vault → Actions → "Publish collections" |
| Deploy workflow | tiro → Actions → "Deploy site" |
| LLM config | `config/tiro.yml` in the vault |

## Secrets and tokens

All fine-grained PATs expire (max ~1 year) — when clips or deploys start
failing with 401/404, check these first and rotate.

**The two held by workflows warn before they expire** (ADR 0032). A weekly
"Token expiry" workflow in each repo — `tokens.yml`, checking
`VAULT_READ_TOKEN` in tiro and `TIRO_DISPATCH_TOKEN` in the vault — reads the
expiry date GitHub reports for the token and turns red, so GitHub emails you,
once fewer than 30 days are left, or at once if the token is already refused.
Its run summary shows the date and the days left. Both call the one check in
`hutusi/tiro/.github/actions/token-expiry`, so the vault's copy of the workflow
never needs updating for a fix to it.

- **On first setup, run it by hand** (Actions → Token expiry → Run workflow)
  and compare the date it prints with the one on
  <https://github.com/settings/tokens>. It is the only check that the header
  means what the workflow assumes.
- The extension PAT lives only in a browser, so the extension checks it: its
  Settings page's **Test connection** says when the token expires, and shows
  it as a warning under 30 days. Worth a press now and then — nothing prompts it. The
  LLM key and the Cloudflare token are not checked: neither is a GitHub
  token.
- The vault's copy needs `vault-template/.github/workflows/tokens.yml` copied
  in by hand, like the other workflows.

| Secret | Lives in | Scope | Purpose |
| --- | --- | --- | --- |
| `TIRO_LLM_API_KEY` | tiro-vault | Bailian API key | LLM calls |
| `TIRO_DISPATCH_TOKEN` | tiro-vault | PAT: `tiro`, Contents RW | fire `repository_dispatch` after processing, and on a collections push |
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
  the next push, the daily run (03:17 UTC), or a manual dispatch picks it up
  (ADR 0032).
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
    translation misaligns, and when `translation.target` or the translating model
    changes — that being `llm.translation_model`, or `llm.model` when unset.
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

### PDFs

A PDF is clipped as a stub and converted during processing (ADR 0026): the
processor fetches the document, reads its text layer, and asks the model to
restore Markdown structure. No extra provider capability is needed — it is text
in, text out, on the same OpenAI-compatible endpoint everything else uses, which
is why this route was chosen over sending page images to a vision model.

The `pdf` block in `config/tiro.yml` bounds it: `max_bytes` and `timeout_ms` for
the download, `stage_timeout_ms` for the whole stage, `max_pages` above which a
document is refused rather than truncated, and the two halves of the gate that
separates a born-digital PDF from a scan: `min_chars_per_page` (real papers
measure 2600-2800, so the default of 100 sits well below anything carrying
prose) and `min_page_coverage`, the fraction of pages that must carry text at
all. Both are needed — an average is a sum, so one dense page among nine
scanned ones clears the first on its own, and the article would be filed as a
whole document while holding a tenth of it.

**Most PDFs never reach the model.** A document whose typography carries a
heading hierarchy or a fixed-width face has its structure read straight off the
page — headings from the size rank, fenced code from the monospace runs, lists
from the bullets, paragraphs from the gaps the document itself put between its
lines (ADR 0028). The run log says which happened: `structure read from the
layout … no model call`, or `no legible layout; restoring structure with the
model`.

What a converted article will not have, either way: figures (they are not in
the text layer — captions survive), equations as anything but flattened text,
and reconstructed tables. Tabular blocks are recognised by their column
alignment and fenced rather than rebuilt, which is deliberate: a mis-read
column corrupts data while a fenced block only looks plain.

### Importing a PDF from this computer

A document with no web address — a report, something a tool generated — is
imported from the extension's **options page** rather than clipped: open
Settings, then **Import a PDF**. The extension reads the text layer there and
commits it; the processor restructures it on the next run like any other PDF.

What is different from a clipped one:

- It is filed under `local:<filename>`, and the article slug is derived from
  that the way every other slug is derived from its URL — `report.pdf` becomes
  `report-pdf-<8hex>`. That derived slug, not the filename, is what `--force
  --slug` and `articles/<slug>/` want; `tiro-process validate` prints it, and
  it is the directory name in the vault. The site shows the filename rather
  than a link. **The filename is legible in a public address** — `unlisted`
  keeps it out of every index but not out of reach (ADR 0017) — so rename a
  file before importing if its name says more than the document should.
- It starts **unlisted**. Unhiding one by hand survives a re-import.
- `--force` keeps the converted body and redoes only the summary, tags and
  translation — there is nothing to re-extract, because the bytes are not in
  the vault. **Re-import the file** to rebuild the text itself; see the retry
  table below, which is the one place that rule is written down.
- A CJK filename slugs to a bare hash. Not local-specific — `slugify` drops CJK
  for every article — but a `local:` identity has no hostname to soften it. The
  title still carries the name.

Nothing binary is stored either way, and neither kind can be reprocessed from
a source that has gone: a clipped PDF whose URL now 404s, and every imported
one, keep the Markdown they have.

Conversion is checkpointed to `articles/<slug>/.tiro-pdf-cache.json`, one entry
per batch, so a PDF too long for one run resumes rather than restarting.
Batches that fell back to extracted text are recorded too — otherwise a
document whose batches are slow *and* rejected stops at the same place every
run and never finishes — which means **a bad conversion is replayed rather than
retried, and asking for a retry differs by kind:**

| | Retry a bad conversion | What invalidates the checkpoint |
| --- | --- | --- |
| **Clipped from a URL** | `--force` + slug | `--force`, or changing the model the conversion runs on (`llm.summary_model`, or `llm.model` when that is unset) |
| **Imported from disk** | **re-import the file** — `--force` keeps the converted body and cannot rebuild it | the import itself, which stamps the article afresh |

`--force` never silently replays what it was invoked to be rid of: where it
does clear the checkpoint and the file can be neither removed nor emptied, the
article is refused rather than converted. On an imported document that is
already converted it clears nothing, because nothing is going to be
reconverted.

`pdf.stage_timeout_ms` must be at least `llm.timeout_ms`, and the config is
rejected otherwise: the stage refuses to begin a request it cannot finish
inside its own cap, so a smaller cap would let no batch start at all and the
article would sit pending every run under a timeout that read as a stall rather
than a misconfiguration.

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

It also repairs emphasis (ADR 0025): `细节_真的_很重要` is two literal
underscores, because CommonMark refuses `_` between word characters and CJK
ideographs are word characters. That pass runs *after* the masking rather than
inside it, for the opposite reason — it brings its own and stricter protection.
The mask hands a transform everything the parser did not call code, math or
HTML, a link destination included, and `https://example.com/a_b_c` is exactly
the shape this rewrites; asking the parser for text nodes instead puts the
destination out of reach, so it has to see the real source. Almost always it is
`zh.md` alone that changes: the same `_` renders correctly in English.

This is the one repair that also rewrites `.tiro-zh-cache.json`. The checkpoint
holds the same Chinese text keyed by the English block it came from, and a later
`--force` run or re-clip rebuilds `zh.md` out of it, so repairing the file and
not the checkpoint would hand the defect back — long after the repair looked
like it held. The checkpoint is written in the same all-or-nothing rename as the
two markdown files; one that cannot be parsed is skipped rather than fatal, and
costs a re-translation at worst. Where `index.md` itself changed, the keys of
the blocks that changed go stale and those blocks re-translate on the next run.

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
  re-translate, change `translation.target` in `tiro.yml`, or the translating
  model — `llm.translation_model`, or `llm.model` when that is unset — either of
  which invalidates every checkpoint wholesale; or delete the article's
  `.tiro-zh-cache.json`.
- **Redo one article's title only**:
  `backfill-titles --slug <slug> --force` (below). Far cheaper than a forced
  run when the title is the only thing wrong with the article.
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

**Every run says how it went.** Its Actions page carries a summary: what it
processed, what it left for the next run, what failed and why, and which
articles came out marked. **A run turns red, and GitHub emails you, only when an
article failed hard or could not be read** — the rows below that stay pending
with a warning, plus anything `validate` would reject. It turns red in its last
step, after the commit and the deploy (ADR 0032), so a red run has still saved
and published everything it finished; nothing needs re-running to keep its
work. A budget deferral and a `summary_failed` / `translation_failed` marker
never turn it red — the first resumes by itself, and the markers are listed in
the summary and recorded in the article.

| Marker | Meaning | Fix |
| --- | --- | --- |
| `tiro.summary_failed: true` | the summary needs a human look. The run log says which of two things it is holding: `summary unusable after 3 attempts; using a first-paragraph excerpt`, or `summary unfinished after 3 attempts; keeping the longest cut reply` | reprocess with `force` + slug. For the cut kind, read the article first — the kept summary is often serviceable, and a retry may cut it again |
| `tiro.translation_failed: true` | translation misaligned/failed; no `zh.md` | reprocess with `force` + slug |
| article stays unprocessed + run warning `failed and stays pending` | hard error (e.g. provider 403, timeout, network) at either LLM stage. The run turns red | fix the cause; next run retries automatically |
| articles stay unprocessed + run warning `stopped after the provider failed 3 articles in a row` | the provider is down or refusing the key: three articles in a row failed with a 401, 403, 404, 429, 5xx or no connection, so the run stopped starting new ones rather than pay every article's retries to learn the same thing (ADR 0032). The run turns red | fix the cause — the `failed and stays pending` lines above it name the error. Everything not attempted is still pending, so the next run (at the latest the daily one) picks it all up |
| article stays unprocessed + run line `budget reached; resuming next run` | too long to finish in one run; its checkpoint is committed | nothing — the next run resumes it, at the latest the daily one. Dispatch the workflow to hurry it along |
| Import refused in the options page with `no usable text layer` or `covers only N of M` | a scanned PDF, or one that is mostly scans. The gates run in the extension so this is said while you are there | nothing to clean up — nothing was committed. OCR is out of scope |
| PDF article stays unprocessed + run line `no usable text layer` | a scanned PDF. OCR is out of scope (ADR 0026) | nothing automatic — the article stays pending forever, and the daily run downloads it again and turns red over it each day. Clip the HTML version if one exists, or delete the stub |
| PDF article stays unprocessed + run line `text layer covers only N of M page(s)` | a partly-scanned PDF — enough text overall, but concentrated on a few pages | same. If the document really is mostly figures, lower `pdf.min_page_coverage` |
| PDF article stays unprocessed + run line `not a PDF:` | the URL served HTML (a login wall, a rate-limit interstitial) or something that is not a PDF at all | check the URL in a browser; if it needs a session, the processor cannot fetch it — it carries no cookies |
| PDF article stays unprocessed + run line `too many pages` | past `pdf.max_pages`; refused rather than truncated | raise the cap in `config/tiro.yml` if the document is genuinely wanted whole |
| PDF article stays unprocessed + run line `--force cannot reconvert` | the checkpoint could be neither removed nor emptied — almost always a permissions or read-only-filesystem problem in `articles/<slug>/`. Only on a path that was going to reconvert; a converted import never reaches it | fix the permissions; the article keeps the body it had and stays pending |
| PDF article stays unprocessed + run line `pdf stage timed out` | past `pdf.stage_timeout_ms` for this document — a slow server, or more batches than fit | nothing: the checkpoint holds what it finished and the next run resumes. Repeated on a very long PDF, raise `pdf.stage_timeout_ms` |
| PDF article processed + run line `kept as extracted text` | the model's reply failed its content or table checks on some batches, or a request was refused (400) or timed out, so those kept the raw text layer. A provider that was down — 5xx, 401/403/404, 429, no connection — does not land here: the article stays pending and the run turns red (ADR 0032) | **clipped:** reprocess with `force` + slug, which discards the checkpoint and reconverts. **Imported:** re-import the file — `--force` keeps the converted body and would change nothing. Either way an ordinary run resumes those fallbacks as settled; if it repeats, the article is readable but unformatted in places |
| run fails at "Commit results back" with `could not apply` | rebase conflict with a concurrent commit (was: queued runs checking out the stale trigger SHA) | re-run the workflow; pending articles retry. Guarded by `ref: main` checkout + `git pull --rebase -X theirs` |

## Deploys

Triggered by: push to `main` in tiro, `vault-updated` dispatch from the vault,
or manually (Actions → Deploy site → Run workflow). Wrangler is pinned in
devDependencies — the action must log "using pre-installed wrangler".

- A failed deploy is always safe to **Re-run** from the Actions UI.
- **Empty-vault guard**: the build refuses to publish a site with zero
  articles. Keep at least one article in the vault. A vault whose articles are
  all *unlisted* does build, and publishes an empty library — hiding something
  has to take effect even when it is the last listed thing.
- **A vault push redeploys on its own** (ADR 0032). A push under `articles/`
  starts the vault's `process.yml`, which dispatches `vault-updated` when it
  finishes — whether or not it committed anything, so a hand edit with nothing
  to process (`unlisted`, a deletion, a repair, a slug migration) is published
  too. A manual run of the workflow deploys the same way. A push under
  `collections/` goes through `publish.yml` instead, which only dispatches
  (ADR 0029). A push touching neither — `config/tiro.yml`, say — deploys
  nothing, and needs nothing: the site does not read the config.
  - The deploy comes when the processing run *ends*, and that run queues behind
    one already in progress, so a hand edit can take as long to appear as the
    run ahead of it. Dispatch a deploy by hand (Actions → Deploy site → Run
    workflow) only to skip that wait.
  - This needs the vault's copy of `process.yml` to be current:
    `vault-template/` does not propagate. A vault still on the old file
    dispatches only after a commit, and every hand edit needs a deploy
    dispatched by hand.
- **Collections** (ADR 0029): one file per collection at
  `collections/<id>.md`, the filename being the id — lowercase ASCII words
  joined by single dashes, because it is a filename and a URL. Favorites is
  `collections/favorites.md`; its page exists even before that file does. The smallest valid one is a title and a list:

  ```yaml
  ---
  title: "重读清单"
  items:
    - slug: "example-com-posts-hello-ai-e8446b12"
  tiro:
    schema: 1
  ---
  ```

  Items render in file order, so reorder by moving lines. Push, and
  `publish.yml` redeploys; `process.yml` never runs for it, so no model call is
  spent. Run `validate` first — it catches an unusable filename, a member
  listed twice, and a member with no article behind it, which the site would
  otherwise skip in silence.
  - **An unlisted member is left off the collection's page** (ADR 0017), though
    the article's own page still shows the chip. Empty collections are listed.
  - **Description and cover are hand edits** (ADR 0030); the clipper sets
    neither. `description: "…"` shows under the title. The cover is built from
    the members' own pictures: the first local JPEG, PNG, WebP or AVIF each
    article renders (a reference quoted in a code block does not count) that
    is at least 150px on its shorter side and no more than 3:1, up to
    three members, in file order. Pin one instead with
    `cover: "articles/<slug>/assets/<file>"`, a path copied from the repo
    browser. It may be any listed article's image, a member or not.
    `validate` reports a cover whose article or file is gone, one that is not
    an image or is over the 20 MiB the site publishes, and one whose article is
    unlisted. The site shows such a cover as the derived one and
    only warns in the build log, so `validate` is where you find out. A
    re-clip can prune the asset a cover names, which is how a correct cover
    goes stale.
  - **Deleting an article now has a second step**: drop it from any collection
    that names it. `validate` lists them.
  - `publish.yml` ships in `vault-template/`, which does not propagate — copy it
    into the live vault by hand. Without it a collections push stays unpublished
    until the next deploy from anywhere else.
- Deleting an article: remove its directory from the vault. The whole article
  is in that directory — `index.md`, `zh.md`, `assets/` and the
  `.tiro-zh-cache.json` checkpoint — but since collections (ADR 0029) it is not
  the only place that names it: drop the slug from every collection that lists
  it, which `validate` names as `… is not an article in this vault`. Commit
  both together and push; the push redeploys. Left behind, a member is a
  row the site silently skips and an error on every later `validate`.
- Hiding an article (ADR 0017): add `unlisted: true` to its `index.md`
  frontmatter and push; the push redeploys. It drops out of the library,
  the pager, the tag and category pages, search, RSS and the sitemap, and stays
  reachable at `/articles/<slug>/` with a `未公开` label and a
  `noindex, nofollow` robots tag. Remove the line (or set it to `false`) to
  list it again.
  - A re-clip keeps the flag: the clipper reads it off the article it
    overwrites, tolerating frontmatter that no longer validates and fetching
    the blob when the file is too large for the Contents API to inline. If it
    cannot read the old article at all — frontmatter that will not parse, an
    `unlisted:` value that is not `true`/`false`, or a blob it cannot fetch —
    the clip fails rather than guess. The popup shows
    the reason; fix the article in the vault and clip again. (The same file
    would fail the site build, so it needs the fix regardless.)
  - **Unlisted is not private.** The site is public and the slug is computable
    from the source URL, as are the paths under `/vault-assets/<slug>/`. It
    hides an article from anyone browsing, not from anyone looking. The same
    goes for its short link, which is part of the slug it already had.
- **Short links** (ADR 0019): every article also answers at
  `/s/<id>/`, where `<id>` is the 8-hex suffix of its slug — a name `validate`
  accepts always ends in one, so the only article without a short link is one
  that lost it to a collision (below). Both that form and the slash-less one
  land on the article; only the form with the slash — the one the share button
  copies — is a single hop. `apps/site/scripts/short-redirects.ts` writes one
  `_redirects` rule per article *that has an id* during the build so Cloudflare
  serves a real 301, and the prerendered `/s/<id>/` page redirects on its own
  wherever that map is not in play. Nothing is stored: the id is recomputed from
  the directory names on every build, so there is no map to keep in step and
  nothing to migrate.
  - The generated map lives only in `dist/`. **Never commit it** — a file
    pairing every id with every slug enumerates the vault, which is what keeps
    unlisted slugs out of `robots.txt` in the first place.
  - Cloudflare Pages allows **2,000 static** redirect rules (plus 100 dynamic,
    which these are not — the combined 2,100 is not the number to budget
    against). The build warns when the total crosses 2,000. Past it the aliases
    still work through the prerendered pages, one redirect slower.
  - A build that logs `short links: … derive the id` has two articles claiming
    one id; both lose their short link and keep their long URLs. The fix is a
    longer id, not a lookup table — see ADR 0019.

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

# 5. Commit and push in the vault. The push starts process.yml, which has
#    nothing to process and dispatches the deploy when it ends (ADR 0032).
git -C ../tiro-vault add -A
git -C ../tiro-vault commit -m "migrate: recanonicalize slugs"
git -C ../tiro-vault push
```

- **Bodies and `zh.md` are never touched.** Block alignment cannot move,
  `tiro.processed_at` survives, and nothing is re-queued — the migration costs
  no LLM calls. Re-clipping the two arXiv articles instead would have meant
  re-translating ~2,100 lines with no `.tiro-zh-cache.json` to resume from.
- **Site URLs change and there are no redirects — short links included.** The
  moved articles 404 at their old paths; the feed and sitemap regenerate on
  deploy. A short link is the slug's own hash suffix (ADR 0019), and the hash is
  taken of the *normalized* URL with `canonicalizeUrl` inside it, so a
  recanonicalization moves `/s/<id>` exactly as it moves the long path. The
  alias is shorter, not more durable — do not treat one already shared as a
  stable address across a rule change.
- **Don't clip during the window**, for the same reason as a layout migration:
  a new extension against an unmigrated vault duplicates the article at the new
  slug.
- **An existing target is refused, not renamed onto** — `rename` nests the
  source inside an existing directory rather than failing. The run reports it
  and exits non-zero.
- **Collections move with their members** (ADR 0029). Every collection naming a
  moved slug is rewritten to the new one in the same write, keeping the
  member's place and date, and so is a `cover:` pointing into a moved
  article's `assets/` (ADR 0030); the report says `carries it in collections
  …`. An
  unreadable collection stops the run before anything moves — fix it first,
  or its members would be stranded.

## Extension

### Development machine

- Loaded unpacked from `apps/extension/dist`. After pulling extension
  changes: `bun run --cwd apps/extension build`, then the reload icon on
  `chrome://extensions`. Saved settings survive reloads.
- Settings: owner `hutusi`, repository `tiro-vault` (name only, no owner
  prefix), branch `main`, plus the extension PAT.
- **Eyeballing popup states without a page for each**: `bun run --cwd
  apps/extension build:dev`, serve `dist/` over HTTP (`python3 -m http.server`
  in it), then open `src/popup/popup.html?state=<name>` — `ready`, `already`,
  `clipping`, `saved`, `updated`, `failed`, `unconfigured`, `pdf`,
  `arxiv-offer`, `arxiv-fetching`, `arxiv-pdf-fetching`, `arxiv-abstract`,
  `github-offer`, `github-fetching`, `github-refused`, `github-retrying`,
  `reading`, `ready-zh`, `ready-raw`; add `&lang=zh` for the Chinese table. The list lives in
  `src/popup/fixtures.ts`. Production builds strip the branch. Rebuild with
  `build` before packaging. The collections panel has its own set at
  `popup.html?collections=<name>` — `article`, `no-favorites-yet`, `pending`,
  `created`, `saving`, `saved`, `refused`, `failed`, `site`, `not-recorded`,
  `save-unreachable`.
- **On a Tiro page the popup offers collections, not a clip** (ADR 0029). It
  recognizes the page by the site's `tiro:site` meta and `#tiro-page` island,
  on any domain, and shows a tick-list drawn from the page itself. Ticks queue
  in `chrome.storage.local` (`tiroCollectionQueue`, per vault) and are
  committed as **one** commit when the popup closes or on "Save now"; the
  service worker is the queue's only writer. "Clip this page anyway" falls
  back to the ordinary clip. A pending count shows on any page while something
  is queued.
  - A save that fails keeps the queue and says why in the next popup; the next
    close or "Save now" retries, and retrying is always safe.
  - An add for an article the vault does not have is **dropped**, with a note
    ("that article is not in your vault") — the marker proves a Tiro site, not
    *your* Tiro site, so every add is checked against the vault first.
  - After a save, the page keeps showing the old membership until the deploy
    finishes (a minute or two). The popup lays what it saved over the page
    until the page agrees, so reopening it shows the truth, not the stale site.
- **What the popup shows** (ADR 0015): a short label beside the wordmark —
  Reading…, Ready, Saved ✓ / Updated ✓, "Saved <date>" for a page clipped
  before from this machine, Failed, Cannot clip, Set up — and the full
  sentence under the card. After a clip, "Open in Tiro →" goes to the
  article's page on the site; that page exists only once the vault workflow
  has processed and deployed the clip, which the hint under the link says.
  "View in vault" is the GitHub file and works immediately.
- `Alt+Shift+C` (`Option+Shift+C` on macOS) opens the popup. If another
  extension already claimed it, Chrome leaves it unassigned — rebind at
  `chrome://extensions/shortcuts`.
- **An unpacked build does not share synced settings with the store install**,
  because `chrome.storage.sync` is keyed by extension ID and an unpacked ID
  comes from the folder path (see "Installing on another computer"). So a dev
  build always needs its own configuration, and turning sync on in one says
  nothing about the other. Adding the listing's `key` to `manifest.json` would
  pin the two together; that is deliberately not done, because a dev build
  would then be writing the settings every real machine reads.

### The publisher-fetch permissions

Two **optional** host permissions, neither held at install
(`optional_host_permissions` in `manifest.json`):

| Origin | Asked for when | Fetches |
| --- | --- | --- |
| `https://arxiv.org/*` | first clip of an arXiv paper | `arxiv.org/html/<id>`, falling back to `/abs/` |
| `https://raw.githubusercontent.com/*` | first clip of a `github.com` blob page for a `.md` file | the file's bytes (ADR 0023) |

Both are asked for from the Clip flow's own user gesture —
`chrome.permissions.request` refuses without one, which is why an already-granted
popup skips the call rather than making it on open.

- Granted: the page behaves like any other — preview on open, one click.
- Not granted: nothing is fetched. The tab is previewed as usual and a fetch
  button appears beside it, labelled for the publisher.
- Revoking one (`chrome://extensions` → Details → Site access) returns the
  extension to clipping whatever the tab shows — **except on a GitHub blob
  page**, where it does not, because the tab shows GitHub's rendering of the
  file and that would be committed under the file's own slug. There the popup
  refuses and names the raw URL to open instead, which clips with no permission
  at all (ADR 0023, clause 7).

Neither is needed to clip a `.md` served as plain text — `raw.githubusercontent.com`
itself, GitLab, Codeberg, anywhere. The tab already holds the file and
`activeTab` covers reading it; the clipper recognizes the document by shape and
carries the markdown through verbatim.

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
  policy also requires. It is at **5**: 2 added the optional arxiv.org fetch, 3
  added opt-in settings sync, which can put the PAT in `chrome.storage.sync`
  for Chrome to replicate, and 4 added the optional raw.githubusercontent.com
  fetch. Each is a new destination, and a new destination is a practice change
  whichever way the separate opt-in is answered. 5 is a different kind of
  bump: collections (ADR 0029) keep a ticked box after the popup closes and
  commit it then, which falsified the promise that closing the popup discards
  everything. No new destination, no new permission — but the number tracks
  what the text promises, so a sentence that stopped being true is a bump even
  when the manifest is unchanged. Do not "correct" it back to 4. Both language
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
  (remove the key, or reinstall) only costs the already-clipped statuses. It
  stays in `chrome.storage.local` even with settings sync on — see the cap
  below.
- **UI language follows the browser, overridable in Settings.** Chrome's
  `_locales` system cannot honor a per-extension override, so the extension
  ships its own en/zh message tables (`apps/extension/src/i18n.ts`). The
  choice lives under its own `tiroLanguage` key (same wipe-on-Save rationale
  as `tiroDisclosure`) and defaults to `auto` — the browser's UI language. It
  travels with settings sync when that is on; `tiroDisclosure` does not.
- **The PAT is stored in plaintext, in `chrome.storage.local` by default.**
  `storage.session` is cleared on every browser restart, which would mean
  re-pasting the token daily; and any key the extension could use to encrypt it
  is reachable by anything that has already compromised the profile. The real
  control is the token itself: fine-grained, one repository, Contents RW,
  revocable in seconds. That trade is disclosed on the privacy page rather than
  hidden.
- **Settings sync is opt-in and off by default** (ADR 0022). Switching it on in
  the options page moves `tiroConfig` and `tiroLanguage` into
  `chrome.storage.sync`, so a machine signed into the same Chrome profile
  configures itself — the `tiroSyncEnabled` flag lives in the synced area too,
  which is what makes the second machine zero-setup rather than one checkbox.
  `local` is mirrored three ways — writes go to both areas, a read records what
  it took from `sync`, and the service worker mirrors synced changes as Chrome
  delivers them — so switching sync back off leaves every machine holding the
  most recent settings **it has observed**, not just the machine that switched
  it. Observed, not current: Chrome syncs state rather than an event log, so a
  machine closed or offline while the settings last changed keeps the older
  copy, and one that has seen no change and never read since sync was enabled
  falls back to defaults. That clearing is the point of switching it off — it
  takes the token back off Google's servers — and whichever machine sees the
  switch go off clears anything a late write put back. ADR 0022 has the exact
  limits, including the cross-machine write race the clearing narrows rather
  than closes. Two keys never sync — `tiroClipHistory` because one key of
  up to 500 entries (~35-50 KB) exceeds sync's 8,192-byte per-item cap, and
  `tiroDisclosure` because consent to read pages belongs to an install, not an
  account.

### Installing on another computer

Two routes. **The store is the normal one**, because it auto-updates — a machine
installed that way never quietly drifts a release behind.

1. Open the [listing](https://chromewebstore.google.com/detail/tiro-clipper/nafagcbjjhifjekjahhcobhekgokgfbm)
   and **Add to Chrome**. The item is unlisted, so the link is the only way in;
   searching the store will not find it.
2. Open the extension's Settings and fill in owner, repository, branch, and a
   PAT, then hit **Test connection**. It also says when that PAT expires —
   note the date.

**Unpacked** is for a build that is not released yet — a branch under test, or a
fix wanted on one machine before a version is cut. No clone or toolchain needed:
every `ext-v*` tag publishes a zip.

1. Download `tiro-clipper-<version>.zip` from the repo's Releases page.
2. Unzip it into a **permanent** folder (e.g. `~/Applications/tiro-clipper`).
   Chrome reads an unpacked extension from that path forever — moving or
   deleting the folder breaks the install.
3. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   pick that folder.
4. Configure it as above.

**Never both on one machine.** Two installs clip the same page twice, and the
second write races the first over the same path. Remove the unpacked copy before
installing from the store.

Two things follow from how the extension stores its config (see
`apps/extension/src/storage.ts`):

- **Settings do not sync between machines unless you turn sync on.** By default
  each install is configured by hand. Ticking **Sync settings across my
  devices** in the options page puts the owner, repository, branch, token and
  language in `chrome.storage.sync`, and any machine on the same Chrome profile
  picks them up with nothing typed. The cost is stated plainly in ADR 0022: the
  token goes to Google's servers and onto every machine on the profile, and one
  shared token means one revocation breaks all of them. Untick it to copy the
  settings back down and clear them from sync.
- **With sync off, mint a separate fine-grained PAT per machine** (`tiro-vault`,
  Contents: Read and write) so a lost laptop can be revoked without breaking the
  other. This is the reason to leave sync off; turning it on trades it away
  knowingly.

An unpacked extension's ID is derived from its folder path, so it differs per
machine; a store install carries the one permanent ID everywhere. **One thing
does depend on that:** `chrome.storage.sync` is namespaced per extension ID, so
settings sync only ever joins installs that share one. Two store installs do. An
unpacked build and a store install do not — with Chrome Sync working perfectly
the unpacked one reads an empty synced area and has to be configured by hand —
and two unpacked copies should be assumed not to either, since the paths differ.
Nothing else does: no OAuth redirect, no `externally_connectable`, so otherwise
the ID matters only when reading `chrome://extensions` to tell two installs
apart.

#### When the second machine's settings stay empty

Sync is on, the first machine is configured, the second one's Settings page is
blank. Almost always this is Chrome not carrying extension data to that profile
rather than anything in Tiro. Check in this order; the first question is both
the cheapest and the most decisive.

1. **Was "Sync settings across my devices" already ticked the first time you
   opened Settings there?** `tiroSyncEnabled` lives in the synced area
   precisely so it travels, so a box that arrives *unticked* proves nothing
   synced at all — stop here and look at Chrome, not at the settings. Ask this
   first because ticking the box destroys the evidence.
2. **`chrome://settings/syncSetup` on the empty machine** — signed in, sync
   actually running, and **Extensions** among the types under "Manage what you
   sync → Customize".
3. **Sync paused.** A "Verify it's you" prompt or an unentered passphrase
   leaves sync looking on while it carries nothing.
4. **A managed profile.** `chrome://policy` → `SyncDisabled`, and
   `SyncTypesListDisabled` (an entry covering extensions removes exactly this
   datatype). A work or school profile commonly sets one, and Chrome then
   degrades `chrome.storage.sync` to a private local-only area **silently** —
   no error, nothing an extension can detect. This was the answer the one time
   it came up.
5. **The same extension ID on both** (`chrome://extensions`, Developer mode
   shows it) — see the paragraph above. An unpacked build never shares with a
   store install.
6. **0.14.0 or later on both.** Settings sync does not exist before it.

To see what sync actually holds: `chrome://extensions` → Details → Inspect
views: **service worker** → `await chrome.storage.sync.get(null)`. That prints
the token, so do it on your own screen.

**Two things not to do on the empty machine** — both make it worse, and both
are one click away:

- **Do not press Save.** With the flag set, Save publishes the form to the
  synced area, and every other machine's worker mirrors that down into its own
  local copy: the mirror that exists so no machine is left without settings is
  what spreads the emptiness, and no copy survives. 0.15.0 refuses a
  configuration that cannot clip; 0.14.0 does not.
- **Do not untick the box.** Disabling calls `chrome.storage.sync.remove` on
  the synced keys, which withdraws the shared copy for the whole profile while
  copying down only what *this* machine can see — nothing. Other machines keep
  whatever they last observed; one that has never read is left with defaults.

Instead: fix Chrome Sync on the second machine, reopen Settings, and confirm
the box is now ticked with the fields filled. If the policy is not yours to
change, leave sync on where it works, leave the box **unticked** on the managed
machine, and configure that one by hand with **its own** fine-grained PAT —
which is the per-machine-token recommendation above, now applying to one
machine rather than none.

#### Clearing an empty config out of the synced area

A different fault with the same symptom, and the giveaway is that it is only
ever the **freshly installed** machines that come up empty while every
configured one is fine. Versions before 0.15.0 let an empty Save reach the
synced area; from 0.15.0 nothing publishes one, but a machine still on the
older build can, and a value already sitting there is not cleaned up on its
own. Configured machines never notice — they keep their own copy by design —
so the profile can stay in this state indefinitely while only new machines
suffer.

Confirm it from a configured machine: `chrome://extensions` → Details →
Inspect views: **service worker** → `await chrome.storage.sync.get(null)`. An
empty or partial `tiroConfig` there, while that machine's Settings page shows
the right values, is this.

**Opening Settings on a machine whose settings are correct clears it** — from
0.15.0 that page republishes its own config over a synced one that cannot
clip, and says so when it does. That is the whole procedure; the two below
are for a machine still on an older build, or if you want to force it:

- press **Save** — the write replaces the synced copy; or
- untick **Sync settings across my devices**, then tick it again. Unticking
  keeps the better of the two copies, so nothing is lost, and re-ticking
  republishes the good one.

Then reopen Settings on the fresh machine. The repair only runs when someone
opens Settings, so a profile nobody visits stays poisoned — which is why the
symptom is worth recognising rather than waiting out. Upgrading every machine
on the profile past 0.15.0 stops it recurring.

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

### Backfilling translated titles

`title_zh` arrived after most of the vault was already processed (ADR 0016), so
those articles show their original title in the library and the reader until it
is filled in. `backfill-titles` fills it: one small LLM call per article, from
the title and the article's already-written Chinese summary — the summary is
handed over as terminology context so a backfilled title agrees with the text it
renders above, which is what the pipeline gets for free by writing both in one
call.

Not `--force` over the vault. Only 12 of the 39 translated articles still hold a
`.tiro-zh-cache.json`, so a forced run re-translates 27 whole bodies and
re-downloads every image, across hours of workflow runs, to add one line each.

```sh
# What would it spend? (no LLM calls, no writes)
bun run packages/processor/src/cli.ts backfill-titles --vault ../tiro-vault --dry-run

# One article first, then read the diff in the vault
TIRO_LLM_API_KEY=… bun run packages/processor/src/cli.ts backfill-titles \
  --vault ../tiro-vault --slug 12factor-net-93566134

# The rest (--limit <n> to go in batches)
TIRO_LLM_API_KEY=… bun run packages/processor/src/cli.ts backfill-titles --vault ../tiro-vault
```

The single-article run first is the point of the sequence: `stringifyArticle`
re-serializes the whole file, so any unrelated churn shows up in that one diff
before 38 more follow. Expect exactly one added line.

It skips Chinese originals, articles still pending (`run` does those better — it
has the body), and articles that already have a title unless `--force` is
passed. That last skip is what makes it resumable: `title_zh` is its own
progress marker, so an interrupted run is continued by running it again, and
there is no checkpoint to clean up. It stops itself at `processing.run_budget_ms`
and after three consecutive failures, naming what is left; failures exit
non-zero, because an article silently keeping no title is the one thing nothing
else would report.

It writes only `title_zh` — never `tiro.processed_at` — so nothing becomes
pending and the processor has nothing to redo. Commit and push the vault: the
push redeploys, the same way a slug migration does (ADR 0032).

One gotcha it shares with `summary`: a hand-fixed `title_zh` is not durable.
Both forced paths overwrite it, and they differ in what else they touch —
`backfill-titles --force` rewrites the title and nothing else, while a forced
*processing* run (`run --force`, or the workflow with `force: true`) re-rolls the
summary and the tags alongside it.

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

### Cutting a repo release

The `v*` tags are the repo-level milestone: what the *system* gained, across
site, processor and clipper together. They are independent of the `ext-v*` line
— see the note above the oldest `[Unreleased]` link in `CHANGELOG.md` for why
extension work is filed under the repo release that carries it rather than
getting its own heading.

Unlike an extension release, **nothing is automated**. No workflow fires on a
`v*` tag, and the deploy already happened when the commits landed on `main`.

1. Roll `CHANGELOG.md` in a `docs: cut X.Y.0` commit that touches nothing else.
   Insert `## [X.Y.0] - <date>` directly under `## [Unreleased]`, so everything
   accumulated there becomes the new section and `[Unreleased]` is left empty.
   At the foot of the file, repoint `[Unreleased]` to `compare/vX.Y.0...HEAD`
   and add `[X.Y.0]: …/compare/v<prev>...vX.Y.0`. The edit is four lines; the
   reasoning for the milestone goes in the commit body, which is the only place
   it is recorded.
2. **Cut the extension release first** if this milestone carries clipper work,
   so the repo release can link to a zip that already exists.
3. Tag `vX.Y.0` and push it. This triggers nothing.
4. Create the GitHub Release by hand, titled `Tiro X.Y.0`:

   ```sh
   gh release create vX.Y.0 --title "Tiro X.Y.0" --notes-file <body>
   ```

   The body is a short paragraph saying the extension ships separately and
   linking the matching `ext-v*` release by name and asset, then a `---`, then
   the new CHANGELOG section verbatim. **No assets** — the clipper zip belongs
   to its own release, and duplicating it would create two artifacts that can
   drift.

Verify with `gh release list`: the new `Tiro X.Y.0` should be `Latest`, with its
`Tiro Clipper` counterpart directly beneath.

### Chrome Web Store

Published **unlisted**: installable from the link, invisible in search. That
buys auto-updates, a stable extension ID, and no Developer-mode banner — worth
the $5 one-time registration for a tool installed on more than one machine.

- **Listing**: <https://chromewebstore.google.com/detail/tiro-clipper/nafagcbjjhifjekjahhcobhekgokgfbm>
- **Extension ID**: `nafagcbjjhifjekjahhcobhekgokgfbm`, permanent and assigned by
  Google. Unrelated to the ID an unpacked install gets.

Copy that link by hand rather than from the dashboard's address bar, which
appends `?authuser=N` (tied to whichever Google account was signed in) and
`&hl=…` (pins the page to one language). Neither belongs in a link you keep.

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
| A run stops early with `stopped after the provider failed 3 articles in a row` | a provider outage, an expired or revoked `TIRO_LLM_API_KEY`, a model id the key cannot use, or quota exhausted — the three errors before it say which | curl self-test against the provider; fix the key, the model or the quota. Nothing to clean up: the articles it did not attempt are still pending |
| Deploy fails in "Deploy to Cloudflare Pages" with tarball/network errors | transient infra | Re-run; wrangler is pinned so the historic install-flake is gone |
| Extension "Repository not found" | wrong owner/repo field values, or PAT lacks the repo | curl `api.github.com/repos/hutusi/tiro-vault` with the PAT: 200 → fields, 404 → token access |
| Settings sync is on but a second machine's Settings page is empty | Chrome is not carrying extension data to that profile — a managed profile's `SyncDisabled`/`SyncTypesListDisabled`, a paused sync, or a mismatched extension ID (unpacked vs store) | see "When the second machine's settings stay empty" — and on the empty machine do **not** press Save and do **not** untick the box |
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
| The popup says a collection save failed: "… cannot parse …" | a hand-edited `collections/<id>.md` no longer validates, and the extension refuses to overwrite what it cannot read | run `validate` on the vault, fix the file, then "Save now" — the queued changes were kept |
| The popup says a collection save failed: "… kept moving" | three commits landed on the branch during one save — a processing run committing back in a burst | "Save now" again once processing settles; nothing was lost |
| The extension card on `chrome://extensions` shows **Errors** right after reloading | the service worker threw while loading, so it never registered — nothing it does (collection saves, settings-sync mirroring) runs. The usual cause is a DOM API reached at module load: the worker imported `@tiro/shared`'s root, which pulls in remark | open Errors for the stack; the extension `build` should already have refused this bundle (`scripts/check-worker.ts`). Import `@tiro/shared/documents` from anything the worker reaches |
| The popup says "A change could not be recorded" | the extension's background worker did not answer a toggle, even on a retry — usually it was still starting, or the extension was just reloaded | press Save now, which re-sends the toggle before saving; if it keeps failing, reload the extension at `chrome://extensions` and tick again. Closing the popup first loses that one toggle, by design: the popup cannot write the queue itself |
| A collection change is saved but the site still shows the old list | the vault's `publish.yml` is missing or failed, so no deploy was dispatched | copy `vault-template/.github/workflows/publish.yml` into the vault, or dispatch "Deploy site" by hand |
| `zh.md` contains `TIROMATH0` | a checkpoint written before math restoration — should be impossible | delete `.tiro-zh-cache.json` and reprocess with `force` + slug |
