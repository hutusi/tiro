#!/usr/bin/env bash
# The whole vault job, for a host without GitHub Actions (ADR 0046): bring the
# vault up to main, process it, commit, deploy, report — and commit whatever
# the processor did.
#
# On Actions those are steps, and `if: always()` with `timeout-minutes` keeps
# the commit running after a processor that failed or ran long. Here one
# script has to keep the same promise (invariant 8):
#   - the processor runs under a backstop (`timeout`), so a run that overstays
#     its budget is stopped, and the commit after it still runs;
#   - a host may kill the whole job anyway — Janus SIGKILLs a step's process
#     group on its step timeout, a cancel or a shutdown, and nothing in here
#     survives that — so a run marks where it started, and the next run
#     commits what a killed one left before it does anything else;
#   - a deploy that could not be sent stays owed, and goes with the next run,
#     which may have nothing of its own to publish.
#
# Inputs, as environment:
#   TIRO_VAULT_DIR      where this host keeps its checkout of the vault
#                       (cloned on first use; this script owns it)
#   TIRO_VAULT_REMOTE   the vault's git URL, with push access
#   TIRO_JOB_ENV        optional: a file of host settings — anything here,
#                       proxies too — sourced first
#   TIRO_TRIGGER        push, manual, schedule or publish (default manual)
#   TIRO_TRIGGER_SHA    the pushed commit, for a push
#   TIRO_FORCE, TIRO_SLUG            as process.sh takes them
#   TIRO_LLM_API_KEY or its _FILE    as the processor reads it
#   TIRO_DISPATCH_TOKEN or its _FILE as deploy.sh reads it
#   TIRO_PROCESS_TIMEOUT  seconds the processor may run (default 3600, set
#                       empty for none); keep it above processing.run_budget_ms
#   TIRO_COMMIT_EMAIL   as commit-back.sh takes it
#
# Exits 0 for a clean run; 1 when something needs a look — always after the
# commit and the deploy, never instead of them (invariant 7); 2 when it is
# misconfigured and did nothing.

# No -e: a failing stage is recorded, and the stages after it still run.
set -uo pipefail
export GIT_TERMINAL_PROMPT=0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tiro="$(cd "$here/../../.." && pwd)"

if [ -n "${TIRO_JOB_ENV:-}" ]; then
  if [ ! -r "$TIRO_JOB_ENV" ]; then
    echo "::error::Cannot read TIRO_JOB_ENV ($TIRO_JOB_ENV)"
    exit 2
  fi
  set -a
  # shellcheck source=/dev/null
  . "$TIRO_JOB_ENV"
  set +a
fi

trigger="${TIRO_TRIGGER:-manual}"
case "$trigger" in
  push | manual | schedule) ;;
  # A collections edit has nothing to process (ADR 0029): only the deploy.
  publish) exec bash "$here/deploy.sh" ;;
  *)
    echo "::error::run.sh does not know the trigger '$trigger'"
    exit 2
    ;;
esac

vault="${TIRO_VAULT_DIR:-}"
remote="${TIRO_VAULT_REMOTE:-}"
if [ -z "$vault" ] || [ -z "$remote" ]; then
  echo "::error::Set TIRO_VAULT_DIR and TIRO_VAULT_REMOTE (in TIRO_JOB_ENV, say)"
  exit 2
fi
vault="${vault%/}"

problems=""
problem() {
  echo "::error::$1"
  problems="$problems$1"$'\n'
}

scratch="$(mktemp -d "${TMPDIR:-/tmp}/tiro-run.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

# Report what went wrong, once more and together, and end the run.
finish() {
  if [ -n "$problems" ]; then
    echo
    echo "This run needs a look:"
    printf '%s' "$problems" | sed 's/^/  - /'
    exit 1
  fi
  exit 0
}

mkdir -p "$(dirname "$vault")"
# One run at a time on this checkout. Janus already queues runs that share a
# concurrency group; this holds for a run started by hand too.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$vault.lock"
  if ! flock -n 9; then
    echo "Another run holds $vault.lock; waiting for it"
    flock 9
  fi
else
  echo "::warning::No flock here: nothing stops two runs sharing $vault"
fi

if [ ! -d "$vault/.git" ]; then
  echo "Cloning the vault into $vault"
  if ! git clone -q "$remote" "$vault"; then
    problem "Could not clone the vault from $remote"
    finish
  fi
fi
git -C "$vault" remote set-url origin "$remote"

# A deploy a run could not send stays owed until one is sent: the runs after
# it may have nothing of their own to publish, and would never send it.
owed="$vault/.git/tiro-deploy-owed"

# A run killed before it finished left its work here, and the commit it
# started from in the marker. Commit that first, as its own run would have.
marker="$vault/.git/tiro-run-base"
if [ -f "$marker" ]; then
  base="$(cat "$marker")"
  echo "::warning::The last run here did not finish; committing what it left before this one starts"
  git -C "$vault" rebase --abort >/dev/null 2>&1
  head="$(git -C "$vault" rev-parse HEAD)"
  if ! git -C "$vault" fetch -q origin main; then
    problem "Could not fetch the vault's main from $remote"
    finish
  fi
  if git -C "$vault" merge-base --is-ancestor "$head" origin/main; then
    # Nothing of the run's is committed anywhere but main, so whatever the
    # tree holds is its work, measured from HEAD: killed before it committed
    # (HEAD is still the marker), or after its push, or in a recovery like
    # this one, after taking the run's commit apart (HEAD is a commit main
    # has, and the marker may be older). Committing it is right in every case
    # — the commit-back commits nothing from a clean tree.
    unpicked=true
    if [ "$head" != "$base" ]; then
      # It got as far as main, so nothing knows whether its deploy went.
      echo "Its commit is on main already"
      touch "$owed"
    fi
  elif [ "$(git -C "$vault" log -1 --format=%an HEAD)" = tiro-processor ] &&
    git -C "$vault" reset -q --soft HEAD^; then
    # Killed between its commit and its push. Undo the commit onto its own
    # parent — which a rebase may have moved past the marker — so committing
    # again carries the run's changes and nothing of main's: measured from the
    # marker instead, main's newer commits would ride along as the run's own,
    # and -X theirs would put them back over anything newer still.
    unpicked=true
  else
    unpicked=false
    problem "The last, unfinished run left a commit that is not its own; what it left is discarded"
  fi
  if [ "$unpicked" = true ]; then
    if (cd "$vault" && GITHUB_OUTPUT="$scratch/recovered" bash "$here/commit-back.sh"); then
      if grep -qx 'committed=true' "$scratch/recovered" 2>/dev/null; then
        touch "$owed"
      fi
    else
      problem "Could not commit what the last, unfinished run left; it is discarded"
    fi
  fi
  rm -f "$marker"
fi

# Start from main as it is now, not from the commit that triggered the run:
# a run that waited behind another would otherwise process the vault as it
# was before that run committed (the workflow checks out `ref: main` too).
if ! git -C "$vault" fetch -q origin main; then
  problem "Could not fetch the vault's main from $remote"
  finish
fi
if [ -n "$(git -C "$vault" status --porcelain)" ]; then
  echo "::warning::$vault has changes no run recorded; discarding them"
fi
if ! git -C "$vault" checkout -q -f -B main origin/main ||
  ! git -C "$vault" clean -q -ffdx; then
  problem "Could not bring $vault to main"
  finish
fi
git -C "$vault" rev-parse HEAD >"$marker"

# A push of the processor's own commit is not a hand edit: it deploys only
# what this run commits. It still processes — the push may have taken the
# place of a clip's run waiting behind the one that made it, and this run is
# then the only one that will see that clip.
effective="$trigger"
skip=false
if [ "$trigger" = push ] && [ -n "${TIRO_TRIGGER_SHA:-}" ]; then
  author="$(git -C "$vault" log -1 --format=%an "$TIRO_TRIGGER_SHA" 2>/dev/null)"
  if [ "$author" = tiro-processor ]; then
    effective=schedule
    echo "This push is the processor's own commit: processing what is still pending, and deploying only what this run commits"
    # A run whose work never settles would otherwise push, trigger itself and
    # push again, for as long as the provider bills it. Three of its own
    # commits in a row is enough; the daily run picks up the rest.
    own="$(git -C "$vault" log -3 --format=%an | grep -cx tiro-processor)"
    if [ "$own" -ge 3 ]; then
      skip=true
      echo "The last three commits on main are all the processor's: leaving the rest to the daily run"
    fi
  fi
fi

ran=false
if [ "$skip" = false ]; then
  want="$(sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' "$tiro/package.json")"
  have="$(bun --version 2>/dev/null)"
  if [ -z "$have" ]; then
    problem "No bun on PATH, so nothing was processed"
  elif [ -n "$want" ] && [ "$have" != "$want" ]; then
    problem "bun is $have here, but tiro pins $want (packageManager in package.json), so nothing was processed"
  elif ! (cd "$tiro" && bun install --frozen-lockfile); then
    problem "bun install --frozen-lockfile failed in $tiro, so nothing was processed"
  else
    ran=true
    limit="${TIRO_PROCESS_TIMEOUT-3600}"
    stop=""
    if [ -n "$limit" ]; then
      if command -v timeout >/dev/null 2>&1; then
        stop=timeout
      elif command -v gtimeout >/dev/null 2>&1; then
        stop=gtimeout
      else
        echo "::warning::No timeout here: the processor runs without a backstop"
      fi
    fi
    echo "Processing $vault ($effective)"
    # The processor parses pages from anywhere, so it never holds the token
    # that can write to the site. --foreground keeps it in this process group,
    # where a host that kills the job kills it too.
    (
      unset TIRO_DISPATCH_TOKEN TIRO_DISPATCH_TOKEN_FILE
      export GITHUB_OUTPUT="$scratch/output" GITHUB_STEP_SUMMARY="$scratch/summary"
      if [ -n "$stop" ]; then
        exec "$stop" --foreground -k 30 "$limit" bash "$here/process.sh" "$vault"
      fi
      exec bash "$here/process.sh" "$vault"
    )
    status=$?
    if [ "$status" -eq 124 ] && [ -n "$stop" ]; then
      problem "The processor ran past ${limit}s and was stopped; what it finished is committed"
    elif [ "$status" -ne 0 ]; then
      problem "The processor exited $status"
    fi
  fi
fi

# Whatever the processor did. The marker goes once the commit-back has
# settled either way: a refused commit is reported, and its leftovers are
# discarded by the next run rather than retried forever.
committing=false
if (cd "$vault" && GITHUB_OUTPUT="$scratch/commit" bash "$here/commit-back.sh"); then
  committing=true
  if grep -qx 'committed=true' "$scratch/commit" 2>/dev/null; then
    touch "$owed"
  fi
else
  problem "The commit-back failed, so this run's work is not in the vault (see above)"
fi
rm -f "$marker"

# What reached main and has not been published yet — this run's commit, a
# killed run's, or a deploy an earlier run could not send, hand edit or not —
# counts as committed, so the deploy goes even on a trigger that only
# publishes its own commits.
if [ "$committing" = true ]; then
  committed=false
  if [ -f "$owed" ]; then
    committed=true
    if ! grep -qx 'committed=true' "$scratch/commit" 2>/dev/null; then
      echo "A deploy an earlier run could not send is still owed; sending it now"
    fi
  fi
  # Owed until the dispatch is known to have gone — whatever this run is
  # deploying, and even if it is killed while sending it. A run with nothing
  # to deploy clears it again at once.
  touch "$owed"
  if TIRO_TRIGGER="$effective" TIRO_COMMITTED="$committed" bash "$here/deploy.sh"; then
    rm -f "$owed"
  else
    problem "The site was not told to rebuild; the next run will try again"
  fi
fi

if [ -s "$scratch/summary" ]; then
  echo
  cat "$scratch/summary"
fi
if [ "$ran" = true ]; then
  failures="$(sed -n 's/^failures=//p' "$scratch/output" 2>/dev/null | tail -n 1)"
  if [ -z "$failures" ]; then
    problem "The processor reported no failure count, so this run's outcome is unknown"
  elif [ "$failures" != 0 ]; then
    problem "$failures article(s) failed or could not be read; the summary above names them"
  fi
fi
finish
