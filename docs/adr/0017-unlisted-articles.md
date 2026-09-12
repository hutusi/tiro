# ADR 0017: Unlisted articles — enumeration is the thing being removed

Status: accepted (2026-09). Does not reverse the "the site is fully public"
decision recorded in ADR 0002's consequences; it narrows what the site
*advertises*, not who may read it.

## Context

The site publishes every article the vault holds. Some are worth keeping and
reading but not worth putting in front of whoever opens the site: a page clipped
for one conversation, a draft translation, something whose source is public but
whose presence in a personal library says more than intended.

The two levers that existed both take the URL away. Deleting the article removes
it outright. Moving its directory out of `articles/` hides it from the site and
the processor at once — the glob loader reads `*/index.md` under
`<vault>/articles` (ADR 0006) and the vault workflow's push filter is
`articles/**` — which is the right answer for "don't publish this at all", and
the wrong one for "publish it, just don't list it".

What is wanted is narrower: the article stays clipped, processed, translated and
built, and stays reachable at its own URL, but leaves the library, the pager, the
tag and category pages, the search index, the RSS feed and the sitemap.

**This is obscurity, not access control, and the difference matters here more
than usual.** The site has no auth tier by design, and slugs are deterministic
from the URL (ADR 0007): normalized URL → path slug + 8-hex SHA-256. Anyone who
knows the source URL can compute the address, and the slug spells out the domain
and path besides. An unlisted article is hidden from anyone browsing the site,
not from anyone looking for it. Privacy would mean an auth layer in front of
Cloudflare Pages — an Access rule or a Worker gate — which is a different
decision about a different thing.

## Decision

- **`unlisted`**, an optional boolean, top-level on `ArticleFrontmatterSchema`.
  `tiro.schema` stays 1 — optional and additive, the `has_math` /
  `clipper_version` / `title_zh` precedent. An article without the key means
  exactly what it meant before the key existed.

  Read strictly as `=== true`, never truthiness, for the same reason.

- **Set by hand in the vault; carried forward by everything that rewrites the
  article.** Nothing originates the flag. It must still be named on both
  schemas, because zod strips keys an object does not name: the processor
  reparses and rewrites frontmatter on every run, and a re-clip rebuilds
  `index.md` from scratch. The processor's `...previous` spread keeps it; the
  clipper reads it off the article it is about to overwrite, in the GET that
  already fetches the blob sha — so no extra request for any article the
  Contents API will inline, which is all of them under 1MB.

  That read is deliberately lenient and deliberately unwilling to guess. The
  frontmatter is parsed *without* contract validation (`readFrontmatterLoose`),
  because the flag is hand-set and the same hand can leave a neighbouring field
  invalid — a strict read would hear "this article does not validate" as "this
  article is not hidden". Where the Contents API omits the body, which it does
  above 1MB, the blob is fetched instead of assumed.

  What it will not do is guess. Frontmatter it cannot parse — a truncated file,
  a typo one line above the flag — stops the clip rather than answering
  "listed", and so does a failed blob read, and so does an `unlisted` value
  that is not a boolean. That last one (`unlisted: "true"`, or the YAML 1.2
  reading of `unlisted: yes`) the contract rejects outright, so the site cannot
  build while it is there; the danger is not that it publishes but that a clip
  silently *repairs* it by dropping the key, turning a loud failure the owner
  would investigate into a quiet republish of what they meant to hide. `readFrontmatterLoose` reports three
  states for that reason, not two: a file with no frontmatter is *knowledge*
  that no flag is there, while a block that will not parse is ignorance. A
  stale-sha conflict redoes the lookup and rebuilds the payload rather than
  re-sending bytes built against a file that has since changed — that window is
  seconds wide, and it is the window in which someone hides an article by hand.
  The asymmetry is the whole argument: a wrong "no" republishes something
  someone hid, a wrong "yes" costs a line in a file being rewritten.

- **A per-article flag, not a list of slugs in `config/tiro.yml`.** The flag
  travels with the article and is visible in the file where the decision is
  made. A config list would also mean new plumbing: the site reads no vault
  config at all today.

- **One funnel does the work.** `getArticles()` is what the library, the pager,
  the tag and category pages, the search page's chip counts and the RSS feed all
  read, so it returns listed articles only and the flag takes effect in all of
  them at once. The reader route reads a new `getAllArticles()`, because being
  reachable at its URL is the whole point.

  The empty-collection guard stays on the *unfiltered* count: "no articles at
  all" means a broken vault checkout or glob base (ADR 0006). A vault whose
  articles are *all* unlisted still builds, and renders an empty library.

  Refusing that build is the tempting alternative — it is almost certainly not
  a site anyone wanted — and it is wrong, because the deploy workflow builds
  before it uploads. A refusal leaves the *previous* deployment live: the one
  where the article now being hidden is still listed. A feature whose job is to
  stop publishing something must not answer "I could not do that" by carrying on
  publishing it. This shipped as a guard first and was reversed for exactly that
  reason.

- **Out of the search index by dropping `data-pagefind-body` and ignoring the
  whole page.** Both, not either, and the second one has to be on `<body>`:
  Pagefind restricts indexing to `data-pagefind-body` elements only while at
  least one page on the site has one, so in a vault where every article is
  unlisted it falls back to indexing each page's entire `<body>`. Ignoring only
  the reader's `<article>` removed the text and left the page — URL and title
  included — in the index, which is most of what the flag is for. Measured, not
  reasoned: a vault holding one unlisted article indexed 6 pages with a fragment
  naming the hidden URL, and 5 with none once the ignore covered the page.

  The declaration that keeps that rule in force when no article supplies one is
  the library's **empty state** — the paragraph that renders only when nothing
  is listed. It is the one page in such a vault that can carry a
  `data-pagefind-body` without putting a non-article in the index, and it gives
  Pagefind something to index, which it requires: handed an empty index it exits
  non-zero and fails the build. That vault indexes exactly one page, the empty
  state's own line; a normal vault emits no such element and is untouched.

- **Terms are shown, not linked, when they have no page.** Tag and category
  routes are generated from the listed articles, so a term carried only by
  unlisted ones addresses nothing, and the reader linked to it anyway.
  Generating those pages from unlisted articles instead would publish an index
  page for an article that is meant to be in no index.

- **Out of the sitemap, and `noindex, nofollow` on the page.** The sitemap
  filter cannot ask the content layer — `astro.config.mjs` is evaluated before it
  exists and `filter` is synchronous — so it reads the vault's `index.md` files
  itself, through the shared `parseArticle`, keeping one definition of
  "unlisted". It matches a whole path segment: a slug is also a publisher's own
  path, and a substring test would drop innocent pages and keep `<slug>-2`.

- **`robots.txt` says nothing.** It is a public file, so a `Disallow` line there
  would publish exactly the list being hidden.

- **The reader says so on the page.** The article's own page is the only place
  the state can be seen, so the label spells out what it means rather than naming
  it.

## Consequences

- **A re-clip keeps the flag** — which is why `findExistingIndex` now reads the
  old article's content rather than only its sha, and why the clip flow looks up
  the existing file before building the new one. The first cut dropped it, on
  the argument that a re-clip already drops `title_zh` and `summary_orig`; that
  argument is wrong. Those describe content that just changed, so regenerating
  them is the point. This describes a decision about the article, which the
  clip did not revisit — and the failure was silent, which is how a hidden
  article ends up in the library without anyone doing anything.
- **Hiding the last listed article publishes an empty library**, and the search
  page then returns only that page's own empty-state line. Odd-looking, and the
  honest rendering of that vault — and it deploys, which is the part that
  matters: the article the owner hid stops being listed.
- **A re-clip can now fail** where it used to succeed: an article whose
  frontmatter no longer parses, or one too large to inline whose blob cannot be
  fetched. Both mean the vault holds something this cannot read, which fails the
  site build too, so the article needs a hand either way.
- **The assets stay publicly fetchable.** `copy-assets.ts` copies `*/assets/*`
  for every article off the filesystem with no frontmatter check, and has to —
  the unlisted page's own images come from there. Their paths are as guessable as
  the article's.
- **Two readers of the contract now run per build**: the glob loader and the
  sitemap filter, which re-reads every `index.md` for one key. Trivial at vault
  scale, and it fails loudly with the file path on an unparseable article, which
  the build would have failed on anyway a moment later.
- **Hiding an article is a vault push that commits nothing**, so the vault
  workflow's deploy dispatch — gated on a commit landing — does not fire. The
  deploy must be dispatched by hand, exactly as for a deletion. See
  [operations](../operations.md).
- An unlisted article's tags and category render as plain text whenever no
  listed article shares them — the terms are still recorded, and start linking
  again the moment something listed carries one. A reader can tell the two
  states apart only by hovering, which is the smaller wrong than a 404.
- Nothing in the extension or the processor changes. An unlisted article is
  summarized and translated like any other: `validate` and `sweep` are
  field-agnostic, and the pipeline's `...previous` spread carries the flag
  through. Both round-trips are now covered by tests, because the failure mode is
  silent.

## Rejected

- **A slug list in the vault's `config/tiro.yml`.** Its one argument was that a
  re-clip could not clobber it; the clipper carrying the flag forward answers
  that without the costs — nothing in the article saying it is hidden, slugs
  hand-typed and unchecked, and the site having to start reading vault config to
  serve one boolean.
- **`Disallow: /articles/<slug>/` in `robots.txt`.** Publishes the list.
- **Moving the directory out of `articles/`.** Still the right answer for "don't
  publish this at all" — and it remains available — but it removes the URL, which
  is the thing being asked for here.
- **An auth layer (Cloudflare Access, a Worker gate).** The actual answer for
  privacy, and a much larger decision: it reverses the fully-public premise the
  site is built on, and every sanitization and design choice that followed from
  it. If a genuinely private article is ever needed, that is its own ADR — not a
  quiet extension of this flag, which is what "unlisted" would otherwise drift
  into meaning.
- **Bumping `tiro.schema`.** ADR 0002's rule is for breaking changes. Every
  existing article validates unchanged, and an absent flag is the old behavior.
