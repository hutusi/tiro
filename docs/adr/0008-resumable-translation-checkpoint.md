# ADR 0008: Resumable translation — a per-article checkpoint and a run budget

Status: accepted (2026-08). Extends ADR 0003 (block-aligned translation); the
alignment contract itself is unchanged.

## Context

Translation is the only stage whose cost scales without bound with article
length. A 170 KB paper clipped into the vault split into 14 sequential batches
and never finished. Three consecutive runs failed three different ways, and the
vault sat with two untranslated articles for days:

- Two runs died mid-batch on `TimeoutError`, each after exactly 485 s — a 120 s
  per-request timeout retried four times (`maxRetries = 3`). One stuck call
  burned eight minutes of a thirty-minute job.
- One run reached batch 12 of 14 at the 29-minute mark and was killed by the
  workflow's `timeout-minutes: 30`.

Three properties combined to make this permanent rather than merely slow:

1. **Translation kept no state.** Every attempt started at batch 1, so twelve
   finished batches were discarded on each kill. No number of retries could
   converge.
2. **The commit step had no `if: always()`.** A job killed by `timeout-minutes`
   skipped it, so even articles that *had* finished in that run were thrown
   away and re-billed next push.
3. **Articles were processed in alphabetical order.** The oversized article
   sorted first, so it ran first on every push and consumed the entire budget
   before anything else was reached. A 27 KB article clipped alongside it never
   received a single LLM call — it was not slow, it was starved.

The failure was also close to invisible: the run exits 0 by design (ADR: hard
failures must not fail the workflow before its commit step), so the only
evidence was a `processing <slug>` line with no matching completion.

## Decision

**A checkpoint file per article.** `articles/<slug>/.tiro-zh-cache.json` holds
the blocks translated so far, flushed after every batch. A run that stops early
hands its work to the next one.

- **Not a partial `zh.md`.** Invariant 4 forbids ever writing a misaligned
  translation, and a half-translated body is misaligned by definition. The
  checkpoint is separate state, and `zh.md` is still written once, whole, after
  the alignment gate passes.
- **Keyed by a hash of the block's source text, not its index.** A re-clip that
  edits one paragraph keeps every other block's translation, and reuse is safe
  by construction: a cached translation is only ever returned for byte-identical
  input. Index keys would silently misapply translations across an edit.
- **Discarded on both terminal outcomes** — success *and* misalignment. Keeping
  it after a misalignment would resume from the very blocks that broke the
  contract and reproduce the failure on every future retry, making a recoverable
  fault permanent.
- **Header-guarded.** A checkpoint written for a different model or target
  language is dropped whole rather than merged. This doubles as the operator's
  "retranslate it properly" lever: change the model in `tiro.yml` and stale work
  invalidates itself.
- **`--force` does not clear it.** Force means "reprocess this article", and the
  content-addressed key already guarantees correctness. Clearing it would make
  the one case that actually needs resuming — an article too long for one run —
  impossible to retry.

**A run budget the processor enforces itself** (`processing.run_budget_ms`,
50 min), as one absolute deadline that binds *every* stage, retry, and HTTP
request. On expiry it throws, the article is left pending with its checkpoint
intact, and the run returns normally. The workflow's `timeout-minutes` rises to
60 and becomes a backstop rather than the primary limit — the difference between
a clean stop that commits and a kill that does not.

Checking the deadline only between articles and between batches is not enough,
and the gap is much larger than it looks. Between two checks one article can
spend `images.stage_timeout_ms` (300 s) on its own independent stage deadline,
then three summary attempts of up to four HTTP requests each (24 min), then a
translation batch that calls the model twice on a marker mismatch (16 min) —
roughly 40 minutes past a deadline whose headroom is ten. So the deadline is
also handed to the chat client: no request starts without budget left, and each
request's timeout is clamped to `min(timeout_ms, remaining)`, the same idiom the
image stage already applies to its own deadline. Overrun drops to at most one
in-flight, already-clamped request. `summarize` needs no check of its own
because its `await chat(...)` sits outside its retry `try` — a budget error
propagates rather than being mistaken for a bad response and buried in the
excerpt fallback.

**A budget-deferred `--force` article returns to the pending pool.** Forced
discovery includes already-processed articles, so deferring one left its
`tiro.processed_at` in place: the next ordinary run skipped it, while the log
promised it would resume, and a repeated `--force` without `--slug` re-selected
the same cheapest articles so a whole-vault redo could never reach the expensive
ones. Clearing the marker on deferral makes `--force` mean "these need
reprocessing" and hands the remainder to the ordinary pending flow — invariant 3
rather than a second, parallel notion of progress. Summary, tags, lang and
`zh.md` all stay, so the article renders unchanged until a later run redoes it,
and `validate` is unaffected (it exempts marker-less articles and checks a
present `zh.md` on its own terms).

**Cheapest article first** (`discoverArticles` sorts by body length, slug
breaking ties). This cannot stop a pathological article from failing, but it
confines the damage to that article instead of everything queued behind it.

**Supporting changes.** `Commit results back` gains `if: always()` so a killed
job still commits; the deploy step gates on a commit actually landing rather
than on job success. A timed-out request is retried once rather than three
times — a timeout has already spent its full budget before it is observed.

## Consequences

- Long articles converge across runs. Simulated against the real 170 KB paper
  with a deliberately tight budget, it completes over four runs, advancing every
  time; the 27 KB article processes first, in run one.
- Under the shipped 50-minute budget both articles finish in a single run.
- An unfinished article's checkpoint is committed to the vault, so partial state
  is visible in `git log`. It is inert to every reader: the site's loaders and
  `tiro-process validate` glob `index.md` and `zh.md`, and asset reconciliation
  only looks inside `assets/`.
- The summary call is not checkpointed, so it repeats on each run of an
  unfinished article — one cheap call against many expensive ones, not worth the
  extra state.
- `tiro.schema` stays at 1: the article *document* format is unchanged. Per
  ADR 0007 this is layout, not contract.
- A run can now end with work deliberately deferred. `PipelineReport.skipped`
  and a `budget reached; resuming next run:` line report it as the designed
  outcome it is, distinct from `errored`.
