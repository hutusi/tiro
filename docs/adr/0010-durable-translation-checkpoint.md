# ADR 0010: The translation checkpoint outlives the article that finished it

Status: accepted (2026-09)

Supersedes one decision in [ADR 0008](0008-resumable-translation-checkpoint.md):
"discarded on both terminal outcomes". Everything else in 0008 stands,
including "`--force` does not clear it" — see *Rejected* below.

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
- **`--force` still does not clear it**, exactly as 0008 decided.

## Rejected: making `--force` clear the checkpoint

The first version of this ADR reversed 0008 here, on the reasoning that a
surviving checkpoint reduces a forced redo to re-billing the summary. That was
wrong twice over.

It was wrong on the merits: 0008's argument is that the content-addressed key
already guarantees a cached translation is only ever returned for byte-identical
input, so reuse is *correct*, and paying again for identical output is waste
rather than diligence. The operator's levers for genuinely fresh translations
are unchanged and sufficient — change the model or target in `tiro.yml` and the
header guard drops the file wholesale, or delete the file.

It was also wrong structurally, and expensively so. Correctness came to depend
on a *deletion*, and this pipeline abandons an article in several places: the
budget check before it starts, a mid-article deferral, a bulk deferral, a
`--dry-run`, and a hard failure. Five review rounds found five instances of the
same defect — the guard added where the work happens and not where the work is
abandoned — including a `--force --dry-run` that deleted checkpoints, which is
the one flag whose contract is that the vault is untouched.

The lesson is worth more than the feature was: `--force` invalidated an
assumption the pipeline was built on — *a discovered article has no marker* —
which had been true by construction and so was never checked anywhere. Removing
the invalidation removes all five failure modes rather than fixing them.

## Consequences

- A re-clip pays only for blocks whose source text changed. The regression test
  edits one paragraph of a 40-paragraph article and the re-clip costs under
  three translation calls.
- Every translated article's checkpoint is committed to the vault: ~830 KB
  across the corpus against a ~99 MB vault, about 1%. Still inert to every
  reader — the site's loaders and `validate` glob `index.md`/`zh.md`, and asset
  reconciliation only looks inside `assets/`.
- A forced whole-vault redo re-requests summaries but reuses translations, so
  it is far cheaper than "re-bills every article" once suggested. The runbook
  says so.
- The operator's other invalidation levers are unchanged: change the model or
  target in `tiro.yml` and the header guard drops the file wholesale.
