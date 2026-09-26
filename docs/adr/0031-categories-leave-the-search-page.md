# ADR 0031: Categories leave the search page

Status: accepted (2026-09). Supersedes, in part, ADR 0014: the categories row
on `/search/` and the `/categories/` → `/search/` redirect. Everything else in
ADR 0014 stands.

## Context

ADR 0014 folded the tag and category indexes into 搜索与标签: every tag as a
chip, then the categories as a second chip row. That row had no heading. Its
only visual difference was a squarer corner, so it read as a second, smaller
set of tags.

It also repeated them. Categories are one pick per article from a fixed list
of nine (`categories` in the vault's `tiro.yml`), and the list overlaps the
tags the model writes: in the live vault `ai` is both the top tag and the top
category (61 of ~180 articles), so the page showed two `ai` chips that opened
different lists. Nine buckets that coarse are no help on a page for *finding*
something.

## Decision

The search page lists tags only. The categories stay a browsing aid:

- Each article's category is a link on its library row and in the reader's
  title block, and the per-category pages at `/categories/<slug>/` are
  unchanged.
- `/categories/` redirects to `/` rather than to a search page that no longer
  lists categories. Nothing on the site links to it, so this is only for old
  bookmarks.
- The nav no longer marks 搜索与标签 as active on a category page; that page
  is no longer reached from the search page.

## Consequences

- No page lists every category. That is the cost of the change. With nine
  fixed values and one on every article, the list is short, and the vault
  config holds it.
- If categories ever need an index again, it belongs with the library, as a
  filter over the list the reader is already browsing, not beside the tags.
