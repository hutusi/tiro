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

> **Partly superseded by [ADR 0010](0010-durable-translation-checkpoint.md)
> (2026-09-02).** One decision below no longer holds: the checkpoint is *not*
> discarded on success. Everything else stands — including "`--force` does not
> clear it", which 0010 briefly reversed and then restored, for the reason
> given here.

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
- **Discarded on both terminal outcomes** — success *and* misalignment — but
  only once `index.md` has been written with its marker, not when translation
  returns. Between those two points sit the `zh.md` and `index.md` writes; a
  kill there would lose every translated block *and* leave the article pending,
  which is the loss the checkpoint exists to prevent. Discarding on misalignment
  matters for the opposite reason: resuming from the very blocks that broke the
  contract would reproduce the failure on every future retry and make a
  recoverable fault permanent.
- **A checkpoint failure may cost only resumability — so it may be swallowed
  only while resumability is not being relied on.** Reading, writing, and
  removing are non-fatal, because an article that fits in one run never reads
  its checkpoint back and must not be failed over a file it does not need. But
  the budget stop is exactly where the run *does* rely on it: deferring an
  article whose checkpoint could not be written promises a resumption that
  cannot happen, and the next run repeats the identical batches while the log
  reports orderly progress. So a deferral consults the recorded write error
  first and surfaces a hard failure instead of a resumable stop — decided in one
  place, because the budget can end the work two ways (the check before a call,
  and the deadline expiring inside one, which the chat client raises) and a
  guard on only the first left the second reporting a resumable skip with
  nothing saved. (An earlier
  revision made writes flatly non-fatal on the grounds that a checkpoint "costs
  resumability and nothing else" — self-refuting, since resumability is the
  whole point for the only articles that need one.) Removal in particular runs
  *after* the article is recorded as processed, never between the `index.md`
  write and the record — a throw in that gap reaches the pipeline's per-article handler, which
  reports a finished article as pending (it keeps `processed_at`, so it never
  retries) and reconciles assets against the pre-download body, deleting every
  image the just-committed `index.md` points at.
- **Written atomically**, to a sibling `.tmp` that is then renamed over the
  target. `timeout-minutes` kills the job outright, and a kill partway through
  overwriting the live file leaves truncated JSON that the next run reads as
  absent — restarting from batch 1 in precisely the situation the checkpoint was
  added for. `rename(2)` within a directory is atomic, so a reader sees the old
  checkpoint or the new one and never half of either. Staging debris is cleared
  on load and on discard, since the workflow's `git add -A` would commit it.
- **Validated whole, or not used at all.** A checkpoint is restored only if it
  parses, matches the header, *and* every entry is a string. `{"<hash>": 42}` is
  valid JSON that clears a structural check, but a non-string reaches the join
  in `translateBlocks` as `translated[i].trim()` and throws — escaping
  `processOne`, leaving the article pending, and throwing again from the same
  file on every later run. Anything less than wholly trustworthy has to read as
  absent, never as a fault, or the optimisation becomes a permanent failure.
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
in-flight, already-clamped request.

Budget exhaustion is then classified by the deadline, never by the shape of the
last error. A request clamped to the last of the budget dies as a `TimeoutError`,
and letting that reach the pipeline had an orderly stop read as a fault — which
for a `--force` article meant its marker survived and the next ordinary run
skipped it, reopening the bug above through a different door. So the client
converts any error into `DeadlineExceededError` once the budget is gone, naming
the original in the message and keeping it as `cause` so a deferral caused by a
403 still says 403. Retry backoff is clamped to the remaining budget too:
sleeping three seconds to then discover there were a hundred milliseconds left
overshoots by the sleep itself. `summarize` needs no check of its own
because its `await chat(...)` sits outside its retry `try` — a budget error
propagates rather than being mistaken for a bad response and buried in the
excerpt fallback.

**A deferral is only booked as one if it will actually hold.** Clearing a forced
article's marker is a write, and it happens inside the per-article error handler,
so it gets the same two rules as the checkpoint: a failure is reported rather
than promised (the article will not resume without it, so it belongs in
`errored`, not among the orderly skips), and it never escapes the handler — an
unguarded throw there abandoned every remaining article, against invariant 7.

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
