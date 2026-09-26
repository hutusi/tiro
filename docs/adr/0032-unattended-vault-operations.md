# ADR 0032: Unattended vault operations

Status: accepted (2026-09). Supersedes, in part, the consequences of ADR 0017
and ADR 0029 that a hand edit to the vault needs a deploy dispatched by hand.

## Context

The vault's `process.yml` was built for one job: process what the clipper
commits, commit the result, and tell the site to deploy. Everything around that
job was left to the owner, and the runbook had grown a list of chores that were
all the same chore — remembering to do the step the workflow did not:

- **A hand edit did not publish.** The deploy dispatch was gated on the
  processing run committing something. Hiding an article (`unlisted: true`),
  deleting one, running `repair`, `backfill-titles` or a slug migration are all
  pushes with nothing to process, so each ended with "then dispatch a deploy"
  — the most frequent manual step in the runbook, and one whose omission is
  silent: the site keeps serving the old build and says nothing.
- **Deferred work waited for the next clip.** The processor stops at its run
  budget and leaves the rest pending (ADR 0008), and pending work was only ever
  picked up by the next push or a manual dispatch. An over-long article clipped
  last thing at night sat half-translated until something else was clipped.
- **A failure was silent.** `run` exits 0 whatever happens to an article, on
  purpose: a non-zero exit fails the workflow before its commit step and
  throws away every article that did finish (invariant 7). So the job was
  green whether ten articles processed or ten failed, and the only record was a
  warning line in a log nobody opens. A provider that started refusing the key
  would have gone unnoticed until someone wondered why nothing new was
  translated.

## Decision

### 1. Every push and every manual run deploys

The deploy dispatch fires when the commit step succeeds and *either* the run
committed something *or* it was started by a push or by hand. Any other trigger
still waits for a commit of its own.

A push that reaches `process.yml` is under `articles/**`, so its content is
already on `main` by the time the run starts; if the processor finds nothing to
do, publishing is all that is left. A manual run is someone asking to see the
vault as it is now.

The dispatch still comes at the *end* of the run rather than on the push, so a
deploy never races the processing it would otherwise publish half of.

### 2. The processor also runs daily

`process.yml` gains a daily schedule (03:17 UTC, off the hour, when GitHub's
scheduled runs queue longest). It runs the ordinary selection — whatever lacks
`tiro.processed_at` — so it is the same run a push would start, just without
the push.

There is deliberately no cheaper "is anything pending?" check in front of it.
A run with nothing to do costs about a minute, roughly 30 of the 2,000 free
minutes a private repository gets each month. A shell check that decided
pending without the processor would be a second definition of the one rule the
pipeline must never disagree with itself on (invariant 3).

A scheduled run deploys only when it committed something: with nothing new
there is nothing to publish.

### 3. A run reports its failures after it has committed

The processor still exits 0. It writes a Markdown summary of the run to
`$GITHUB_STEP_SUMMARY` and `failures=<n>` to `$GITHUB_OUTPUT`, and the
workflow's **last** step — after the commit and after the deploy dispatch —
exits 1 when that count is not zero. GitHub's own failed-run email is the
notification, so there is no webhook, token or address to configure.

Invariant 7 forbids failing the workflow *before* its commit step; placing the
red at the very end keeps to it while making failure visible. Nothing is lost
by a red run: its work is already on `main` and published.

What counts is what will not fix itself by waiting: a hard failure, and an
article whose frontmatter no longer parses. A budget deferral is the budget
doing its job and resumes on the next run. `summary_failed` and
`translation_failed` are settled — recorded in the article, never retried —
so they are listed in the summary but do not turn the run red; otherwise one
bad summary would send an email a day with nothing new to say.

## Consequences

- The runbook loses every "then dispatch a deploy". Deleting an article, hiding
  one, a slug migration and a backfill are each a push and nothing else.
- A hand edit waits for the processing run it starts, and that run queues
  behind any run already in progress, so it can take as long to appear as the
  run ahead of it. Dispatching a deploy by hand still works and skips the wait.
- One push touching both `articles/` and `collections/` deploys twice, once
  from each workflow. The deploy workflow's concurrency group cancels the
  older, so it costs a build, not a wrong site.
- An article that can never be processed — a scanned PDF (ADR 0026) — is
  retried every day rather than on the next push, re-downloading its PDF each
  time, and each of those runs is red. Deleting the stub is still the way to
  stop it.
- A transient provider error — one 503 that clears by the next run — turns
  that one run red. The summary says the article stays pending, which is the
  cue that nothing needs doing.
- `vault-template/` does not propagate. A vault still on the old `process.yml`
  keeps the old behaviour until the file is copied in.
