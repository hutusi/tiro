# ADR 0050: A page of pictures clips as its pictures

Status: accepted (2026-10). Changes what the clipper extracts from one page
shape. It touches neither identity nor the document format, so `tiro.schema`
is unchanged.

## Context

Three chapters of John Berger's *Ways of Seeing* were clipped from
ways-of-seeing.com, and each came out as two lines: "Ways of Seeing / John
Berger". Chapters 2, 4 and 6 are the book's wordless picture essays, and the
site serves each as a `<main class="photo-essay">` of photographs (10, 36 and
34) whose only words are the chapter number and a "Next Chapter" link.

**Readability finds an article by its text.** It scores paragraphs by their
length and commas, and an image adds nothing to a score. On a page with no
prose the best-scoring block was the site header, the book's title and
author, so that is what it returned. It returned something, so the clipper's
raw-body fallback (for a Readability that returns nothing) never ran.

The text chapters of the same site clip correctly, with every picture
(38, 27, 39 and 40): there, the pictures sit inside the prose Readability
chooses.

## Decision

**When what Readability chose holds no picture and almost no text, the page's
main landmark is asked instead, and if it holds pictures, they are the
article** (`pictureEssayIn`).

- **The article is the pictures, in the page's order.** Each `<img>`, with its
  address resolved against the page, its `alt` and `title` kept, so a gallery
  that names its pictures keeps the names (chapter 4 names every painting). A
  `<figure>` is taken whole, so its caption comes with it, less any image in
  it that is not a picture (an icon, an address nobody can follow).
- **Every other word in the landmark is left behind**: the chapter number and
  the next link, which is the furniture Readability strips from a text
  article too.
- **The landmark is one the page names**: `<main>`, `role="main"` or
  `<article>`, the one holding the most pictures. Not the whole body, which
  would bring the logo and every icon with it.

It runs after Readability, on the prepared body as it stood before Readability
consumed it, and its result goes through every later pass like Readability's
would: videos, figures, anchors.

### The guards

Overruling Readability wrongly replaces an article with its illustrations, so
every condition is narrow and each has a test that fails without it:

- **Readability's choice holds no picture.** A photo with a one-line caption
  is a choice, however short.
- **It holds fewer than 100 letters.** Letters, not words, since Chinese prose
  has no spaces to count by; a 120-character Chinese article counted by
  whitespace is one word. The header Readability chose on Ways of Seeing has
  22.
- **The landmark is as wordless, captions apart.** Fewer than 100 letters
  outside its `<figcaption>`s; the essay's own words, "2" and "Next Chapter",
  are 11. A landmark with prose in it is an article Readability failed to
  read, not an essay. The sweep found one: under happy-dom, Developers
  Digest's `<article>`, 9,494 letters, lost to the site's nav menu, and
  without this guard the clip kept its four illustrations and none of its
  text. Captions are not counted, so a captioned essay is still an essay.
- **The landmark holds at least 3 pictures.** A page with nothing to read and
  one or two images is an error page or a shell as often as it is content.
  Images are counted, not figures: one plate of three photographs is three.
- **An icon is not a picture**: an image declared smaller than 48 px on a side.
- **A lazy loader's `data-src` comes before `src`.** Below the fold `src` is
  still a placeholder, and not always a `data:` pixel: an ordinary address
  like `/img/blank.gif` is as followable as the picture. Once the picture
  loads the loader copies `data-src` into `src`, so asking `data-src` first
  costs nothing on a loaded one.

## Rejected

- **Lowering Readability's `charThreshold`.** It changes what counts as enough
  text, not what is scored, and a picture still scores nothing.
- **Keeping the landmark's text too.** On this page it is "2" and "Next
  Chapter". A landmark with real text is one Readability would have chosen.
- **The whole body when no landmark is named.** It brings the site's
  furniture, images and all, into the article. An essay laid out without a
  landmark is still lost, as before.
- **A rule keyed on ways-of-seeing.com.** The shape is a class, a gallery with
  no prose, and the rule keys on that shape, as every repair in the clipper
  does.

## Consequences

- A picture essay clips as its pictures. The processor keeps them as images
  like any other, translates their `alt` text with the rest of the article
  (so `zh.md` names the paintings in Chinese), and summarizes from what the
  summary prompt is given: the title and the body, which here is the
  pictures' names.
- An essay whose pictures carry no `alt`, like chapter 2, gives the summarizer
  only its title and a list of image links, so its summary can say little
  more than the title does.
- **A saved link takes the same path** (ADR 0034): the processor clips the
  fetched page with this clipper, and its shell check counts the markdown's
  characters, image addresses included. A page whose raw HTML is a picture
  essay is saved as one. So would be a script-built page whose landmark
  arrives with three pictures and no words, where before it was refused as a
  shell; none is in the corpus.
- Owed: re-clip *Ways of Seeing* chapters 2, 4 and 6.
- In the sweep corpus nothing else changes; see the PR for the run.
