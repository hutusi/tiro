# ADR 0038: A Hacker News thread is clipped from its own markup

Status: accepted (2026-10). Applies ADR 0013's "content is structure-keyed"
to a third kind of page; touches neither identity nor the content contract.

## Context

Clipping a Hacker News item page (`news.ycombinator.com/item?id=N`) produced
nothing worth keeping. Every comment on that page is a row of one flat table,
and its depth is an attribute (`td.ind[indent]`) rather than nesting.
Readability scored the rows as layout. It kept each comment's *header* and
pruned the text under it. Measured on a live 193-comment "Tell HN" thread, the
clip was:

- 190 two-row tables of `| s.gif | | [user](…) [1 day ago](…) \| [–] |`;
- the post's own text missing;
- every comment body missing;
- the excerpt "JKCalhoun 1 day ago | [–]".

Nothing about that page is a near miss that a repair pass could coax
Readability through. The structure has to be read directly.

What the page holds, measured on live threads:

- **The whole thread, on one page.** HN no longer paginates. A 2,540-comment
  thread is one 3.4 MB document, and `item?id=N&p=2` declares
  `rel=canonical item?id=N`.
- **Collapse state, in classes.** HN's script marks a comment the reader
  folded with `[–]` as `coll`, its text as `noshow`, and every reply under it
  as `noshow`. The server renders the same classes for its own folds, even on
  an anonymous fetch. One 2,540-comment thread arrived with 18 folded comments
  hiding 146 replies:
  - 10 were flagged comments;
  - 8 were off-topic subthreads the moderators had collapsed.
- **No other page shares the head.** `table.fatitem` heads an item page,
  whether a story or the permalink of one comment. The front page, `/newest`,
  `/user` and `/threads` have none.

## Decision

### The thread is clipped from the markup, before any repair

`clipPage` branches on `isHackerNewsItem`: a `table.fatitem tr.athing` with a
numeric id holding a `.titleline` (a story) or a `.comhead` (a comment). The
branch sits beside the PDF-viewer and markdown-file branches, and it runs
before `prepareForClipping`, which would rewrite the rows it reads.

Because the branch is in `clipPage`, every consumer gets it with nothing
added:
- the tab clip;
- a saved link the processor fetches (ADR 0034);
- `sweep`.

Detection is by structure, never by host. A renderer owns its markup (ADR 0013).

### One comment, one top-level block

A thread becomes:

- **For a link post, the story's URL**, as an autolink with no prose, so the
  translator returns it untouched. A self-post has none, because its title
  links to itself.
- **The self-text**, as ordinary top-level blocks.
- **For a poll, its choices**, as one list, each with the points it had when
  clipped. The count is the poll's answer. A choice is neither text nor a
  comment: it is another `tr.athing` in the item's head, with its points in the
  row after it, so nothing above would otherwise read it.
- **Each comment as a blockquote** nested one level per depth. It opens with a
  header (`**author** · [YYYY-MM-DD](permalink)`), followed by the comment's
  text.

A blank line ends a blockquote, so each comment is its own top-level block:

```
> **alice** · [2026-10-04](https://news.ycombinator.com/item?id=111)
>
> First paragraph…

> > **bob** · [2026-10-04](https://news.ycombinator.com/item?id=112)
> >
> > Reply…
```

That block is the unit translation batches in and the reader pairs (ADR 0003).
A translation that drops the quote markers changes the block's type. The processor then
reverts that one block to the original, so it costs one comment's translation,
not the article's `zh.md`.

### Code inside a block is masked like math

A top-level code block is verbatim and never sent to the model. A fence inside
a comment is part of a blockquote, so it would travel with the prose. The
model then translates the code's comments, strips tags it takes for markup,
and breaks the fence, and the block is still a blockquote, so alignment
passes. A reviewer reproduced `const answer = 42;` coming back as `99;`. The
live vault already held one such block from an ordinary article: a prompt
template inside a quote, published with its `<think>` tags gone. About one HN
comment in two to five hundred carries code.

The processor therefore masks every code node at any depth (`codeRanges` in
`@tiro/shared`), the way it masks math (ADR 0009):
- the span from the opening fence to the closing one, container markers
  included, becomes a `TIROCODE` token and is put back verbatim;
- a block whose code comes back different is reverted, which also catches a
  checkpoint written before the mask existed.

This applies to every article, not only threads. A list item holding a fence
had the same exposure.

The header and the text are built as HTML and converted together by
`htmlToMarkdown`. Turndown therefore escapes a name like `teh_infallible` the
way it escapes everything else, and a quote a commenter typed as `> …` stays
text (`\>`). The date is the day only. HN's label is relative ("1 day ago")
and would be wrong from the moment it was stored. Its `title` is a zone-less
UTC timestamp.

On a comment's permalink page, the comment is the article:
- the title is `<author> on: <story title>`;
- the body opens with the thread's URL, then the comment's text;
- replies are blockquotes under it.

### The thread is what the tab shows

A row marked `coll` or `noshow` is skipped. A folded comment always takes its
replies with it, so the depth of everything left stays coherent. The reader
prunes a thread with the control the page already has: fold a subthread, then
clip. There is no setting for it.

A saved link is fetched without a browser, so it has no reader's folds, but it
has HN's. Flagged comments and moderator-collapsed subthreads stay out on that
path too, which is what HN shows anyone.

A visible comment with no text (`[deleted]`) keeps its header and HN's marker,
because its replies are still answering it.

### No identity rule

`?id=` survives `normalizeUrl`, so every item already has one stable slug,
`news-ycombinator-com-item-<hash>`. HN has no alternate URL form worth
merging: `&p=` is obsolete, and fragments and trackers are already stripped.
`canonical-url.ts` is untouched.

### The site sets a thread as a thread

The reader styles blockquotes with typography's defaults: italic, medium
weight, curly quotes, a heavy rule. Under those, a whole discussion reads as one
long quotation.

An article whose `domain` is `news.ycombinator.com` carries `data-thread` on
the reader. Under it a blockquote is only a rail:
- upright text, no quote marks;
- a thin rule;
- spacing only between sibling comments;
- the header line in the UI face, muted.

The domain is the signal because every clip path writes it. A new frontmatter
field would have to be declared on both schemas or the processor's round trip
would delete it. It would also put a presentation concern into the contract.

## Consequences

- **No new permission, origin or disclosure.** The tab holds the whole thread,
  and a saved link is one fetch of the page itself.
- **Translation cost scales with the thread.** Measured on visible comments:
  193 comments are 8k words, 771 are 43k, and 2,376 are 94k. Translation
  checkpoints and resumes across runs (ADR 0008). The summarizer reads a
  truncated body, so a long thread is summarized from its post and first
  comments. Folding a noisy subthread before clipping is the lever.
- **Saved links have two limits.** A saved link to a link post with no comments
  is under `fetch.min_chars` and is refused like any other thin page. A thread
  past `fetch.max_bytes` (5 MB) is refused rather than truncated. Both clip
  fine from the tab.
- **The style follows the host, not the structure.** The clip is
  structure-keyed and the style is host-keyed, so a page with HN's markup on
  another host would be clipped as a thread but styled as ordinary prose. No
  such page is in the vault.

## Rejected

- **Lifting a comment's code out of its quote**, as a top-level code block that
  is verbatim by contract. One comment would become several blocks, and the
  code would lose the depth that says whose reply it is. Masking keeps the
  comment whole and the code exact.

- **Nested lists for the tree.** A list is one top-level block however deep it
  goes, so a subthread would be translated and paired as one unit. A block
  past `translation.max_block_chars` (20k) is copied through untranslated, and
  a busy subthread passes that.
- **The Algolia or Firebase API.** It would be one more outbound origin with
  its own permission and disclosure, for a thread the tab already holds whole.
  It would also ignore the reader's folds, which are the point.
- **Clipping the linked story instead.** Right-click → "Clip link" on the front
  page already saves a story. An item page is clipped for its discussion.
