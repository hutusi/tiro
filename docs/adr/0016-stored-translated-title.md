# ADR 0016: The translated title is stored, not derived

Status: accepted (2026-09). Answers the open question ADR 0014 left; it does not
reverse it. The derived title stays as the fallback and keeps sole ownership of
the decision to skip the body's first row.

## Context

39 of the vault's 40 articles are English, carry a Chinese summary and Chinese
tags, sit in a Chinese UI, and have a fully block-aligned `zh.md`. Their titles
are English — in the library list, in the reader's title block, and in search
results. It is the last untranslated thing on the page.

The site has had the markup for a Chinese title since ADR 0014, but the value is
derived: `liftTitles` produces one only when the body's first block is an H1
whose plain text equals `frontmatter.title` *and* `zh.md` mirrors it with an H1.
A scraped article does not repeat its own title, so no live article has that
shape, `titleZh` is `null` everywhere, and the two-column title block has only
ever been rendered against fixtures — all four of which happen to open with
their own title. ADR 0014 recorded the gap and named the fix.

`zh.md` cannot hold the title. It is a bare body that must stay strictly 1:1
block-aligned with `index.md` (ADR 0003, invariant 4), so a title added to it is
either an extra block that breaks alignment or a heading the reader must then
decide not to be content. Frontmatter is the one place left.

## Decision

- **`title_zh`**, optional, top-level on `ArticleFrontmatterSchema`. `tiro.schema`
  stays 1 — optional and additive, the `has_math` / `clipper_version` /
  `clipper_commit` / `source_url` precedent.

  On the *article* schema only, which inverts the rule those three follow. They
  are written by the extension, so a read side that omitted them would delete
  them on the first processor round-trip. This one is written by the processor,
  and a re-clip *should* drop it: the page's title may have changed, and the
  same clip clears `tiro.processed_at`, so the next run writes it again against
  whatever the title is now.

- **Produced by the existing summary call**, as one more key, only for an
  article that is not already in the target language. The saved round trip is
  the small part. The reason it belongs there is that the title and the summary
  render one under the other in every library row: produced by one call over one
  body they agree on how a term is rendered, and produced by two they drift.

  It stays **optional in the response schema even when the prompt asked for it**.
  A schema failure is fed back as a correction and, after three attempts, drops
  the article to an excerpt summary and marks `tiro.summary_failed` — an
  operator signal meaning "reprocess this one by hand". Requiring the key would
  spend three round trips on a 30 K-char body and cost an article its summary,
  category and tags because a model omitted a title.

  A candidate with no Han character is an echo, not a translation — `The
  Twelve-Factor App` handed back unchanged — and is dropped. One Han character
  is the whole bar, not a ratio: a real translation can be almost entirely
  product name (`为 Claude Fable 5.1 编写提示词`).

- **`summary_orig`**, the same summary written in the article's own language,
  from the same call and the same gate. `summary` is written in the target
  language rather than translated, so an article has no summary in its own
  language at all, and the reader's title block shows 摘要 with nothing opposite
  it while every other row on the page is a pair. Not a rename of `summary` to
  `summary_zh`: every article in every vault already carries `summary` meaning
  the target-language one, and renaming it is the breaking change `tiro.schema`
  exists to version. It is asked for in the article's own words rather than by
  naming a language, because `lang` is `detectLang`'s coarse "not the target"
  label — a French article is filed as `en` and would be told to summarize
  itself in English.

  It renders **only as half of a pair** — when the article also has a Chinese
  title. On its own the two summaries stop opposing each other (side by side,
  `.zh.no-title` pads the Chinese one up to the `h1` while this one sits below
  it; stacked, they are two paragraphs both labelled 摘要 with nothing between
  them), and requiring the title carries the `lang` guard for free, since a
  Chinese original has none. The field is still stored when the title is missing:
  a later run that produces one makes it visible.

- **The site prefers the stored title**, falling back to the derived one for
  articles processed before the field existed and for the fixtures that exercise
  that path. `liftedH1` is *not* re-derived from it: it answers a different
  question — does the body repeat its own title — and re-deriving it would drop
  a `zh.md` row the translation pane still needs.

- **`tiro-process backfill-titles`** fills the existing articles: one small call
  each, from the title and the article's already-written Chinese summary, writing
  only `title_zh`.

## Consequences

- The library's `.title-zh` row and the reader's two-column title block go live
  for 39 articles at once — the first real content that layout has ever held. It
  needs a visual pass across list and cards, all three reader modes, mobile, and
  both papers.
- Chinese titles become searchable: Pagefind already indexes `title_zh` as meta
  and the reader's title block as body text.
- The title is written by `modelFor(config, "summary")`, not the translation
  model. Identical in this vault; a vault that configures them separately gets
  its titles from the model that also chose the summary's vocabulary, which is
  the point rather than an oversight.
- A `--force` reprocess re-rolls the title exactly as it already re-rolls the
  summary and the tags, so a hand-fixed `title_zh` is not durable.
- `summary_orig` is deliberately not backfilled, so the library holds two shapes
  for a long time — most articles with 摘要 alone, new ones with a pair. Both
  have to look deliberate; the reader's existing `no-title` variant is the
  precedent.
- An article whose translation failed still gets a title: the summary call is
  independent of the translation stage, exactly as `summary` already is.
- `title_zh` is its own progress marker, so the backfill needs no checkpoint
  file — the cleanest instance of the resumability ADR 0008 argues for.

## Rejected

- **A second LLM call for the title.** An extra round trip inside the run
  budget, and a title translated without the body's context or the summary's
  vocabulary — the one thing it has to match.
- **The title as the first block of `zh.md`.** Breaks invariant 4 outright.
- **`--force` over the vault as the backfill.** Only 12 of the 39 articles still
  have a `.tiro-zh-cache.json`, so 27 whole bodies would be re-translated and
  every image re-downloaded, over hours of runs, to add one line each — inside a
  40-file diff that hides the 39 lines worth reading.
- **A flag on `run`.** It inverts invariant 3's selection rule — this job wants
  the articles where `processed_at` is *present*, and must not write it —
  permanently, in the code the vault workflow runs on every push, for a one-time
  migration.
- **Deriving the title from `zh.md`'s first block unconditionally.** Exactly what
  `liftTitles` refuses on purpose: the first block is usually not the title, and
  lifting it both invents a title and loses a row.
- **Bumping `tiro.schema`.** ADR 0002's rule is for breaking changes. Every
  existing article validates unchanged, and every reader has a fallback.
