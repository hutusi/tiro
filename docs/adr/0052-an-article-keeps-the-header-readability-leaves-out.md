# ADR 0052: An article keeps the header Readability leaves out

Status: accepted (2026-10). Changes what the clipper extracts from one page
shape, and adds `lead` to the clip payload. It touches neither identity nor
the document format, so `tiro.schema` is unchanged.

## Context

The owner compared a clip with its source. The page was The Atlantic's "Old
Times on the Mississippi (Part I)", and the Tiro copy had lost the lead
picture and its credit, the dek ("The first installment in a seven-part
series…"), and the "By Mark Twain" line. Some other articles had lost the
short intro that sits above the body.

The Atlantic sets its header beside the body, not inside it:

```
article.ArticleLayout_article
├── header.ArticleHero_root          h1, dek, <address>By …</address>, lead <figure>, date, share
└── div > section.ArticleBody_root    the paragraphs
```

**Readability looks only at its chosen block's siblings.** It scores the
paragraphs and chooses the wrapper of `ArticleBody_root`, which scores 338.
Its sibling pass then considers only that block's siblings. The header is
one of them, but it scores 22.5, under the 20%-of-the-best threshold for
joining, so it is dropped whole. What survived:
- **the title**, through ADR 0042;
- **the byline**, as `author` from JSON-LD, which the site already prints in
  the article's meta row;
- **the dek**, only as `excerpt`, which no reader sees and the summarizer is
  not given.

The picture and its caption were gone.

**It is a class, not a publisher.** Measured on 210 saved pages:
- The Atlantic: 37 of 40 had lost something, 35 a dek and 35 a picture.
- Across the vault, 228 of its 245 Atlantic articles had lost their dek.
- 32 articles on 21 other sites, including 11 Substack posts that lost their
  subtitle (an `h3.subtitle` above the body) and IEEE Spectrum, Quanta,
  Noema, Ars Technica, Big Think, Lit Hub and github.blog.

When Readability chooses the whole `<article>` instead, as it does on some
short Atlantic pieces, the dek is already the body's first paragraph.

## Decision

**After Readability, the page is read again between the headline and the
place Readability's article begins. Two things may come back from there: the
dek, and the lead picture with its caption** (`articleLeadIn`). They go before
Readability's article, in the page's order, through every later pass like
the rest: videos, figures, anchors. A figure is rebuilt so it folds as one
picture with its caption under it.

Where the header is decided by position, not by name:
- **The headline** is an `<h1>` whose words are the clip's title or one of
  the page's metadata titles: ADR 0042's confirmed headline. A title written
  as "Headline | Site" also matches its headline part, when the part cut off
  is five words or fewer. The longest part is kept, so a logo `<h1>` naming
  the site never qualifies.
- **The body's start** is the first element of the page whose text begins
  with Readability's first paragraph of 30 or more letters. It is the first
  such element, not the only one: the Twain installments close on the same
  series note they open with, and Readability keeps the page's order.
- **The header** is what lies between them, inside the lowest box holding
  both.

What is taken is decided by the page's own metadata, never by class names:
- **A dek** is a block of text after the headline whose words agree with one
  of the page's descriptions (`description`, `og:description`,
  `twitter:description`, or an article node's JSON-LD `description`).
  Agreement is 0.8 of the larger word set, with Chinese, Japanese and Korean
  compared by character pairs. Dividing by the larger set rejects a tag line
  whose few words all appear in a long description.
- **A lead picture** is an image in the header, before or after the headline,
  that the page's card names (`og:image`, `twitter:image`, an article's
  JSON-LD `image`) or that the page sets as a `<figure>`. Pictures are compared
  by the last two segments of their path, after unwrapping image proxies and
  dropping the sizes a CMS appends. That is how a thumbnail service's crop
  matches its card, and how the 960×540 lead matches the 1200×625 card on
  the Twain page.

### The guards

Each guard has a test that fails without it.

- **Readability already read the header.** If any confirmed part is in its
  article already, nothing is added: a whole-`<article>` choice stays exactly
  as it was.
- **The article is real**: Readability's choice holds 500 letters or more, so
  a saved link's shell stays under the processor's `fetch.min_chars` (ADR
  0034).
- **The header is a header**: 5,000 letters or fewer between headline and
  body. The largest the corpus confirmed a lead in, Big Think's with its key
  takeaways, holds 4,088.
- **Not furniture.** No nav, aside, footer, form, button, time or caption
  (captions travel with their figure), no unlikely role, and nothing an
  earlier pass marked as an aside, a pull quote or a drawn figure.
  Readability's unlikely-candidate words are excluded, less `header`,
  `banner` and `meta`, which are what wraps a dek legitimately, and less a
  bare `ad` or `tag`: WordPress and RebelMouse put `tag-<topic>` on the article
  itself, and IEEE Spectrum's `tag-wall-street` hid its whole header.
- **Not the byline**: `byline`, `author`, `<address>`, `rel=author`,
  `itemprop=author`, even with a headshot in a figure.
- **A dek says something**: four or more words, under half of them link text,
  and after the headline, never before it.
- **A picture is a picture**: none declared smaller than 150×100 px, none
  named a logo, avatar, icon, headshot or profile.
- **One of each**: the first dek and the first picture.

### What it redoes of Readability

It reads the page as it stood before Readability, so it repeats what
Readability normalizes, which picture essays (ADR 0050) learned one review at
a time and which now lives in one module (`page-view.ts`):
- it settles `<noscript>` copies;
- it drops what the page hides (`pageHides`);
- for a lazy picture, it reads the loader's address (`data-src`,
  `data-lazy-src`, `data-original`, `data-srcset`) before `src`, then the
  largest `srcset` candidate;
- it resolves relative links and unwraps `javascript:` ones;
- it flattens a caption the page boxes in blocks into its words, so the figure
  folds.

The excerpt is untouched: a dek is only ever taken when the page's
description confirms it, and Readability's excerpt was read from that same
metadata.

### The lead on its own

The clip reports the markdown the lead contributed in `ClipPayload.lead`. It
is computed by converting the article with and without the lead, and kept
only when it is an exact prefix. A repair offers exactly that to an article
saved before this (ADR 0053). `ClipOptions.recoverLead: false` clips as before
this ADR, for regression runs.

## Rejected

- **Class names.** `subtitle`, `dek`, `standfirst`, `excerpt` and the rest
  confirm about half the real deks in the corpus and also name a date line
  ("17 August 2026 · cookmeplox"), a blog's tagline ("from Red Blob Games’s
  Blog") and a byline ("Alain Pannetrat, August 24, 2026").
- **The byline in the body.** It is metadata, and the site's meta row already
  shows it; a "By …" paragraph would show it twice and be translated as
  prose. The owner chose this.
- **The whole header.** It brings the rubric, the date, the share buttons and
  the ads with it.
- **The card picture when the page does not show it.** A card is often made
  for social sites alone; only a picture the page sets in its header is
  taken.
- **A marker on every element before Readability**, to find the article's
  start exactly. It would ride into the raw fallback, the essay's snapshot
  and any table Turndown keeps as HTML; the text match fails safe instead.
- **Patching Readability's sibling pass.** That is the scoring every other
  article depends on, and its threshold is right for sidebars.
- **A rule keyed on The Atlantic.** The shape is a class, as the Substack and
  magazine sites show.

## Consequences

- On 297 saved pages, 76 gain a lead: 37 Atlantic and 39 elsewhere. A
  `--baseline main` sweep reports every one as `lead prepended` and nothing
  else changed. Accepted misses: a Sebastian Raschka subtitle and the
  claude.com dek, whose descriptions say something else, Big Think's "key
  takeaways" list, and the 75 pages with no `<h1>` the title confirms.
- A lead picture is usually the article's first image, so the site's
  `leadImage` now finds it. It becomes the article's social card and can
  become a collection's cover.
- The summarizer, which reads the body, now reads the dek too.
- A clip takes one more pass over the page: up to about 0.2 s under
  happy-dom on the largest pages in the corpus.
- Articles saved before this keep their old bodies until repaired (ADR 0053).
