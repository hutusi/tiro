# ADR 0046: The vault job runs on any host

Status: accepted (2026-10). Amends:

- ADR 0004: `api_key_env` names a variable, and now also `<name>_FILE`, a file
  holding the key;
- ADR 0032 §1: the deploy rule moves into a script, and a run started by the
  processor's own push counts as scheduled;
- ADR 0032 §2: off Actions, the daily run is the host's own timer;
- ADR 0032 §3: off Actions, the alert is the host's, not GitHub's email;
- ADR 0032 §6: a token held on another host is checked by no workflow.

Changes nothing in the document format, so `tiro.schema` is unchanged.

## Context

The vault job — process what is pending, commit it, tell the site to rebuild —
existed only as the vault's `process.yml`. The commit-back with its
deletion-wins rebase (ADR 0036), the deploy rule (ADR 0032 §1) and the red at
the end (ADR 0032 §3) were inline `run:` blocks and step conditions, so
nothing but GitHub Actions could run them.

On 2026-10-15 the vault's Actions jobs stopped starting: "The job was not
started because recent account payments have failed or your spending limit
needs to be increased." The vault is private, so its runs spend paid minutes,
and October had used about 3,400 of them against the 2,000 a free plan
includes — about 2,500 in the four days of re-clips and retitles, one run per
push. ADR 0032 §2 priced an idle run right, at a minute; the cost is the runs
with work, and almost all of their time is spent waiting for the LLM. Paying
GitHub for that is paying for waiting.

The owner has a VPS beside the LLM provider (both in Aliyun's mainland
network), and Janus, a small self-hosted CI they wrote that runs pipelines
from webhooks as plain host processes.

## Decision

### 1. The job is scripts in tiro

`packages/processor/job/`:

- `process.sh` runs the processor over a vault, its inputs as arguments;
- `commit-back.sh` is the commit step, moved verbatim, with its own
  `set -eo pipefail`;
- `deploy.sh` holds ADR 0032 §1's rule and sends the dispatch itself;
- `run.sh` is the whole job for a host without Actions.

The workflows' steps call the first three, so Actions and any other host run
the same code. `commit-back.test.ts` still runs the workflow step's real
shell, and so the script; `job-run.test.ts` runs `run.sh` against a scratch
remote with a stand-in processor and API.

### 2. Actions stays the default; one variable moves the automatic runs off it

The vault's repository variable `TIRO_PROCESSOR`, set to `external`, makes
`process.yml` and `publish.yml` skip their jobs, except when run by hand. A
job skipped by its `if:` gets no runner and spends no minutes. "Run workflow"
stays available for a forced re-run of one slug, and as the fallback when the
other host is down. Switching hosts is a setting, not a commit, and an unset
variable is the old behaviour.

### 3. `run.sh` keeps the workflow's promises without its steps

- **Its own checkout.** It keeps a persistent clone of the vault and starts
  every run from `main` as it is now — as the workflow's `ref: main` does —
  so a run that waited behind another processes what that one left.
- **A backstop.** The processor runs under `timeout` (`TIRO_PROCESS_TIMEOUT`,
  an hour), above the run budget the processor keeps itself (ADR 0008), so a
  run that overstays is stopped and the commit after it still runs. It runs
  in the job's own process group, so a host that kills the job kills it too.
- **Commit whatever happened.** The commit-back runs after the processor
  whatever its exit; the deploy follows when the commit succeeded; and the run
  turns red only after both (invariant 7, ADR 0032 §3).
- **A killed run is committed by the next.** Janus kills a step's whole
  process group on its step timeout, on a cancel and on shutdown, and no
  shell trap survives that. So a run records the commit it started from, and
  a run that finds that record commits what the killed one left before
  anything else — the job-level form of the workflow's `if: always()`. What
  it recommits is the killed run's own work, on that work's own parent: once
  the commit-back has rebased, the parent is a newer `main` than the one the
  run started from, and measuring from the start would carry `main`'s newer
  commits along as the run's, for `-X theirs` to put back over anything newer
  still. A commit already on `main` is not recommitted at all.
- **A deploy that could not be sent is owed.** The runs after it may commit
  nothing — the processor's own push, the daily run — and so would never
  publish what is already on `main`. Off Actions a run that committed records
  that a deploy is owed, and only a dispatch that went through clears it; a
  run killed after its push is treated the same way. On Actions the next run
  starts from a fresh checkout and cannot know; there a failed deploy is a red
  run, re-run by hand.
- **The processor never holds the dispatch token.** It parses pages from
  anywhere (ADR 0034); the token that can write to the site stays with the
  script.

### 4. The processor's own push is not a hand edit

On Actions, a push made with the run's `GITHUB_TOKEN` starts no workflow. On
another host the processor pushes with a real credential, so its push comes
back as a trigger. A push whose head commit is `tiro-processor`'s:

- deploys only what that run commits, as a scheduled run does — otherwise
  every processing run would deploy twice;
- is still processed. Janus keeps one waiting run per group and a newer
  trigger replaces it, so the processor's push may have displaced a clip's
  run; this run is then the only one that will see that clip;
- stops after three of the processor's own commits in a row, leaving the rest
  to the daily run, so a run whose work never settles cannot push and trigger
  itself for as long as the provider bills it.

The author name, not the message, marks the processor's commits, so the
owner's own local `process:` commits still count as pushes.

### 5. Secrets can be files

Janus passes a job almost none of its daemon's environment and has no secrets,
and a key written into a pipeline file would be committed with it. So a
secret may be a file: the processor reads `<api_key_env>_FILE` when the
variable itself is unset — in the processor, so any name works without shell
reading the vault's config — and `deploy.sh` reads `TIRO_DISPATCH_TOKEN_FILE`.

### 6. Janus is the first other host

`vault-template/.janus/` holds three pipelines in Janus's grammar:

- `process.yml`, on a push under `articles/` or `inbox/`;
- `publish.yml`, on a push under `collections/` — only the deploy, so it never
  waits behind processing;
- `daily.yml`, which a host timer starts through Janus's trigger API at the
  same 03:17 UTC, because Janus has no schedule of its own.

Each sources a host file of settings (paths, the secret files, the proxy) and
runs `run.sh` from a fresh clone of tiro. `process.yml` and `daily.yml` share
a concurrency group, so they queue as the workflow's runs do.

## Rejected

- **A self-hosted Actions runner on the VPS.** It would keep every workflow
  unchanged, but it holds a connection to GitHub open from a mainland network,
  depends on whether a billing-locked account still hands jobs to self-hosted
  runners, and GitHub has announced a fee for self-hosted minutes before. The
  owner asked for the job, not a runner.
- **Disabling the workflows in GitHub's settings.** Invisible from the repo,
  and switching back means remembering to.
- **A gate job that checks the host first.** It costs a runner per push — the
  very spend being removed.
- **`[skip ci]` on the processor's commits.** Janus does not honour it, and on
  GitHub the variable already keeps the push from starting anything.
- **Janus's own workspace as the vault checkout.** In `mirror` mode its
  `origin` is a local mirror, so a push would go nowhere; `fresh` deletes the
  directory, and with it a killed run's work; `persistent` falls back to a
  fresh clone when two runs of one repo overlap.
- **Reading the key file in the job script.** The variable's name is in the
  vault's config; shell would have to parse YAML to know it.
- **Fly.io, now.** The same scripts run in a container; deferred until a host
  outside the mainland is wanted.

## Consequences

- Two hosts at once — a manual run on Actions while the other host is live —
  pay twice for whatever both process, and lose nothing: processing is
  idempotent, and the commit-back rebases.
- Off Actions, a failing run is reported by the host: Janus's failure
  notification and commit status. GitHub's email still covers a run started
  by hand there.
- `tokens.yml` checks the dispatch token on Actions only. A copy of it on the
  other host is checked while Actions can run, and by nothing while it
  cannot; a Janus version of the check is deferred.
- The fetch guard resolves names on the host. A resolver that answers with
  reserved addresses — a proxy's fake-ip mode, some poisoned answers — refuses
  a saved link for good (`fetch_failed`) and keeps images as hotlinks, so the
  host needs clean DNS. A guard that defers to a proxy is deferred.
- A webhook GitHub failed to deliver is not delivered again; the daily run
  picks up its work.
- Work the budget deferred continues up to twice at once, through the
  processor's own pushes, rather than waiting for the next clip.
- The workflows now run tiro's scripts as checked out from `main`, as they
  already ran its processor: a broken script on `main` breaks every vault's
  processing at once.
- `vault-template/` does not propagate: the live vault takes the new
  `process.yml`, `publish.yml` and `.janus/` by hand.
