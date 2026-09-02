# ADR 0010: The translation checkpoint outlives the article that finished it

Status: accepted (2026-09)

Supersedes two decisions in [ADR 0008](0008-resumable-translation-checkpoint.md):
"discarded on both terminal outcomes" and "`--force` does not clear it".
Everything else in 0008 stands.

## Context

ADR 0008 introduced a per-article checkpoint keyed by a hash of each block's
source text, and justified that key with a benefit it named explicitly:

> Keyed by a hash of the block's source text, not its index. **A re-clip that
> edits one paragraph keeps every other block's translation**, and reuse is safe
> by construction.

The code never delivered that. `discardCheckpointQuietly` ran on every
successful article, so the checkpoint was deleted by the very run that marked
the article processed — always gone before any re-clip could reach it. The
content-addressed key was doing work that nothing could collect.

The cost showed up while measuring what a re-clip actually takes. A clip
rewrites `index.md` from clip-time data only, erasing `processed_at`, `summary`,
`tags` and `lang`, so every stage reruns: images re-download, the summary is
re-requested, and translation restarts at block one. The 164 KB arXiv paper
spent **~59 minutes across two workflow runs** re-translating blocks it had
already paid for, against a metered key.

That price is why `tiro-process repair` exists. Re-clipping was expensive enough
that we built a way to avoid it — and then avoided it, accumulating markdown
repairs for defects a re-clip would have fixed at the source.

## Decision

**A finished article keeps its checkpoint**, pruned to the blocks it still
contains.

- **Pruned, not accumulated.** `retain()` drops every entry the article no
  longer holds, so the file tracks the current article rather than every version
  of every paragraph it has ever had.
- **Misalignment still discards.** Unchanged from 0008 and for its original
  reason: resuming from the blocks that broke the alignment contract reproduces
  the failure on every retry and makes a recoverable fault permanent.
- **An article needing no translation still discards.** There is nothing to keep.
- **`--force` clears it for articles that already finished** — the reversal.
  Force means "redo this", and a surviving checkpoint would quietly reduce that
  to re-billing the summary. 0008 argued the opposite because at the time a
  checkpoint could only belong to an *unfinished* article, where clearing it
  would defeat the one case that needs resuming. Both cases now exist, so the
  rule distinguishes them.
- **The forced clear runs once, before the loop.** Not inside `processOne`: the
  budget check defers every remaining article without starting it, so a discard
  in there never runs for those, and the forced redo evaporates on the next
  ordinary run. Doing it before any of this run's own work also keeps it clear
  of a checkpoint written *by* this run, so deferring mid-translation still
  saves partial progress.

## Consequences

- A re-clip pays only for blocks whose source text changed. The regression test
  edits one paragraph of a 40-paragraph article and the re-clip costs under
  three translation calls.
- Every translated article's checkpoint is committed to the vault: ~830 KB
  across the corpus against a ~99 MB vault, about 1%. Still inert to every
  reader — the site's loaders and `validate` glob `index.md`/`zh.md`, and asset
  reconciliation only looks inside `assets/`.
- A forced whole-vault redo now discards every finished article's checkpoint up
  front, including articles that later defer unstarted. That is what "re-bills
  every article" already promised.
- The operator's other invalidation levers are unchanged: change the model or
  target in `tiro.yml` and the header guard drops the file wholesale.
