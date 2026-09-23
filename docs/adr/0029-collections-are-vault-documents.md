# ADR 0029: Collections are vault documents, edited from the Tiro page

Status: accepted (2026-09). The site half — contract, pages, validation,
migration, and the vault's publish workflow — ships first; the clipper that
edits collections from a Tiro page ships separately and is described here so
the two halves are one decision.

## Context

Everything the vault says about an article was written by a machine. The clipper
records what the page was; the processor writes the summary, the tags, the
category and the translation. There is nothing an owner can point at and say
*I chose this* — no favorites, no reading list, no "these belong together".

Tags and categories look like they could serve, and do not. They are LLM output
(ADR 0002: "there is no clip-time taxonomy UI"), they are rewritten whenever an
article is reprocessed, and a free-form tag chosen by a model is exactly the
wrong place to store a decision made by a person.

The site is static and the vault is the only source of truth, so a curation has
to be written *into the vault* — and the one component that already holds a
write token is the clipper.

## Decision

### One file per collection, the filename being the id

`collections/<id>.md`, beside `articles/`, with frontmatter and an optional
markdown body — the same document shape as an article:

```yaml
---
title: "AI 安全"
description: "一句话说明"          # optional
created_at: "2026-09-22T10:00:00.000Z"   # optional
updated_at: "2026-09-22T11:30:00.000Z"   # optional
items:
  - slug: "example-com-posts-hello-ai-e8446b12"
    added_at: "2026-09-22T11:30:00.000Z"  # optional
tiro:
  schema: 1
---

Optional prose, rendered on the collection page.
```

- **The id is the filename stem**, never stored inside the file — the rule
  ADR 0007 set for articles, for the same reason: one definition of identity,
  which the path guarantees.
- **Ids are ASCII** (`[a-z0-9]+` joined by single dashes). `collectionId`
  folds a typed name to that, falling back to a hash for a name that folds to
  nothing — every Chinese one. A tag slug keeps non-ASCII on purpose (it is only
  ever a URL); an id is also a filename in a repository cloned onto macOS, Linux
  and CI, where NFD and NFC disagree and one collection would become two. The
  display name lives in `title`.
- **`items` order is the curation order.** The site renders file order and the
  clipper prepends, so a collection reads newest-first until its owner reorders
  it by hand, and no sort ever overrules that. `added_at` is for display.
- **Only `title` is required.** A collection must stay worth writing by hand:
  `- slug: x` on its own is a valid member.
- **`tiro.schema` is the same dial** the article document uses. Both are vault
  documents written by the same three components, so a breaking change to
  either is the same lockstep event. Adding the directory is additive — no
  `collections/` means no collections — so nothing bumps.

### Favorites is a collection

`collections/favorites.md`, a reserved id, created on first use. A favorite is
membership in it and nothing else, so there is no flag to keep in step with a
list and no second mechanism to render.

Its page exists before its file does. `/favorites/` redirects unconditionally
and the clipper offers favorites first on every vault, so the site builds an
empty favorites collection when the vault has none — otherwise the shortcut is
a 404 until the first favorite. That stand-in is left out of the catalog the
clipper reads: the clipper sends a title only for a collection missing from it,
and that title is what `favorites.md` is born with.

### Membership is not listing

The site builds collection pages from `getArticles()`, the listed funnel, so an
**unlisted member does not appear on its collection's page**. ADR 0017 removed
enumeration, and a public list naming the article would put it straight back.
The membership itself is untouched: the article's own page still shows the
chip, and the clipper's tick still reads true, because both describe the vault
and not what the site chose to publish. A member whose article no longer exists
is skipped the same way — a missing row, not a failed build — and `validate` is
what refuses it.

### Detecting a Tiro page by marker, not by hostname

Every page carries `<meta name="tiro:site" content="1">`; an article page adds a
`#tiro-page` JSON island holding its slug, its memberships **and the whole
collection catalog**. Recognizing the page by a marker is what lets a
self-hosted deployment on any domain work unchanged. Carrying the catalog is
what lets the clipper draw its full tick-list from the DOM and send nothing
anywhere until the reader toggles something.

The marker says "a Tiro site", not "*your* Tiro site" — the price of not
checking the host. It is settled at write time instead: adding an article checks
that its slug exists in the configured vault first, which covers someone else's
deployment, a stale tab and a since-deleted article in one check.

### Edits are queued and flushed as one commit

The clipper queues toggles locally, vault-scoped the way the clip history is,
and flushes them as a single multi-file commit through the Git Data API (ref →
tree with inline content → commit → ref, never forced). One flush is one push,
one workflow run and one build, however many collections it touches. Applying
the queue is `applyCollectionOps`, which is pure and idempotent and applies a
delta to the file as it now stands — so an edit made on another machine
survives, and replaying a flush that already landed changes nothing.

### A collection push publishes and never processes

`process.yml` filters on `articles/**` and every processor glob is rooted at
`articles/`, so a collection file is invisible to processing: no model call is
ever spent on curation. But `process.yml` is also the only thing that told the
site to rebuild, and it dispatches only when it committed something. So the
vault gains `publish.yml`, on `collections/**`, whose one step dispatches
`vault-updated`. Its concurrency group cancels in progress — throwing away a
dispatch costs nothing, and the site's `deploy` group already collapses a burst
of builds to the newest. `process.yml` keeps `cancel-in-progress: false`:
cancelling it would discard paid model work mid-article.

### Migration carries membership

A slug-rule change renames articles (invariant 2). `sweep --recanonicalize`
rewrites every collection naming a moved slug, in the same write as the
article's `index.md` and before the directory rename, so a crash between them
leaves a state the next run finishes rather than a moved article whose
collections name a slug nothing will look at again.

## Consequences

- The vault gains its first vault-level document that is not configuration, and
  so its first cross-reference: a collection names articles by slug. Deleting
  an article is no longer "remove its directory and nothing else refers to it"
  — its collections must drop it too, and `validate` says which.
- A collections-only push now redeploys on its own. Every other hand edit to the
  vault still needs a deploy dispatched by hand, as before.
- The header nav gained a fourth item, which broke every label per character at
  390px until the phone-only spacing was tightened. A measured width budget, not
  a design preference, is what decides how many items that row holds.
- Collection pages are not in the search index. Only listed article pages
  declare a Pagefind body, plus the library's empty state; a collection's own
  empty state must not, or an empty collection becomes a search result.
- `publish.yml` lives in `vault-template/`, which does not propagate: the live
  vault needs it copied in by hand.

## Rejected

- **Membership in article frontmatter** (`tiro.collections: [...]`). It rides
  with the article, so a deleted article can never leave a dangling entry — the
  one real advantage. But the processor rewrites `index.md` on every run, so a
  toggle would race the pipeline on the one file everything depends on; every
  toggle would re-read and rewrite a file that can exceed a megabyte; and
  per-collection order and `added_at` have nowhere natural to live.
- **One `collections.yml` holding every collection.** One file makes a flush one
  Contents-API PUT with no Git Data API at all, which is simpler. Rejected by
  the owner in favour of a document per collection, which reads, diffs and
  hand-edits like an article and gives each collection room for its own prose.
- **A slug list in `config/tiro.yml`.** ADR 0017 already rejected this shape for
  `unlisted`: config is configuration, and the site does not read it.
- **Favorites in the browser's `localStorage` on the site.** Per-device, never
  in the vault, invisible to every other reader. The vault is the source of
  truth or it is not.
- **Recognizing a Tiro page by hostname.** Breaks every self-hosted deployment
  and every preview URL. A marker costs one `<meta>`.
