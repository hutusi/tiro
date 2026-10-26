# ADR 0055: A saved site is its own document

Status: accepted (2026-10). Adds a vault document beside articles and
collections; nothing earlier is reversed. Extends ADR 0029 (collections may
name a site) and ADR 0030 (a site's screenshot may be a cover).

## Context

Some pages are worth keeping but are not reading: an interactive map, a
visualization, a tool. The owner's example was a map of the battles of the
Roman Republic, built in script, whose text is a legend and a timeline. A clip
of such a page is either Readability's failure — the raw page as Markdown — or
"Nothing on this page could be read". Either way the vault ends up holding
something that does not resemble what was saved, and the site publishes it as
an article.

What the owner wants of such a page is a different record: a picture of what
it looked like, its title and description, a short introduction in Chinese, a
line of their own on why it was kept, and a way back to it. It should still be
tagged, searchable and collectable like everything else.

## Decision

### 1. A site lives at `sites/<slug>/`, not inside `articles/`

The first design made a site an article with a marker — `tiro.capture:
"site"` — at the article's own path. It was rejected for three reasons.

- **Some pages deserve both.** An interactive essay is something to read *and*
  something to come back to and play with. One path per URL made the second
  save replace the first, so the popup would have had to warn, and the warning
  would have guarded a loss.
- **Every article stage would need an exception.** Translation and `zh.md`,
  the image downloads, lead repair, every `sweep` mode, the translation rules in
  `validate`, reading time: about ten places would each have had to learn that
  this article is not one.
- **Old code would choke, not skip.** The released extension and the processor
  on `main` parse `tiro.capture` as `"link"` exactly, so a site written by a
  newer clipper is an invalid article to both: refused by the processor, and a
  red deploy (ADR 0048).

So a site is its own document in its own directory, as collections are (ADR
0029):

```
sites/<slug>/index.md
sites/<slug>/assets/<12 hex>.webp
```

The slug is `slugForUrl` of the page, the same rule as an article's (invariant
2), so saving a page twice updates one site, and an article and a site of the
same URL share a slug in different directories. Code that never heard of
`sites/` — every processor glob, every sweep mode, the released extension —
does not see one. Adding the directory is additive, so `tiro.schema` stays 1
(ADR 0002); a vault without `sites/` simply has none.

### 2. Elsewhere in the vault, a site is named `sites/<slug>`

An article is named by its bare slug wherever the vault refers to one — a
collection's member, the Tiro page marker. A site is named by its path below
the vault root: `sites/<slug>`. An article slug never contains a `/`, so the
two cannot be confused, and the form was picked for what older code does with
it.

- **A collection member.** `CollectionItemSchema.slug` is any non-empty
  string, so the released clipper parses `- slug: sites/<slug>`, carries it
  through a toggle untouched, and writes it back. A separate `site:` key would
  have been stripped by zod on that rewrite, silently emptying a collection of
  its sites.
- **The page marker.** A site page's `#tiro-page` island carries
  `"slug": "sites/<slug>"`. The released popup refuses a slug that is not a
  single path segment and treats the page as a plain Tiro page, so it cannot
  offer to toggle or remove *the article* with the same slug by mistake.
- **A cover.** `cover:` may name `sites/<slug>/assets/<file>`. The released
  clipper's pattern refuses that, so it will not toggle a collection whose
  hand-set cover is a site's until it is updated. Covers are hand-set and
  rare; that gap is accepted.

### 3. What a site records

| Field | Written by | Meaning |
| --- | --- | --- |
| `url`, `title`, `domain`, `clipped_at` | extension | As an article's. `url` is the identity. |
| `description` | extension | The page's own description: `og:description`, then `description`, then `twitter:description`. |
| `preview` | extension | `./assets/<12 hex>.webp`, the screenshot. |
| `note` | extension | The owner's line on why it was kept. Optional. |
| `unlisted` | a person | As an article's (ADR 0017), carried forward by a re-save. |
| `lang`, `title_zh`, `summary`, `category`, `tags` | processor | `summary` is the Chinese introduction. |
| `tiro.source_url` | extension | The exact address saved, when it differs from `url`. |

The body is the clipper's Markdown of the page — whatever text it had — kept as
context for the introduction. It is never rendered and never translated, and
it may be empty.

- **The screenshot is the visible tab**, what the owner was looking at, taken
  when the save is asked for. It is WebP, at most 1600 pixels wide, named by
  its bytes' hash like a figure snapshot (ADR 0039). That name is the
  processor's own shape, so a re-save's old screenshot is pruned once the new
  `preview` stops naming it. The processor counts `preview` as a reference,
  not only the body. A body-only rule would delete the screenshot of every
  site on its first run.
- **`tiro.source_url` keeps the view.** `normalizeUrl` drops the fragment, and
  a single-page app often keeps its state there. Identity follows the
  normalized URL; "open site" goes to the address that was saved.
- **The note is the owner's**, typed in the popup. It is the one field a person
  writes that is not in a collection, and it is safe where it is: the
  processor only ever rewrites a site to add what it derives, and round-trips
  the rest through the schema; a re-save reads the old note and offers it
  again.

### 4. The processor introduces a site and does nothing else to it

A site is pending when it has no `tiro.processed_at`, like an article
(invariant 3), and runs in the same budgeted loop with the same fault
isolation (invariants 7 and 8). Its processing is one call to the model:
title, address, description, note and up to 8,000 characters of the body go
in; a two-to-three sentence introduction in the target language, a category,
tags from the vault's vocabulary (ADR 0033) and, for a site in another
language, a translated title come out. The language is detected from the
title, the description and the text together — an empty body alone reads as
English — and never from the note, which is in the owner's language, not the
site's: counted, a Chinese note made an English site "zh" and cost it its
translated title.

Sites run first in the same work list as articles, since each is one call and
so cheaper than any article; the loop's budget, outage breaker and deferral
apply to both alike.

Nothing else from the article pipeline runs: no fetch, no image download, no
translation, no `zh.md`. A reply the model cannot get right falls back to the
description, marked `summary_failed`, as an article's falls back to its first
paragraph.

### 5. The site has a gallery, and a page per site

- **`/sites/`** is a gallery of cards — the screenshot at 16:10, the title, the
  domain, two lines of the introduction — newest first, paged like the
  library.
- **`/sites/<slug>/`** shows the screenshot, linked out; the title; the
  introduction; the page's description; the owner's note; and the tags,
  category and collections. The note and description are text, never
  Markdown or HTML (invariant 5).
- **The home library and RSS stay articles.** They are a reading list.
- **Tags, categories, collections and search show both**, sites badged 网站.
- **A site in a collection lends its screenshot** to the collection's cover,
  as an article lends its lead image (ADR 0030).
- **No short link.** `/s/<id>` is the slug's hash suffix, which a site shares
  with the article of the same URL.

### 6. The extension saves a site from the toolbar

"Save as site" sits beside Clip in the popup: it takes the screenshot, shows
it with the title and description, and offers a note. When the clip found
almost no text — under 500 characters, the threshold the processor already
uses to call a fetched page script-built (ADR 0034) — the popup says the page
may be an app, map or tool and makes saving it as a site the main action. What
used to be a dead end, a page with nothing to clip, becomes that offer.

Only the toolbar can do it: `captureVisibleTab` needs the click's `activeTab`
grant, so there is no right-click or phone save of a site.

A screenshot can show anything on the screen, and the note is the owner's own
words, and both now leave the browser: to GitHub, and through the vault's job
to the model provider. The disclosure moves to version 9.

## Consequences

- One URL can be an article, a site, or both, and none of the article
  machinery changes to allow it.
- Every place that assumed `articles/` was the only root learned a second
  one. That covers collection members and covers, served assets, `validate`,
  `retag`, `sweep --recanonicalize`, Remove, the commit-back's rule that a
  deletion on `main` wins over a run's changes (ADR 0036), and the vault's
  `process.yml` trigger, which must list `sites/**` or a site waits for the
  daily run.
- A site's introduction is written from text alone. A model that can read the
  screenshot might write a better one for a page whose text says little.
  That is left for when the text-only ones prove thin.
- A site has no `og:image`: the screenshot is WebP, which link previews do
  not reliably show (ADR 0030).
