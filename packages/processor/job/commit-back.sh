#!/usr/bin/env bash
# Commit what a processing run wrote in the vault, and push it to main.
#
# Run from inside the vault checkout, after the processor, whatever the
# processor did: a run that stopped early must still commit what it finished
# (invariant 8). On Actions that is the "Commit results back" step, which runs
# `if: always()`; on any other host it is run.sh, which calls this after the
# processor whatever its exit (ADR 0046).
#
# The rebase-retry absorbs a clip that landed while the run was working, and
# an article removed while it was working (ADR 0036). Writes `committed=true`
# or `committed=false` to $GITHUB_OUTPUT when that is set — the deploy reads
# it — and exits non-zero when the run's work is not in the vault.
#
# Commits as `tiro-processor` — run.sh tells the processor's own pushes from
# everyone else's by that name — with TIRO_COMMIT_EMAIL as the address when
# set, and otherwise the Actions bot's, as it always has been.
#
# Tested for real by packages/processor/test/commit-back.test.ts, which runs
# the workflow's step — and so this file — against scratch repositories.

# Set here, not by the caller: a step's own `bash -eo pipefail` does not reach
# a script it runs, and without -e a fetch that fails inside the retry loop
# goes unnoticed — the rebase after it fails instead, and the run reports a
# conflict it never had.
set -eo pipefail

out="${GITHUB_OUTPUT:-/dev/null}"
git config user.name "tiro-processor"
git config user.email "${TIRO_COMMIT_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
git add -A
if git diff --cached --quiet; then
  echo "No changes to commit"
  echo "committed=false" >> "$out"
  exit 0
fi
# What "deleted while this run worked" is measured from: the commit
# this run checked out.
base="$(git rev-parse HEAD)"
git commit -q -m "process: summarize and translate new articles"
attempt=1
while :; do
  # Recorded only once it is true: the deploy step reads it.
  if git push; then
    echo "committed=true" >> "$out"
    exit 0
  fi
  if [ "$attempt" -ge 4 ]; then
    echo "::error::main refused this run's push $attempt times; its work is not in the vault"
    exit 1
  fi
  echo "push rejected (attempt $attempt), rebasing"
  attempt=$((attempt + 1))
  git fetch -q origin main
  # A deletion wins (ADR 0036). An article whose index.md main
  # deleted since `base` loses everything this run wrote under it:
  # a changed file would stop the rebase on a modify/delete conflict,
  # which -X theirs does not settle, and lose the whole run; an added
  # one would replay cleanly and bring the directory back as an
  # orphan. --no-renames, so a slug move reads as the deletion it is.
  # Assigned rather than looped over, so a failing diff ends the step.
  deleted="$(git -c core.quotePath=false diff --name-only --no-renames --diff-filter=D "$base" FETCH_HEAD -- ':(glob)articles/*/index.md')"
  while IFS= read -r index; do
    [ -n "$index" ] || continue
    dir="${index%/index.md}"
    if git diff --quiet HEAD~1 HEAD -- "$dir"; then continue; fi
    echo "::notice::$dir was deleted on main while this run worked on it; dropping this run's changes to it"
    # No-overlay: files this run added there go too, not just the
    # ones it changed.
    git restore --source=HEAD~1 --staged --worktree -- "$dir"
  done <<< "$deleted"
  if ! git diff --cached --quiet HEAD; then
    if git diff --cached --quiet HEAD~1; then
      echo "Everything this run wrote was under deleted articles; nothing left to commit"
      echo "committed=false" >> "$out"
      exit 0
    fi
    git commit -q --amend --no-edit
  fi
  # -X theirs: if a concurrent commit touched the same article (e.g.
  # a re-clip mid-run), both sides are valid content — prefer this
  # run's version rather than failing and discarding the whole run.
  # (In a rebase, "theirs" is the commit being replayed, i.e. ours.)
  if ! git rebase -q -X theirs FETCH_HEAD; then
    git rebase --abort
    echo "::error::rebasing onto main hit a conflict a deletion does not explain (a single file deleted by hand inside an article this run changed?); this run's work is not in the vault"
    exit 1
  fi
done
