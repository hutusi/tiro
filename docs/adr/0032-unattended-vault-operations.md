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
- **An outage could be written down as a verdict.** The PDF restructuring
  pass (ADR 0026) falls back to the extracted text when a batch's request
  fails, and checkpoints that fallback as settled, so a document too slow or
  too odd for the model does not redo the same batches every run. It could not
  tell such a batch from one the provider never answered because it was down,
  so an outage during a PDF cost that article its structure permanently.
- **A dead provider cost the whole budget.** Each pending article went through
  its retries and timeouts against a provider that was not there, one after
  another, until the run budget ran out. `backfill-titles` already stopped
  after three failures in a row; `run`, which spends far more per article, did
  not.
- **Tokens expired without warning.** Two fine-grained PATs are held by
  workflows and one more by each browser, all with at most a year to live. The
  runbook said to set a calendar reminder, and an expired dispatch token fails
  as a deploy that never happens.
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

### 4. An outage is told apart from a refusal

The chat client exports `isProviderFailure`: true for a rejected key (401), an
account or model the key cannot use (403, 404), a rate limit that outlasted the
retries (429), a server fault (5xx), and a request that never connected — which
the client now names `ChatConnectionError`, since `fetch` reports it as a bare
`TypeError`, the same thing a code slip throws.

Two things are deliberately *not* outages. A **400** is a verdict on this
request — DashScope's content moderation answers one — and the next article
will not share it. A **timeout** is as often this request's size as the
provider's state, and the fallbacks that exist for one (per-block translation,
a PDF batch kept as extracted text) are there because a batch too big to
answer in time would otherwise time out on every run forever.

The PDF restructuring pass rethrows an outage instead of falling back, so
nothing is checkpointed for that batch and the article stays pending; the
batches it did restore are kept for the next run.

### 5. Three outages in a row stop the run

`run` counts articles that failed with an outage, and stops starting new ones
at three in a row. Only an article that goes through resets the count; one
that fails for its own reasons neither counts nor resets it, because it says
nothing about the provider. The articles not attempted are booked as `halted`
— apart from `skipped`, which means the budget — and returned to pending the
same way a budget deferral is, so a forced one does not keep its old marker.
The run is red already, from the three outages; the halted articles are
pending work, not failures, and do not add to the count.

Three, as in `backfill-titles`, which now shares the counter (`createBreaker`):
one outage is noise, two can be coincidence, and each costs an article its
full retries.

### 6. Tokens say when they are about to expire

GitHub sends a `GitHub-Authentication-Token-Expiration` header on every API
response to a token that has an expiry. A weekly `tokens.yml` in each repo asks
for `/rate_limit` (free, and answered for any valid token) with the token the
repo's workflows hold, and fails once fewer than 30 days remain — about four
red runs, and four emails, before it stops working — or at once if the token is
refused. The check is one composite action in tiro, which the vault's workflow
calls by reference, so it is written once.

The extension's token lives only in a browser, so the extension reports it:
Test connection reads the same header and says when the token expires, warning
under the same 30 days. Nothing prompts that check, which is the gap left —
a background check would break the store listing's promise that nothing is
read in the background.

The header's meaning is taken on trust, and one public report says it can carry
the server's time instead of the expiry. So the date is always printed, and the
runbook asks for one comparison against GitHub's own token page after setup.

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
- A scheduled workflow in a public repository is disabled after 60 days
  without activity. tiro is public; if it ever goes that quiet, the token check
  stops with it.
- `vault-template/` does not propagate. A vault still on the old `process.yml`
  keeps the old behaviour until the file is copied in.
