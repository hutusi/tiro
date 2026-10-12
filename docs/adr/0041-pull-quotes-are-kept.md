# ADR 0041: A pull quote is kept, marked as one

Status: accepted (2026-10). Adds a mark to the document format that an older
site reads as a plain blockquote, so `tiro.schema` is unchanged.

## Context

A pull quote is the sentence a magazine repeats in large type between its
paragraphs, to catch a reader turning pages. The Atlantic's "Lola's Story"
has six, and its clip had none.

**Readability is where they go.** The Atlantic writes each one as
`<aside class="ArticlePullquote_root__…" data-flatplan-pullquote="true">`,
and Readability removes every `<aside>` from what it returns
(`_prepArticle`). Other publishers lose them differently:

- A Substack `div.pullquote` holding links is cleaned away as "a little
  linky" (Lenny's Newsletter).
- Literary Hub's `<p class="pullquote">` survives, but as a paragraph that
  reads as the body saying the same thing twice.

**Their words are already in the article.** Of Lola's six, four repeat a
body sentence word for word and two condense a passage. Leaving them out
loses no text, and was the first recommendation. The owner chose to keep
them anyway, as part of how the piece was set.

## Decision

### 1. A pull quote is a blockquote whose first line is a fixed comment

```md
> <!-- pull quote -->
> I had a family, a career, a house in the suburbs—the American dream. And then I had a slave.
```

`PULL_QUOTE_MARK` and `isPullQuoteBlock` live in `@tiro/shared`, since both
the clipper and the site read the shape.

- **One block.** A blockquote is one top-level block, so `zh.md` aligns with
  it like any other. It is translated as prose, and a translation that drops
  the `>` changes the block's type and reverts that one block (ADR 0038).
- **Invisible elsewhere.** A Markdown viewer shows nothing for a comment, and
  an older site renders the quote as a plain blockquote.
- **No false positives.** Turndown never writes a comment from page content,
  so a real quotation cannot carry the mark.
- **On a line of its own.** A line opening with `<!--` is an HTML block that
  swallows any text after it on that line.

### 2. The clipper re-tags a pull quote before Readability

`markPullQuotes` runs in `prepareForClipping`, after
`joinSplitArticleBodies` (see below). It looks for an `aside`, `div`, `p` or
`blockquote` that the page calls a pull quote: The Atlantic's
`data-flatplan-pullquote`, or a `pullquote` / `pull-quote` class. Each one is
re-tagged as a `<blockquote>` carrying `data-tiro-pullquote`.

- **Why a blockquote.** No Readability cleaning pass removes one, and it is
  not a tag Readability scores, so it picks the same container. A `<div>`
  loses its attributes when Readability turns it into a paragraph, and a `<p>`
  comes out as prose.
- **Every attribute is carried over**, so a hidden pull quote stays hidden,
  and the class weighs on the container exactly as before. Only the tag
  changes, which keeps a pass before extraction as small as it goes (ADR
  0011).
- **Found again by the marker, not the tag.** A quote that sits beside the
  container Readability picks comes back renamed to `<div>`. So the Turndown
  rule fires on the marker, the way a script-drawn figure is found after
  extraction (ADR 0039). A marker the page wrote itself is cleared first.
- **After the join.** `joinSplitArticleBodies` refuses to close up over a
  blockquote but not over an aside, so marking first would leave in halves a
  split body it joins today.
- **Text only.** An element holding a picture, figure, list, table, code
  block or heading is not a pull quote, whatever its class says. Substack's
  pull-quote block is a container an author can fill with anything: Brad
  Montague's "Enjoy every sandwich" puts a dialogue, a captioned picture and
  three more paragraphs in one. That is the article, not a line repeated
  from it.
- **The outermost wins.** When a page marks a quote and its wrapper, only one
  quote is written.

### 3. The site sets it as an aside, and the original decides

A pass after rehype-sanitize renames the blockquote to
`<aside class="pull-quote">`, the element HTML has for a pull quote. The
stylesheet sets it upright and larger, between two hairlines, with no quote
marks and no rail. The class is granted after the sanitizer for the reason
the video badge is (ADR 0040, ADR 0009): the schema allows a class on
nothing, so clipped markup cannot claim it.

- **Decided before rendering.** The mark is a comment and the sanitizer
  removes comments, so `renderBlock` asks `isPullQuoteBlock` of the block's
  text and hands the answer to the pass.
- **The original decides for both panes.** In paired rows the reader asks the
  original block and passes the answer to the translation. The translator is
  handed the mark with the rest of the quote and may drop or translate it. A
  row styled one way on the left and another on the right would be worse
  than either, and a mark a translation invents makes nothing a pull quote.
- **Search still reads it.** A magazine's pull quote repeats the body, but a
  Substack author's need not. A word left out of the index is a page that
  cannot be found by it, while a repeated one costs nothing when results are
  pages.

## Rejected

- **Raw `<aside>` in the Markdown.** The sanitizer strips the tag, the
  processor copies an HTML block into `zh.md` untranslated, and the form with
  blank lines splits into three blocks and two empty reader rows (ADR 0011
  rejected raw `<figure>` for the same opacity).
- **An emphasis marker**, such as a quote set in bold. The translator can
  drop it silently (ADR 0011), and a quotation an author bolded would read as
  a pull quote.
- **A rule keyed on theatlantic.com.** It would miss every other publisher
  that marks its pull quotes the same way. The rules key on markup, as every
  repair in the clipper does.
- **Recognising a pull quote by its repeated words.** Two of Lola's six are
  condensed, not copied, so the test would have to be fuzzy, and it would also
  fire on an article that quotes someone and then repeats the quote.

## Consequences

- An article with pull quotes gains one block for each, where it stood.
  Re-clip to pick this up. Owed: "Lola's Story". The sweep cannot check The
  Atlantic, which refuses its fetches; Lola was checked offline from an
  archived copy and gains exactly its six, every other block byte-identical.
- In the sweep corpus two articles change. Lenny's Newsletter regains its
  "Listen on YouTube, Spotify, and Apple Podcasts" pull quote, and Literary
  Hub's two duplicate paragraphs become pull quotes.
- An `<aside>` that a page marks `role="complementary"` is still removed
  before Readability scores, since the role is carried over with the rest.
  None has been seen on a pull quote.
