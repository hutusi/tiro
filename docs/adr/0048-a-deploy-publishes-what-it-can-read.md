# ADR 0048: A deploy publishes what it can read

Status: accepted (2026-10). Extends ADR 0020's fault isolation from assets to
vault entries, for production deploys only. Changes nothing in the document
format, so `tiro.schema` is unchanged.

## Context

ADR 0020 made one bad asset cost its own image rather than every deploy. The
same failure remained one level up. `readVault` threw on an article whose
frontmatter failed the shared contract, and `readCollections` on a collection
file it could not parse or whose name could not be a route. Either fails the
build, and since `deploy.yml` builds before it uploads, every deploy after it
fails too. The previous deployment stays live, and nothing announces it but
GitHub's failed-run email: exactly the state ADR 0020 describes for the
tracking pixel.

What makes this worse than a stale site is what stops shipping with it. A
deletion (ADR 0036), an unlisting (ADR 0017) or a
collection edit made after the bad file lands is held back with everything
else. The site's own rule, in `articles.ts`, is that a feature whose job is to
stop publishing something must not answer "I could not do that" by
continuing to publish it. A bad article B blocking the unlisting of article A
breaks that rule.

The triggers are ordinary hand edits: `unlisted: yes` (a string in YAML 1.2,
not a boolean), a date-only `clipped_at`, a numeric tag, a `tiro.schema` bump
that reaches the vault before the site, a collection file named in capitals.

## Decision

A production deploy leaves an unreadable entry off the site, publishes the
rest, and then fails loudly, naming it.

- **The switch is `TIRO_SKIP_REPORT`.** `deploy.yml` sets it to a file in the
  runner's temp directory. With it set, `refuse` in `vault-read.ts` appends
  `path: reason` to that file, warns, and skips the entry. Unset — tests,
  `astro dev`, CI against the fixture vault — it throws, naming the file, as
  before. The fixture vault must stay contract-valid, and a strict build is
  how CI keeps it so.
- **The deploy goes red after it publishes.** A step after the Cloudflare
  upload lists the report in the job summary, emits an error annotation per
  entry and exits 1. The good content is live, and the failed run is the
  announcement ADR 0020 found missing: GitHub emails the owner, and the
  summary says which file and why.
- **Skipped means absent everywhere.** Every page, the sitemap filter and
  `short-redirects.ts` read through `readVault`/`readCollections`, so a skipped
  article has no page, no listing, no short link and no sitemap row. This is
  the safe direction for the flag that most needs it: an `unlisted` that failed
  to parse hides the article rather than publishing it.
- **The reason is one line.** Zod reports issues as a pretty-printed JSON
  array; the reader condenses them to `field: message` pairs, for the report
  and for the error a strict build throws.
- **The empty-vault guard stands.** A vault whose every article was skipped
  still refuses to build: that is a wrong checkout or a broken contract, not
  an article to leave out.

## Rejected

- **Skipping silently.** Dropping a curated list or an article and reporting
  success is the failure ADR 0020 set out to end, moved somewhere quieter.
- **Running `validate` in the vault before dispatching.** It reports earlier,
  in the vault's run, but blocks nothing and unblocks nothing: the deploy
  still fails on the same file. Worth adding on its own merits, not instead.
- **Skipping in every build.** CI against the fixture vault is where a
  contract change that breaks the fixtures should fail, so the strict mode
  stays the default.

## Consequences

- One bad file costs its own page, not every deploy, and the run that
  skipped it is red until the file is fixed.
- A deploy run can now be red while the site is up to date. The job summary
  is where to look before re-running anything: a re-run publishes the same
  site and goes red the same way until the vault file is fixed.
- Each module graph that reads the vault appends its own line, so the report
  holds duplicates; the deploy de-duplicates with `sort -u`.
