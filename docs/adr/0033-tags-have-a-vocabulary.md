# ADR 0033: Tags have a vocabulary

Status: accepted (2026-09). Supersedes, in part, ADR 0002's "free-form tags":
tags are still the model's, but written in one form, in English, and reused
from the vault's own vocabulary before new ones are coined.

## Context

The processor asks the model for "3 to 6 short free-form topic tags,
lowercase", with nothing about language or form and nothing about what the
vault already uses. Measured on the live vault on 2026-09-26, with ~180
articles:

- 793 distinct tags, 688 of them on exactly one article. The site's own URL
  merging (`tagSlug`: case, spaces and hyphens) brings that to 768 pages.
- The same topic in two languages — `ai安全` beside `ai safety` — and in
  spellings the URL merge does not reach, such as underscores and plurals.
- 129 distinct tags in Chinese script, written for Chinese articles and for
  some English ones.

A tag on one article is not a way to find anything: its page lists the article
you are already reading. The tag pages and the search page's chip list had
become an index of singletons.

## Decision

### 1. One canonical form

`normalizeTag` in `@tiro/shared` is the form every tag is written in: NFKC,
lowercase, words separated by single spaces. A hyphen becomes a space —
`open-source` is `open source` — except beside a digit, where it is part of a
name (`gpt-4`, `utf-8`, `l2-cache`). Other inner punctuation stays, because it
means something (`c++`, `c#`, `node.js`, `ci/cd`). It is idempotent, and it
never moves a tag off the page its variants already shared.

Spaces rather than hyphens is the owner's choice: a tag is read as a label,
and the URL form is the site's business (`tagSlug` still hyphenates).

Normalizing alone changes little — on the live vault it lands exactly on the
768 pages the URL merge already made — because the variants it folds are the
ones the site was already folding. It is the ground the rest stands on: a
vocabulary is only countable once each tag has one spelling.

### 2. English, through the vault's aliases

What the model writes is held to a policy before it is written
(`writableTags`): each tag normalized, put through `tags.aliases` in
`tiro.yml`, dropped if it is not in English (Han, kana or hangul), and the list
cut to six. The prompt asks for the same — English even when the article is
not, lowercase, spaces between words, a proper noun by its usual English name
— and the policy is what holds when the model does not listen. A dropped tag is
logged.

English is the owner's choice. A Chinese article's topics are the same topics,
and a second spelling of each in another script is the split this exists to
stop. The site is Chinese, but its tags were already 87% English.

The policy applies to model output only. Tags an article already has, kept
because a failed run had nothing better, are only normalized: dropping one
would be a run deciding for a person.

The reply schema stops capping tags at eight. A ninth tag used to fail the
whole reply and spend one of the article's three attempts; now it costs a tag.

An alias is how a person steers the model without editing articles:
`large language models: llm` merges two tags as they are written, and
`misc: null` refuses one. Both sides are normalized, so an entry matches
however either is spelled; one hop, so an alias table cannot loop.

### 3. The vault's own vocabulary, offered and enforced

Each run builds a vocabulary from the vault itself: every English tag that at
least two articles carry, after normalizing and aliases, most used first, cut
to 150. On the live vault that is about 115 tags. It is offered in the prompt
("reuse one whenever it fits; coin a new tag only for a central topic none of
them covers"), and the policy holds an article to **at most two tags from
outside it** — unless that would leave it with fewer than three, so an article
on a topic the vault has never seen still gets its tags.

- **Derived, not kept in a file.** A curated list would need upkeep and would
  drift from what the vault is actually about. The aliases are the one thing a
  person maintains.
- **Only tags that recur.** A tag on one article names nothing it has in common
  with another, and offering the model the long tail would teach it the tail.
- **The whole vault's, even for one article.** Discovery used to skip other
  articles under `--slug` before reading them; it now reads every article's
  tags, so a one-article run is offered the same list.
- **Frozen for the run.** Built once before any article, so the order articles
  run in cannot change what any of them is offered.
- **An empty vocabulary caps nothing.** A new vault has nothing to reuse yet.

### 4. A report to measure it by

`tiro-process tags` measures the vault's tags without changing anything:
distinct and single-article counts, the vocabulary a run would offer, and the
tags not in English, not in canonical form, or in both singular and plural. It
is how the numbers in this record were taken, and how a retag is judged.

### 5. Retag what is already there

The rules above apply as articles are processed, so on their own they would
take as long to reach the vault as it takes to reprocess it. `tiro-process
retag` brings processed articles up to them: one JSON-mode call per article,
from its title and summary with its old tags as hints, through the same prompt
lines, policy and vocabulary as a run. It rewrites only `tags`, keeping the key
order the processor writes, and never touches the processing markers.

A command beside `backfill-titles`, for its reasons: `--force` over the vault
would re-translate whole bodies and re-download every image to change one line
per article. Its skip rule is the policy itself — an article whose tags already
meet it is not asked again — which makes it resumable without a marker of its
own.

## Consequences

- A tag's form is part of the content contract, alongside the schema, though
  the schema does not enforce it: articles written before this still parse.
- Tags change only as articles are processed. Until the vault is retagged, old
  Chinese tags and old spellings sit beside the new ones.
