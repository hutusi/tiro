# ADR 0042: An article's title is the headline its page displays

Status: accepted (2026-10). Changes which value fills `title`, not its shape,
so `tiro.schema` is unchanged.

## Context

The owner noticed that Atlantic articles were filed under titles their pages
never show. "The Puzzling Gap Between How Old You Are and How Old You Think
You Are" was saved as "I'm 53 years old. I'm 36 in my head."

**The Atlantic writes two headlines.** A search headline goes in `<title>` and
the JSON-LD `headline`. The headline readers see goes in the `<h1>`,
`og:title` and JSON-LD `alternativeHeadline`. The clipper took its title from
Readability, and Readability reads JSON-LD before any `<meta>`, so it always
took the search headline.

**Measured live in Chrome**, since The Atlantic refuses non-browser fetches:

- 44 of the vault's 97 Atlantic articles had a title that differed from their
  page's `<h1>`, and all 44 came from the JSON-LD `headline`.
- One more, "I'm Being Followed: How Google—and 104 Other Companies—Are
  Tracking Me on the Web", had U+0097 where each dash should be. Its JSON-LD
  writes `&#151;`. A browser decodes that as an em dash, using the HTML5
  Windows-1252 remap, but Readability decodes it with `fromCharCode`.
- The excerpt was not affected: description, `og:description` and the visible
  dek agree on every page checked.

No single source is right on its own:

- **`og:title` alone** is right for 40 of the 44. For "Masters of Love",
  `og:title` is the search headline too. Elsewhere it carries "| Site".
- **The `<h1>` alone** fails wherever a page uses its `<h1>` for the logo or
  the section name.

## Decision

**The title is an `<h1>` that the page's own metadata confirms is its
headline.** Readability's title stands when nothing confirms one.

`readTitleEvidence` (`packages/clip/src/title.ts`) reads two things before
Readability, which removes the `<h1>` with the rest of the page around the
article:

- **Headlines:** every non-empty `<h1>` the page shows, read as it displays.
  A `<br>` counts as a space. An `<h1>` is skipped when it or an ancestor is
  hidden by any means a detached DOM can read (`pageHides`):
  - `hidden`
  - `aria-hidden`
  - inline `display: none` or `visibility: hidden`
  - a hiding class such as `sr-only`

  Hidden parts inside an `<h1>` are not read either. A hidden `<h1>` can be
  named by the page's metadata too, as with a sticky header's copy, and if it
  came first it would win. A hidden icon has no letters to fail the word match,
  so it would lead the title.
- **Claims:** `og:title`, `twitter:title`, and the `headline`, `name` and
  `alternativeHeadline` of every JSON-LD node typed as an article. The node can
  be in an array or a `@graph`.

`chooseTitle` then decides:

1. **Readability's title is kept** when its words match some `<h1>`, unless it
   contains a C1 control character.
2. **Otherwise the first `<h1>` whose words match a claim wins.** Readability's
   own title counts as a claim here.
3. **Otherwise Readability's title stands.**

Three details matter:

- **Words** means NFKC, case-folded, letters and digits only. "Don't" and
  "Don’t" are one headline.
- **The output is the `<h1>`'s text, never a claim's.** JSON-LD strings arrive
  with their markup escaped, sometimes twice (`&amp;lt;em&amp;gt;Don’t Write
  With AI…`). They are decoded and stripped for comparison only.
- **Only article types count.** A `WebSite` or `Organization` node is named
  after the publisher. Letting its `name` count would confirm a logo `<h1>`.

## Alternatives considered

- **Rank `og:title` above JSON-LD.** This fixes 40 of 44. It leaves "Masters
  of Love" and three like it, and adds "| Site" suffixes elsewhere.
- **Always take the `<h1>`.** This fixes all 44 and files every article whose
  `<h1>` is a masthead under the masthead.
- **A rule for The Atlantic's host.** The same shape appears on IEEE Spectrum,
  and the agreement rule needs no host. ADR 0013 keeps host rules for identity.
- **Take the `<h1>`'s text whenever its words match.** This would rewrite six
  corpus titles that differ only in quote curl or case. That churn has no
  reader-visible gain, so a matching title is kept as written. A C1 character
  is the one exception, because there the `<h1>` is the same words spelled
  correctly.

## Consequences

- **The sweep corpus changes 10 titles and no bodies** (`sweep --baseline
  main`):
  - Eight lose a site-name suffix: Zed ×3, Sandi Metz, Eva Parish, Fortune,
    Kuleshov Group and Stephanie Stimac.
  - Haskell Discourse loses its category trail.
  - IEEE Spectrum's search headline becomes the displayed one.
  
  The sweep now reports titles at all. Before this, every number it compared
  was read from the body, so this change would have swept clean.
- **The sweep cannot check The Atlantic**, which refuses its fetches. The
  rule was checked offline on four archived Atlantic pages instead: subjective
  age, "Masters of Love", "I'm Being Followed" and the rehab-engineering
  feature. Each got its `<h1>`.
- **Existing articles are retitled in place, not re-clipped.** That covers the
  45 Atlantic articles and the 10 above. Each gets a new `title:` and then
  `backfill-titles --force` for its `title_zh`. Bodies, summaries, tags and
  `processed_at` are untouched, so nothing is reprocessed. Re-clipping would
  have re-rolled 55 summaries to change one line each.
- **A page whose search and display headlines both differ from its metadata
  keeps Readability's title.** That happens when nothing confirms the `<h1>`.
  A page with no `<h1>` keeps it too: three old Atlantic pages from
  `/past/docs/` and `/ideastour/`, and 23 in the sweep corpus.
