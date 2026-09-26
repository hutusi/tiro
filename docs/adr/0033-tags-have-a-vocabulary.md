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

## Consequences

- A tag's form is part of the content contract, alongside the schema, though
  the schema does not enforce it: articles written before this still parse.
- Tags change only as articles are processed. Until the vault is retagged, old
  Chinese tags and old spellings sit beside the new ones.
