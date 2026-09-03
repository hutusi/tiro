# Changelog

Notable, release-worthy changes to Tiro. The fine-grained history lives in
the git log (Conventional Commits with reasoning in the bodies); this file
records milestones. Format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow the `0.x` line while Tiro is a personal system.

## [Unreleased]

### Added

- **Code blocks are syntax-highlighted.** Shiki has been wired in since ADR
  0009, but every one of the vault's 40 fences was bare, so every block rendered
  as plain text — and re-clipping could not have fixed most of them, because the
  pages they came from pre-highlight with Shiki themselves and state no language
  anywhere in their markup. A fence's language now comes from the first of four
  sources that answers: markup the page wrote, chrome the page wrote for a human
  (a tab reading `Python`, a header naming `src/main.rs`), inference from the
  code text at build time, or nothing. Inference stays at render time because a
  guess written into the vault is permanent while a guess made at build time
  costs one build — which matters here because roughly 16 of those 40 blocks are
  English prose an author fenced for display, so the expensive failure is a
  paragraph painted as Ruby, not a block left plain. Built against the live
  vault, the site goes from 0 coloured tokens to 2686. See ADR 0012.
- **`sweep --fill-languages`** backfills fence languages onto clips taken before
  the language chain existed, rewriting `index.md` and `zh.md` in lockstep so
  block alignment survives. Reports by default; `--write` applies. A fence whose
  declared language disagrees with what the code reads as is left bare and
  reported rather than written — pages do get this wrong, and the first real run
  found `claude.com/blog` mislabelling 4 of its own 13 blocks.

- **Articles record which clipper *build* wrote them**, not only which release.
  `tiro.clipper_version` comes from the manifest, so it names a release — but
  the extension is normally run by loading `dist/` unpacked, built from
  whatever is checked out. Every clip taken across the seven commits of one
  branch reported the same `0.11.0`, and that version batched four separate
  fixes, so it could not answer the question it exists for: which clips predate
  a given fix. `tiro.clipper_commit` records `git describe` output
  (`ext-v0.11.0-8-gbe3dcc8`), injected at build time, and
  `git merge-base --is-ancestor` answers it exactly.

  A `-dirty` suffix marks a build from a modified tree — the common case for an
  unpacked build — because recording the bare commit would claim a cleanliness
  the build does not have. The field is omitted entirely when the build had no
  git to ask, so "unknown" and "empty" stay distinguishable, and a failing
  `git` can never fail the build. Optional and additive, so no `tiro.schema`
  bump, and no version bump: what a page clips to is unchanged.

<!-- Headings here are *repo* versions, matching the `v*` tags; the extension
     ships on its own `ext-v*` line and its number lives only in
     apps/extension/manifest.json. Extension work is recorded under the repo
     release that carries it — 0.10.0's figure captions are under [0.3.0]. -->

### Fixed

- **A page cannot forge the clipper's own markers.** `data-tiro-math` and
  `data-tiro-lang` are private contracts between `dom-prepare` and a Turndown
  rule, and the rule fires on the attribute alone — so a page that wrote one
  itself was obeyed. `<span data-tiro-math="display">` split the paragraph it
  sat in into three blocks and set `has_math`, which turns every price on the
  page into a formula; the language marker had the same shape, where backticks
  in a forged value opened a fence markdown cannot close. Both markers are now
  cleared across the document before either pass writes its own. The math half
  predates the language half by two releases and was found while fixing it.

- **Fence languages survive extraction, so code is highlighted again.** Every
  one of the vault's 50 fenced blocks is bare, across articles clipped with
  0.7.0 through 0.11.0, and the site renders all of them grey. Readability's
  `_cleanClasses` strips `class` from every element it returns, and Turndown
  reads a fence's language *only* from `language-*` on the `<code>` — so the
  language the clipper works out is erased between the two. The whole of the
  clipper's language handling, and the ten tests covering it, has been dead on
  the shipping path since it was written: those tests go straight from
  `prepareForClipping` to `htmlToMarkdown` and never run Readability, which is
  the one step that erases the answer.

  The language now crosses on a `data-tiro-lang` attribute — `data-*` survives
  Readability untouched — and becomes a class again once extraction is out of
  the way. That is the contract `data-tiro-math` already established for
  recovered formulas, generalised: **anything computed before Readability has to
  ride a `data-*` attribute to get past it.** Restoring the class rather than
  teaching Turndown to read the marker is deliberate — Turndown's own rule
  already widens a fence when the code contains backticks, and a rule of ours
  would have to carry a copy of that arithmetic forever.

  The marker is taken from the *finished* class, not from the recovery branch
  that computes it, so a page that already marks its code up correctly — the
  common case, and the one the recovery branch returns early for — is covered by
  the same rule.

  Measured across the cached source pages: the only thing that changes anywhere
  is fence info strings. Already-clipped articles keep their bare fences until
  they are re-clipped; the language is not in the markdown, so nothing can
  repair it after the fact.

- **Code blocks no longer vanish because of the page's CSS class names.** The
  same accident as the gallery below, arriving through a different word.
  Readability's negative-weight regex is a *substring* test over the class
  attribute, and Tailwind's compound utilities collide with it by chance:
  `overflow-hidden` and `outline-hidden` contain `hidden`, `code-block-scroll`
  contains `scroll`. `_cleanConditionally` deletes an element outright once
  `weight + contentScore < 0`, and its `contentScore` is hardcoded to 0, so one
  such class deleted the whole subtree before anything looked at what it held.
  One clipped article lost **all 15** of its code blocks and published as prose
  with the examples simply missing from between the paragraphs — a page reading
  as if its author had described every sample without ever showing one.
  The clipper now clears just those class tokens from the containers around a
  code block, widening out one container at a time until it reaches one that
  carries something besides the code. A token is cleared only when Readability
  docks it, it does not actually hide the element, and removing the two
  colliding words leaves nothing Readability still objects to — so
  `overflow-hidden` goes while `promo-hidden` and `sidebar-scroll` stay. Whether
  a token really hides is read rather than guessed: `data-[state=inactive]:hidden`
  counts only on an element that carries `data-state="inactive"`, quoted or not,
  while `md:`, `dark:` and `hover:` name states there is no viewport, theme or
  pointer here to evaluate, and **unanswerable counts as hidden**.

  Nothing else about the page changes, and that is the design. The first version
  of this fix, released as extension 0.11.1, *unwrapped* those containers —
  which discards the element, and with it every attribute and class Readability
  judges on, so the clipper had to re-derive its rules: an attribute allow-list,
  a copy of its unlikely-role list, a copy of the negative regex minus two
  tokens, a byline check. Seven defects were found in that apparatus over five
  review rounds, and the last of them was invisible to every offline test —
  React adds `aria-labelledby` to a tabbed code panel on hydration, the
  allow-list refused it, and the block was lost in a way only a clip taken in a
  real browser could show. Clearing two proven-false tokens needs none of that
  permission: the element stays, so Readability keeps making every judgement.
  The pass is 114 lines shorter for it.

  Byte-identical across all 35 cached source pages, which is the whole of what
  the corpus can say: no vault page carries this shape, so the guards above are
  argued from the markup and pinned by tests rather than by the sweep.

- **Images no longer vanish because of the page's CSS class names.** Readability
  scores an element by its class before it looks at what the element holds, and
  its "this is furniture" regex contains `media` — so a gallery wrapped in a
  CSS-module class like `MediaGalleryView-module__…__media-gallery` was deleted
  whole, at a weight of -25, before any of the checks written to protect images
  was reached. One clipped article published without the three photographs it is
  partly about; another lost all seven of its images and nobody had noticed.
  The clipper now unwraps a layout `<div>` that holds nothing but media and sits
  in markup the page itself calls a figure — the same remedy `TABLE-DROP` needed
  in 0.9.0, and for the same underlying reason.

  Unwrapping rather than just clearing the class, because the wrapper cost a
  second thing: Readability rewrites a phrasing-only `<div>` into a `<p>`, and a
  figure holding `<p><img></p>` does not fold its caption (0.10.0). Removing the
  wrapper fixes both. Only a wrapper carrying *nothing but layout* is unwrapped
  — `class`, `style`, `data-*` and no more. Unwrapping discards the element's
  attributes, and Readability reads several verdicts from them before it scores
  anything: `hidden`, furniture (`class="sidebar"`, `role="complementary"`), and
  a byline (`rel="author"`, `itemprop`, `class="byline"`). Asking "is there
  anything here that could mean something?" rather than mirroring each rule is
  what makes a rule nobody has read yet impossible to miss. What remains is the
  class, and there exactly one token — `media` — is treated as a false positive.
  Every other reason Readability has to reject a class still stands, including
  the rest of the negative-weight regex: `promo`, `widget`, `contact` and their
  kind name things a reader did not ask for, and `class="hidden"` is how
  Tailwind spells `display: none`, caught only there.

- **An inline chart no longer arrives as a run of glyphs.** Turndown has no
  rendering for `<svg>`, so it emitted every text node inside one in document
  order with no separators, and a chart's axis ticks, series names and values
  landed as a single unreadable paragraph — which the site rendered as body text
  and the translator dutifully translated. An `<svg>` painting a chart's worth
  of labels is now dropped. The chart itself is lost either way, markdown having
  no element for it; what changes is that the reader gets the real caption
  beside it instead of the debris. A single painted label is left alone, and so
  is any `<svg>` inside a link, whose text is the link's only label — measured
  against the seven real charts that prompted this, which carry 17 to 31 labels
  each.

  Measured across all 34 vault articles by clipping every source page with both
  versions: 30 come out byte-identical, and the four that change lose nothing —
  12 images and 8 captions gained, 3 glyph-soup paragraphs removed.

## [0.3.0] - 2026-09-02

### Added

- **A figure's caption stays attached to its figure.** The clipper folds a
  `<figure>`'s caption into the same paragraph as its image — after Readability
  has chosen the article, since it selects on the attributes folding replaces —
  and the site
  renders any paragraph that opens with an image and continues with prose as a
  real `<figure>`/`<figcaption>`. Twelve of the vault's 32 articles carry
  figures; until now every one of them published as a bare image followed by a
  loose paragraph, so a caption was typographically indistinguishable from the
  article's next sentence — on one academic post a credit line read as the
  author's own prose.

  This is the second attempt. The first emitted a real `<figure>` from the
  clipper, which meant emitting raw HTML, and raw HTML is opaque to the
  pipeline: math recovery, dollar escaping, link handling and translator
  masking all had to be rebuilt by hand inside the block, and four independent
  paths got it wrong. The reason this one is different is that it never
  invents a block type. Markdown cannot express a caption's association with
  its image, but it *can* express co-location, so the association is simply
  that the two share a paragraph. The block stays one block, alignment and
  translation are untouched, the caption is translated as ordinary prose, and
  the association cannot desync from the content because it is the content's
  shape (ADR 0011).

  Measured before it was designed: of 116 paragraphs sitting directly after an
  image in the vault, only 13 carry a `Figure N:` style label, and length
  separates nothing — so no site-side heuristic could have recovered what the
  markdown had thrown away.

- **Articles record the clipper that wrote them** — `tiro.clipper_version`,
  alongside the existing `tiro.processor_version`. Optional, so articles clipped
  before it simply lack it and the document format is unchanged. It answers
  per-article what previously took comparing `clipped_at` against the
  extension's git history: which clip predates a given clipper fix, and so needs
  re-clipping.
- **`tiro-process repair`** rewrites clip-time markdown defects already in the
  vault — a code fix only ever helps the next clip. It edits `index.md` and
  `zh.md` together or not at all — staged writes then renames, so a failure
  partway leaves both files as they were — checking 1:1 block alignment before writing
  and reporting the pair untouched when a repair would break it (invariant 4).
  A refusal means the two sides were not damaged identically, which no
  symmetric edit can fix: re-clip the page instead. Two of its repairs have no
  clipper counterpart, so a re-clip reproduces what they fix. Pages that
  separate paragraphs with `<br><br>` make Readability rebuild the blocks
  itself, and it cuts through the middle of a footnote label, so every note
  published as a stray bracket above its own text — that happens inside
  Readability, before the clipper's markdown exists. The heading permalinks are
  the other: nothing in the clipper removes them yet.

### Changed

- **A finished article keeps its translation checkpoint**, so a re-clip pays
  only for the blocks whose source text actually changed. ADR 0008 always
  claimed this — "a re-clip that edits one paragraph keeps every other block's
  translation" — but the file was deleted by the very run that marked the
  article processed, so it was always gone before any re-clip could use it. The
  measured cost of the gap was a 164 KB paper spending ~59 minutes across two
  workflow runs re-translating work it had already paid for. The checkpoint is
  pruned to the blocks the article still contains, and a misaligned translation
  still discards it so a broken result is never resumed. `--force` continues to
  reuse it, as ADR 0008 decided: the content-addressed key means a reuse is only
  ever the same input translated by the same model, so re-billing for identical
  output is waste. ADR 0010 supersedes the one decision in ADR 0008 this
  reverses.

### Fixed

- **Images inside `<picture>` are no longer published as code.** Turndown has no
  `<picture>` rule and does not treat it as a block, so it re-attached the
  whitespace flanking the element's content around the converted image. On a page
  that pretty-prints its markup that whitespace is a newline and an indent, which
  put the image four spaces into its line — an indented code block. The site
  rendered the literal `![](…)` in a syntax-highlighted box, so one article's
  five images, the entire subject of the piece, published as five boxes of
  markup. Fixed in `dom-prepare`, not Turndown: the whitespace is added outside a
  rule's return value, so trimming inside the replacement is a no-op. Unwrapping
  before Readability also changes what its scorer sees, and a DIY article now
  keeps 16 images instead of 10.
- **arXiv data tables survive the clip.** Readability deletes an element whose
  class matches a boilerplate regex before any scoring happens, and that regex
  contains `header` — so LaTeXML's `ltx_guessed_headers`, which marks a table
  whose header row it inferred, took the whole table with it. One paper
  published three captions promising tables that were not there, with nine
  cross-references pointing at nothing. Dropping that one class pre-Readability
  recovers all five of its data tables. `ltx_pagination` also matches the
  regex and is deliberately left alone: those are page-break markers and
  Readability is right to drop them.
- **Images whose URL carries a query string download again.** A `src` in raw
  HTML must spell `&` as `&amp;` to be valid, and the image stage fetched that
  literally — a different URL, which the CDN answers wrongly or not at all, so
  the image was hotlinked for no reason. Decoding is scoped to the HTML
  pattern; a markdown URL is under no such obligation, and decoding one would
  rewrite what the author wrote.
- **Headings no longer end in a stray `#`.** Generators append a self-link to
  every heading as the hover affordance that reveals its anchor; it is invisible
  until hover on the source page and survives conversion as `[#](…)`. Repaired in
  the vault by `tiro-process repair`, which also gained the ability to reach
  indented images: that repair cannot run inside the verbatim masking, because
  the block it fixes *is* a code block, so it runs as a parser-driven pre-pass
  over the whole body.
- **The clipper no longer writes markdown that cannot be parsed.** Four Turndown
  defects, all of them visible on the published site. A link title containing
  newlines — arXiv writes a whole section path into one — left the link
  unterminated, and the lines it swallowed arrived as prose; one of them a lone
  `=`, which markdown reads as a setext heading, so a paragraph published as a
  giant `<h1>`. A link wrapping a block element got that element's blank lines
  inside its brackets, so every captioned Substack image published as a literal
  `[`, an image, and a bare CDN URL. A table with no `<thead>` gained a
  synthesized empty header row, with its real headings still rendered as data.
  And LaTeXML's own list-item labels survived beside the marker the list already
  supplied, so arXiv enumerations published as numbered lists of bare numbers.
- **The two reader columns no longer paint on top of each other.** Each pane is
  a `minmax(0, 1fr)` grid track with `overflow: visible`, so anything wider than
  the column neither scrolled nor clipped — it crossed the gap and overprinted
  the other column's text. Nothing in the site broke a long token: there was no
  `overflow-wrap`, `word-break` or `hyphens` rule anywhere, and clipped articles
  are full of CDN image URLs and arXiv anchors with nothing to break at. Wide
  tables had the same defect from the other direction — typography guards `pre`
  with `overflow-x: auto` but leaves tables unguarded — and now scroll inside
  their own box, wrapped after the sanitize step so the allowlist stays narrow
  (ADR 0009). `min-w-0` on the panes fixes the mirror-image symptom in
  single-pane mode, where the track is `minmax(auto, 1fr)` and one long URL gave
  the whole page a horizontal scrollbar instead.
- **Headings read as headings again.** Rendering each block into its own `.prose`
  root makes every block both `:first-child` and `:last-child`, so typography
  zeroes its margins and `space-y-6` spaces every row identically; only h2 and h3
  got their spacing restored. Row spacing is now graded across all six levels,
  and h5/h6 — which typography does not style at all — are given size and weight.
  arXiv papers put "Abstract", "Theorem" and "Proof." at h6, so most of a paper's
  structure was rendering as plain paragraphs.

## [0.2.0] - 2026-09-01

### Added

- **Syntax highlighting and LaTeX rendering.** Code blocks are highlighted with
  Shiki and formulas typeset with KaTeX, both at build time — no client-side
  JavaScript. Both run *after* rehype-sanitize, as trusted generators over
  already-scrubbed text, so the sanitize allowlist stays as narrow as it was
  rather than widening to admit the classes and inline styles they emit — which
  would have admitted them from clipped markup too, on a fully public site
  (ADR 0009).
- **The clipper now captures math instead of destroying it.** It recovers each
  formula's LaTeX source before Readability runs — KaTeX and MathJax
  annotations, arXiv's `<math alttext>`, MathJax v2 script tags — and deletes
  the rendered duplicate. This is the upstream half of the arXiv failure below:
  no amount of downstream repair can typeset math the clipper already flattened
  into glyphs.
- **Fences arrive with their language.** Turndown reads a fence's language only
  from a `language-*` class, so GitHub, Rouge, Pandoc, SyntaxHighlighter and
  `data-lang` markup all clipped as bare fences. Those are normalized at clip
  time, line-number gutters are dropped, and Chroma's line-number table is
  unwrapped to its code block.
- **Inline `$…$` is read as math only where the dollars are curated.** The
  clipper escapes every literal `$` in the prose of an article it recovered
  maths from, and records `has_math` to say so — so an article that is both a
  maths article and a pricing article renders both correctly. `$$…$$` is
  unambiguous and renders everywhere, including for articles clipped before
  this existed.
- **Malformed maths degrades instead of destroying the page.** An unclosed
  `$$` runs to the end of the document the way an unterminated code fence
  does, so a prose line beginning `$$` — "$$ is the shell's PID", a "$$ —
  moderate" price tier — would otherwise swallow everything after it into one
  block that is never translated and renders as a single red error. Such a
  fence is re-read as prose, at any nesting depth, and never inside code or
  raw HTML. Display maths written across a blank line stays one block, the way
  a fenced code block already did.
- **The translator never sees LaTeX.** Inline formulas are replaced by opaque
  tokens before a block is sent and restored afterwards; a token that does not
  round-trip reverts the block. A prompt is not a guarantee, and a mangled
  formula passes every structural gate — it still parses as a paragraph, so
  alignment is satisfied and wrong mathematics would publish silently.

### Fixed

- **One bad block no longer costs an article its whole translation.** Each
  translation is now verified on its own before the body is joined, and a block
  whose translation no longer parses as one block of the same type is replaced
  by its original. An arXiv paper lost all 364 blocks over 8 of them: Turndown
  converting MathML left paragraphs ending in a lone `=`, which markdown reads
  as a setext heading, so the model translated the prose and sensibly dropped
  the stray line. The same paper now publishes with ~4% of its blocks left in
  English. `checkAlignment` stays as the backstop for join-time interactions
  that per-block checks cannot see.
- **An indented code block no longer costs an article its whole translation.**
  The block join trimmed every block, including ones never sent to the model.
  That strips the four-space indent off an indented code block, which re-parses
  as a paragraph, fails the 1:1 alignment gate, and drops the translation for
  the entire article — over a block nothing had touched. Both LLM paths already
  trimmed their own output, so the join-level trim was redundant as well as
  harmful.
- **A batch that fails in transport now falls back to per-block translation**,
  the same as one whose markers came back wrong. A single slow batch used to end
  the article; once checkpoints made the next run resume at exactly that batch,
  it would have ended every later run too.
- **A block too large to send is kept untranslated instead of blocking the
  article** (`translation.max_block_chars`, default 20000). A top-level block is
  never split, so an oversized one used to be sent alone and expect an equally
  large response — past the provider's output cap that simply never succeeded,
  and the article went with it. Such a block is now left out of the batch and
  passes through in its original language. A 177-entry arXiv bibliography, 47K
  chars as one list, is the case this exists for.
- **One oversized article no longer starves the processing queue.** A 170 KB
  clip needed 14 sequential translation batches and could not finish inside the
  job's 30-minute cap; because translation kept no state, every retry restarted
  at batch 1, and because pending articles were processed alphabetically it ran
  first on every push and consumed the whole budget. A 27 KB article clipped
  alongside it never received a single LLM call. Four changes, together
  (ADR 0008):
  - translation is checkpointed per batch to `articles/<slug>/.tiro-zh-cache.json`
    and resumes there, so successive runs converge instead of repeating;
  - the processor enforces its own wall-clock budget
    (`processing.run_budget_ms`, 50 min) and stops in time to commit, with
    `timeout-minutes` raised to 60 as a backstop;
  - `Commit results back` runs `if: always()`, so a killed job no longer
    discards articles that did finish, and the deploy step now gates on a
    commit landing rather than on job success;
  - pending articles are processed cheapest-first, confining a pathological
    article's cost to itself.
- A timed-out LLM request is retried once instead of three times. A timeout has
  already spent its full budget before it is observed, so one stuck call cost
  over eight minutes of a thirty-minute job.
- The translation checkpoint is no longer discarded until `index.md` has been
  written. It used to go as soon as translation returned, so a failure while
  writing `zh.md`/`index.md` lost every translated block and left the article
  pending anyway.
- Checkpoint writes are atomic (write to a sibling file, then rename). A kill
  partway through overwriting the live file left truncated JSON, which the next
  run read as "no checkpoint" and restarted from batch 1 — the one situation the
  checkpoint was added for.
- A `--force` article deferred by the run budget now returns to pending, so an
  ordinary run finishes it. Previously it kept its `processed_at`, so the next
  run skipped it despite the log saying it would resume — and a repeated
  no-slug `--force` re-did the cheapest articles instead of advancing.
- The run budget now binds every stage, retry, and HTTP request rather than
  being checked only between articles and batches. Between two checks a single
  article could spend 5 minutes on images, 24 on summary retries and 16 on one
  translation batch — ~40 minutes past a budget with ten minutes of headroom,
  which could still trigger the hard kill the budget exists to prevent.

### Changed

- `config/tiro.yml` gains `processing.run_budget_ms`, `llm.timeout_ms`, and
  `llm.max_retries`. All default to current behaviour, so existing vault
  configs keep working unchanged.

- **Site redesign**: warm paper palette with a terracotta accent (replacing
  the stock neutrals and the green mark), self-hosted Source Serif 4 for
  titles and article prose (CJK falls back to system serifs), refined cards,
  a segmented reader toggle, and Pagefind search themed to match both color
  schemes (dark-mode search was previously unstyled). The full mark moved
  with it: extension icons, popup/options primary buttons, PNG favicons,
  the touch icon, and a rebuilt `og.png` social card are all terracotta.

- The site is published at <https://tiro.ainaive.com/> (Cloudflare Pages
  custom domain). The generated `*.pages.dev` URL keeps working.
- **Flat vault layout** (breaking, ADR 0007): articles moved from
  `articles/<year>/<slug>/` to `articles/<slug>/` — the path is now the
  identity, so a re-clip structurally cannot duplicate. Site URLs changed to
  `/articles/<slug>/` (no redirects). Existing vaults migrate with one
  `git mv` commit; `tiro.schema` stays 1 (document format unchanged).
- URL normalization strips a wider referral-param blocklist (`ref`, `source`,
  `from`, `si`, `spm`, `scm`, `igshid`, `mc_cid`, `mc_eid`, `wfr`,
  `isappinstalled`) so share-link noise dedups to one article.
- The extension stores the *normalized* URL in frontmatter (previously the
  raw `location.href`), so tracking params never reach the vault or the
  public site's source links.
- Translation batches grew from 2,500 to 10,000 source chars per LLM call
  (~4× fewer calls on long articles) and became tunable via
  `translation.batch_chars` in the vault's `tiro.yml`.
- The processor logs per-batch translation progress and per-attempt summary
  failures; the vault-template process job is bounded by
  `timeout-minutes: 30`.

### Added

- The popup tells you on open when the current page was already clipped —
  the status reads "Already clipped \<date\> — clipping again updates it."
  and the button becomes **Re-clip to vault** — from a local record of successful
  clips, checked without any network request, so the "nothing is sent until
  you clip" disclosure holds. Clip failures now explain themselves: an expired token
  points at Settings, a 404 at the repository fields and the token's access
  to the (private) vault, instead of raw API error text. `Alt+Shift+C`
  opens the popup.
- **The extension speaks English and Chinese** (ext 0.4.0): every popup and
  Settings string, clip error included, follows the browser's UI language by
  default, with an explicit override selector in Settings. The tables live in
  the extension itself because Chrome's `_locales` system cannot honor a
  per-extension override.
- The site has a favicon and touch icon (the extension's bookmark mark,
  reused) and shows the logo next to the wordmark in the header.
- Pages carry SEO and social meta: description (article pages use their LLM
  summary), canonical URL, Open Graph and Twitter cards with a rendered
  1200×630 site card.
- An RSS feed at `/rss.xml` — every clip with its summary and link, so the
  vault is subscribable from any reader.
- A sitemap (`/sitemap-index.xml`) and a `robots.txt` that welcomes search
  engines but disallows AI-training crawlers — the site republishes clipped
  third-party content, and feeding training sets is not ours to give.
- A branded 404 page — links from before the flat-layout migration (ADR
  0007, no redirects) landed on Cloudflare's default error page.
- A real footer: author ([hutusi.com](https://hutusi.com)) and
  [AI Naive](https://ainaive.com) attribution, plus GitHub, privacy-policy
  and RSS links. It was a single bare GitHub link before.
- The 440×280 small promotional tile the Web Store requires for publishing, and
  16px of transparent padding on the 128px store icon per Chrome's listing
  guidance (toolbar sizes stay full-bleed).
- Web Store data-use declarations now cover the GitHub username (PII) and the
  clipped URL (web history). Google's definitions are broader than "what we send
  to our own servers" — they cover locally processed data, and since August 2026
  apply regardless of how necessary the data is to the item's single purpose.
- **First-run data disclosure in the extension popup**, gating the first page
  read behind an explicit acceptance. The page is read when the popup opens (to
  build the preview), not when you click Clip, and the Web Store requires that
  disclosure and consent to be in the product UI rather than only in a privacy
  policy. Re-prompts when `DISCLOSURE_VERSION` is bumped.
- **Extension releases**: pushing an `ext-v<version>` tag builds the extension
  and attaches an installable zip to a GitHub Release, so other machines
  install it without a clone or a toolchain. The workflow refuses to publish
  when the tag and `manifest.json` disagree.
- The extension has icons (16/32/48/128, rendered from
  `apps/extension/icons/icon.svg`), a `homepage_url`, and the modern
  `options_ui` form — the set of things a Chrome Web Store submission requires
  before it will accept the package. Listing copy and images are drafted in
  `apps/extension/store/`.
- A privacy policy at `/privacy/`, bilingual, covering when the extension reads
  a page, what it stores (a GitHub token, locally), what a clip sends to GitHub,
  and that the site runs no tracking or analytics, Cloudflare's ordinary request
  logs aside. The Web Store requires a reachable policy URL for any extension
  handling authentication information.
- `validate` now checks the invariants it claimed to gate: every directory
  name is re-derived from its article's `url`, articles nested below
  `articles/<slug>/` are reported instead of being silently skipped by every
  glob, and translations that should not exist (no sibling `index.md`, or
  beside an already-Chinese or `translation_failed` article) are flagged.
- Stage-wide image caps (`images.max_count`, `images.total_max_bytes`,
  `images.stage_timeout_ms`) so one image-heavy article cannot run the
  process job past its `timeout-minutes`.
- The image stage reconciles `assets/` against the article body, removing
  files no longer referenced. Orphans from earlier clips previously
  accumulated forever and were copied into the deployed site.
- `validate` also reports a processed non-Chinese article that has neither a
  `zh.md` nor `translation_failed` — a finished run always leaves one or the
  other.

### Fixed

- The site rendered any `zh.md` it found next to an article. Since the
  extension rewrites `index.md` on a re-clip and never touches `zh.md`, a
  changed article was published against the previous body's translation until
  the next successful run — shown as confident side-by-side rows whenever the
  block counts happened to match. A translation is now rendered only when the
  frontmatter vouches for it (processed, not already Chinese, not
  `translation_failed`).
- A long tag became a directory name past `NAME_MAX` and failed the whole site
  build with `ENAMETOOLONG`. Tag slugs are now capped in bytes (Chinese tags
  reach 3 bytes per character) with a hash suffix when truncated.
- The image host guard checked hostname text only, so a public-looking name
  resolving into private space (`127.0.0.1.nip.io`) passed. Every redirect hop
  is now resolved and its addresses checked, against the private ranges plus
  RFC 6890's special-purpose ones — `100.64.0.0/10` (carrier-grade NAT) was
  previously accepted. DNS rebinding remains out of reach: `fetch` cannot be
  pinned to the checked address, and nothing downstream helps, since the
  request is already sent by the time the content-type gate runs. IPv6 is now
  accepted only inside global unicast (`2000::/3`) minus four documented
  carve-outs, rather than checked against a list of non-public ranges that
  could never be finished — multicast, site-local, 6to4, NAT64, Teredo and the
  IPv4-in-IPv6 blocks were all accepted before, several of which can carry a
  private IPv4 address.
- Asset reconciliation ran before the summary and translation calls, so a
  provider failure committed asset changes with no matching body. It now runs
  after the article is written, and a malformed relative reference such as
  `./assets/100%.png` no longer throws out of the image stage — that escaped
  the per-image fallback and left the article pending on every retry.
- Asset reconciliation deleted files that were plainly referenced: it scanned
  the body for references, which meant guessing where each one ended, so a
  comma inside an `srcset` or a full stop closing a sentence took the file with
  it. The question is asked filename-first now — does the body contain this
  exact name — which has no boundary to get wrong, and compared after
  percent-decoding. Only files shaped like the processor's own output (a 12-hex
  digest plus a known extension) are eligible for deletion at all, so a file it
  did not write can never be lost to a reference it failed to recognise.
- Reconciliation ran before the article was recorded as processed, so a failure
  while cleaning up (an unwritable `assets/` is enough) reported the article as
  "left pending" while it was already marked processed on disk, and every later
  run skipped it. Cleanup can no longer change an article's outcome.
- A run that failed after downloading images left those files behind for the
  workflow to commit. They are now rolled back against the article's committed
  body.
- `images.stage_timeout_ms` did not cover DNS resolution, which happens before
  the request the abort signal bounds. With up to six lookups per image and the
  deadline only checked between images, one image could overrun the stage
  budget by minutes.

- A provider failure during summarization (403, timeout, network) was
  reported to the model as malformed JSON, retried, and finally written as an
  excerpt with `processed_at` set — a wrong API key quietly degraded every
  article instead of failing. Such errors now leave the article pending, the
  way the translation stage already did.
- A stale `zh.md` was never removed, so a re-clip that turned Chinese, or a
  reprocess whose translation failed, left the previous translation rendering
  against a body it was never translated from.
- `translation.target` accepted any language while the artifact is always
  `zh.md`; a value like `ja` or `zh-CN` made every article translate,
  Chinese originals included. The schema now accepts only `zh`.
- Tags went into URLs raw, so an ordinary LLM tag like `ci/cd` produced a
  page at a path the route pattern cannot match (404 in `astro dev`) and
  broken links everywhere it appeared. Tags and categories are now routed by
  a slug, with the raw spelling kept as the label.
- The article's original pane declared no language and inherited `zh-CN` from
  the layout, so English text was announced as Chinese by screen readers.
- `workflow_dispatch` inputs were interpolated into the processing job's
  shell instead of passed as environment data.
- The image stage accepted a response with no `Content-Type` at all, and
  applied its non-public-host guard only to the URL the article named rather
  than to each redirect hop.

- Queued process runs checked out the vault at their trigger SHA, so they
  re-processed articles the previous run had just committed and then failed
  the push with a rebase conflict — discarding all their LLM work. The vault
  checkout is now pinned to `ref: main` and the commit-back rebase resolves
  same-article conflicts with `-X theirs`.

## [0.1.0] - 2026-08-24

First complete, live system: clip → summarize/tag/translate → publish,
verified end to end with real articles in both languages.

### Added

- **Content contract** (`@tiro/shared`): Zod frontmatter schemas, deterministic
  URL→slug rules (re-clip overwrites), `tiro.processed_at` needs-processing
  marker, strict 1:1 block-alignment model for translations, `tiro.yml`
  config schema with per-task model overrides.
- **Processor** (`@tiro/processor`): marker-scan discovery, CJK-ratio language
  detection, image localization into `assets/`, JSON-mode summary/category/tags
  with validated retries, sentinel-batched block translation with a hard
  alignment gate, `run`/`validate` CLI.
- **Chrome MV3 extension**: on-demand Readability + Turndown clipping,
  options page with connection test, single-file commits via the GitHub
  Contents API with cross-year re-clip overwrite and stale-sha retry.
- **Astro site**: month-grouped index, categories/tags, side-by-side
  original/translation reader with 原文/译文/对照 toggle, Chinese UI, dark
  mode, Pagefind full-text search (CJK-aware), deployed to Cloudflare Pages.
- **Automation**: vault processing workflow (concurrency-grouped, rebase-retry
  push-back, `repository_dispatch` to the site) and the dual-checkout deploy
  workflow; CI with lint, per-package typecheck, `astro check`, tests, and
  both app builds.
- Docs: architecture overview, ADRs 0001–0006, operations runbook, this file.

### Fixed

- Slug generation survives malformed percent escapes in URLs.
- Pipeline survives hard per-article failures (provider 403s leave the
  article pending instead of killing the run before its commit step) and
  clears stale `summary_failed`/`translation_failed` markers on reprocess.
- Image downloads: streaming size cap, targeted URL rewriting (no prefix
  corruption), per-image hotlink fallback.
- Extension options placeholders no longer masquerade as filled-in values;
  empty fields get a clear message instead of a misleading 404.
- Deploy no longer installs wrangler mid-workflow (pinned as a dev
  dependency after a transient install failure).

### Security

- Rendered article HTML is sanitized (rehype-raw + rehype-sanitize) — the
  public site never publishes scripts/event handlers smuggled through
  clipped pages.
- Processor rejects image downloads from non-public hosts (loopback,
  link-local/cloud-metadata, RFC1918) and caps response sizes.
- CI and deploy workflows run with read-only tokens and without persisted
  git credentials.

[Unreleased]: https://github.com/hutusi/tiro/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/hutusi/tiro/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hutusi/tiro/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hutusi/tiro/releases/tag/v0.1.0
