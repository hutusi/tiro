# ADR 0043: X Articles are read from X's own markup

Status: accepted (2026-10). Changes what a clip of an X Article contains, not
its shape, so `tiro.schema` is unchanged.

## Context

The owner noticed that X clips had wrong titles. The vault held three, and all
three were X **Articles**, X's long-form posts. Measured live in Chrome, since
X builds the page with script and the sweep sees only a shell:

| Saved title | Headline the page shows |
|---|---|
| `(5) X` | A Field Guide to Fable: Finding Your Unknowns |
| `(1) DAN KOE on X: "…" / X` | You need to be delusional if you want to succeed |
| `Jensen Huang on X: "…" / X` | NVIDIA AI Factory Compute Is Becoming an Investable Asset Class |

Each was the tab's title, with the reader's unread count in it. ADR 0042 does
not help:

- **The headline is not an `<h1>`.** It is a `<div>` labelled
  `data-testid="twitter-article-title"`. The Article's own section headings are
  the `<h1>`s and `<h2>`s.
- **Nothing confirms it.** The rendered page has no `og:title` and no JSON-LD;
  X serves those only to crawlers.

The bodies were worse than the titles:

- **Every link in the text was gone**, 8 of 8 in one Article and 2 of 2 in
  another, and each paragraph holding one was cut in two. "I've made some
  [example artifacts for finding unknowns here], but be sure…" was filed as
  "I've made some" and "but be sure…".
- **Every heading was gone**, 15 of 15 in one Article and 3 of 3 in another.

**X writes an Article as Draft.js blocks built from generic views.** Every
element is a `<div>` unless it is a heading, list item or quote, and a class
decides how it is laid out:

- A paragraph is a block `<div>`, `longform-unstyled`, around Draft's block
  `<div>` around the spans of its text.
- Each link is wrapped in one more `<div>`, which X styles `display: inline`.
- A heading's class is `longform-header-one` or `longform-header-two`.

Readability goes by tags and class names, and three of its rules met that:

1. **A `<div>` is a block.** The paragraph is split at the link's `<div>`, and
   the link, alone in its own block, is cleaned away as page furniture.
2. **A paragraph built from a `<div>` is deleted whole** when more than a fifth
   of its text is link text (`_cleanConditionally`). A `<p>` never is.
3. **A class containing `header` marks page furniture**, removed before
   anything is scored. That took every heading.

## Decision

**An X Article is read from the labels X puts on it.** Both rules key on X's
markup rather than its host, the way a Hacker News thread is recognised (ADR
0038), so a page without that markup is untouched.

**The title** is the text of `twitter-article-title` (`takeXArticleTitle` in
`packages/clip/src/title.ts`). It ranks below LaTeXML and above ADR 0042's
rule, under two guards:

- The label must sit in the `twitterArticleReadView` that holds the Article's
  text. That held on all three pages. A post quoting an Article may preview it
  in a card, and that title is not the post's.
- Exactly one may be shown.

The element is also removed before Readability runs. It sits in the same view
as the text, so if Readability ever took that whole view as the article, the
body would open by repeating the title. None of the three clips did.

**The text** is read block by block (`retagXArticleBlocks` in
`packages/clip/src/dom-prepare.ts`). Inside `twitterArticleRichTextView`, each
`[data-block="true"]` that holds a line of text is changed in three ways:

- Its inner `<div>`s become `<span>`s. Inside a text block, every `<div>` is
  Draft's wrapper or a link's wrapper.
- A `<div>` block becomes a `<p>`. Headings, list items and quotes keep their
  tags.
- The block loses its class, which names a Draft style and nothing downstream
  reads.

A `<section>` block holds media and is left alone. So is a block holding
anything but `<div>`s and phrasing elements.

## Alternatives considered

- **Re-tag any `<div>` the page lays out inline, on every site.** This was
  tried first. The extension would have passed the live page beside the clone,
  so the clip could read computed styles. Measured on a page from each of 13
  sites in the vault, 11 had no such `<div>`, so the change would have been
  small. It failed on X itself. With the link's `<div>` made a `<span>`, the
  paragraph became one `<div>` of text and links, and Readability's
  link-density rule deleted it whole. A split paragraph became a lost one.
  Making the paragraph a `<p>` as well would have had to apply to every site,
  where a `<div>` of links is often a menu that the same rule is right to
  remove.
- **A rule for X's host.** It would have been no simpler, and ADR 0013 keeps
  host rules for identity. X's labels are what says "this is an Article", so
  the rules key on them.
- **Retitle the three articles in place**, as ADR 0042 did. That fixes only the
  titles. The bodies are missing every heading and link, so they are re-clipped.

## Consequences

- **The sweep cannot check any of this.** X refuses its fetch and would send
  a shell anyway. The tests reproduce X's markup as measured, with invented
  text. Run through the clipper before this change, that markup gave exactly
  what the vault held: headings gone, links dropped, paragraphs cut.
- **The three X articles are re-clipped**, by the owner in Chrome, because X
  shows Articles only to a logged-in reader. Each is summarised and translated
  again.
- **An Article that opens with its own headline keeps it.** Jensen Huang's
  does: its text has 41 blocks, the clip has 41, and the first is the
  headline. Those are the author's words, not the label this reads, so the
  site shows the title above a first paragraph that repeats it.
- **A plain post is unchanged.** It has neither label, so it keeps the tab's
  title, unread count and all. That title at least quotes the post. A rule for
  it can come when the vault holds one.
- **If X renames its labels, the rules stop matching.** The clip then falls
  back to what it did before, rather than to something new and wrong.
