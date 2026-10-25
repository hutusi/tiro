# Tiro Architecture

Tiro is a personal read-it-later tool and external knowledge base. Code lives in
this monorepo (`tiro`); content lives in a separate vault repo (`tiro-vault`).

```mermaid
flowchart LR
    subgraph Chrome
        EXT[Extension\nReadability + Turndown]
    end
    PHONE[iPhone Shortcut\nShare Sheet]
    subgraph tiro-vault
        INBOX[inbox/&lt;file&gt;]
        MD[articles/&lt;slug&gt;/index.md]
        ZH[zh.md + assets/]
        WF[vault job\nprocess.yml on Actions,\nor run.sh on another host]
        COL[collections/&lt;id&gt;.md]
        PUB[publish.yml]
    end
    subgraph tiro
        PROC[packages/processor\nLLM pipeline]
        SITE[apps/site\nAstro]
    end
    CF[Cloudflare Pages]

    EXT -- "Contents API PUT" --> MD
    EXT -- "Git Data API: toggles, Remove" --> COL
    PHONE -- "Contents API PUT" --> INBOX
    INBOX -- "push triggers" --> WF
    MD -- "push triggers" --> WF
    WF -- "runs" --> PROC
    PROC -- "commit back" --> ZH
    WF -- "repository_dispatch" --> SITE
    COL -- "push triggers" --> PUB
    PUB -- "repository_dispatch" --> SITE
    SITE -- "wrangler pages deploy" --> CF
```

## Data flow

1. **Clip.** The Chrome extension repairs the page DOM, extracts it
   (Readability), converts it to Markdown (Turndown), assembles frontmatter,
   and commits a single `index.md` into the vault via the GitHub Contents API.
   Images stay hotlinked (absolute URLs) at this stage. The one exception is a
   figure the page draws with script, or a chart it draws as `<svg>` (ADR 0039,
   ADR 0044). Clip takes its picture before it commits, unless the reader
   unticks "Save figures as pictures" (ADR 0045). The picture is taken in the
   popup and committed beside `index.md`, as `assets/<12 hex>.webp`, in one Git
   Data API commit. It is named the way the processor names its downloads, so
   processing keeps and prunes it like one.

   Two kinds of page are not read from the tab at all, for one reason: their
   publisher's URL forms are a single identity (ADR 0013), so a clip does not
   *add* an article but replaces one — and the body in the tab is the lesser of
   the two. Both are fetched under an optional host permission requested from
   the Clip button's own user gesture, and record `tiro.source_url`. The popup
   holds them behind one `FetchableSource` descriptor, and the rule for choosing
   between a fetched body and the tab's lives in `clip-candidate.ts`: prefer the
   body that *is* the document, and gate the Clip button until that is settled.

   - **An arXiv paper.** The popup fetches `arxiv.org/html/<id>`, falling back
     to the abstract page — of the same revision, when the URL named one — when
     arXiv has no usable HTML (a `\includepdf` submission renders as a stub
     arXiv still serves with HTTP 200). A fetched document is given a `<base>`
     and has its `src`/`href` attributes rewritten
     before extraction: Readability absolutizes against `doc.baseURI`, which for
     a `DOMParser` document is the popup's URL, and the processor downloads only
     `https?://` URLs — so without it every figure would vanish without an error
     anywhere.
   - **A markdown file on GitHub.** A `github.com/<owner>/<repo>/blob/…/*.md`
     page is a *rendering* of the file, and its "Code" tab is worse — the source
     sits in a virtualized container holding only the lines scrolled into view.
     The popup fetches the bytes from `raw.githubusercontent.com` instead
     (ADR 0023). Nothing is fetched when the reader is already on the raw URL:
     the tab holds the file and `activeTab` covers reading it.

   A PDF on this computer is imported from the **options page** instead
   (ADR 0027). The extension reads its layout there — font, size and position
   per run of text, not merely the characters — a file picker needs
   no permission, and pdf.js is loaded lazily so Settings does not pay 1.6 MB
   to be opened — applies the page and scan gates while there is still a person
   to tell, and commits the text with its pages separated. The document is
   filed under `local:<filename>`, carries the `"local"` domain sentinel, and
   starts unlisted. Where the layout reads cleanly the import commits finished
   Markdown and no model is ever involved (ADR 0028). Nothing binary enters the
   vault on either path.

   A PDF served to the tab itself is clipped as a **stub** — identity and title,
   no body — and the body is built later by the processor from the document's
   text layer (ADR 0026). The extension never reads the PDF: Chrome renders it
   in a viewer the DOM cannot see, so `isPdfViewerDocument` recognises the
   viewer by the document's content type — the current viewer leaves nothing
   else in the DOM to go on — and the popup commits the URL instead, named after
   the file. The processor replaces that name with the document's own `/Title`
   once it has the bytes, the one place the title can be read. Where a
   publisher offers an HTML twin the offer above wins and no stub is written,
   because stubbing an arXiv PDF would file the lesser body under the paper's
   own slug.

   A markdown file is the one document the pipeline below does not touch. Chrome
   renders `text/plain` as a shell whose body is one `<pre>`, which the clipper
   used to convert into a single fence around the whole document — untranslatable
   by contract, titled after the hostname, and with every repo-relative image
   left pointing at the site's own origin. The file is already markdown, so
   `clipPage` branches before any of the repair below: the body is carried
   verbatim, relative destinations are resolved against the URL the bytes came
   from, reference-style links are inlined so each top-level block still renders
   standalone, and the title comes from the file's own frontmatter or its first
   heading (ADR 0023). Detection is structural — the body is exactly one `<pre>`
   holding all of the document's text — so GitLab, Codeberg and any static `.md`
   are covered without a hostname.

   A Hacker News thread is the third branch (ADR 0038). Its comments are rows
   of one flat table, with depth as an attribute, and Readability kept their
   headers and pruned their text. `clipPage` recognises an item page by its
   `table.fatitem` head and reads the rows directly. The result is the story's
   URL, the self-text, a poll's choices, then one top-level blockquote per
   comment, nested by depth, so translation and the reader both work comment
   by comment. Rows HN
   marks as folded (`coll`/`noshow`) are skipped. Those are the reader's `[–]`
   and HN's own folds of flagged or off-topic subthreads, so the thread is what
   the tab shows. The site sets a thread's quotes as rails rather than
   citations, keyed on the article's `domain`.

   The repair pass (`packages/clip/src/dom-prepare.ts`) runs on a clone
   *before* Readability, which prunes low-text subtrees it cannot be asked to
   give back. It recovers each formula's LaTeX source (KaTeX/MathJax
   annotation, then arXiv's `<math alttext>`, then MathJax v2's
   `math/tex` script), deletes the visual duplicate, escapes literal dollars so
   the recovered delimiters are the only bare ones left, and records `has_math`;
   and it normalizes however the page marked up its code languages into the
   `language-*` class Turndown reads, dropping line-number gutters (ADR 0009).
   When a page marks up no language at all — the Shiki-rendered case, now
   common on docs sites and engineering blogs — it falls back to the chrome
   around the block: a tab strip's selected tab, a header naming a file. That
   text is resolved through an allowlist and never a pattern, because `Copy`
   and `Output` sit exactly where a language name sits (ADR 0012).
   It also clears the class tokens that make Readability delete a code block:
   that judgement is made on an element's class name before it looks at what the
   element holds, and Tailwind's `overflow-hidden` and `code-block-scroll`
   collide with the regex that decides. Only the colliding token is removed —
   the element and every other class stay, so Readability keeps reaching its own
   verdicts rather than having them re-derived here (contrast the gallery
   wrapper, which is unwrapped and therefore needs an allow-list).
   And it joins an article a page split into several bodies — Ars Technica's
   `post-content` stretches, each in its own grid row between ad slots — which
   Readability would score apart and keep one of. Only same-class body blocks
   inside one `<article>`, each at least two paragraphs, with nothing between
   them but chrome: a heading, figure, list, quote, rule or real text between
   keeps them apart, since that is how org-mode exports, wikis, footnotes and
   callouts repeat a class too. Ad slots are chrome whatever they hold — empty
   in the page the processor fetches, filled with an iframe in the one a
   reader clips.

   Two things then have to survive Readability, and only one of them can travel
   as itself. Readability strips `class` from everything it returns, so a
   recovered formula and a recovered code language both cross on a `data-tiro-*`
   attribute and are turned back into markdown-bearing shapes afterwards — the
   formula by a Turndown rule, the language by having its class restored in
   `clip-page.ts`. Anything computed before extraction has to ride a `data-*`
   attribute to get past it.

   Figures are the other post-extraction step, folded *after* it instead: a `<figure>`'s
   caption joins its image's paragraph, so the two arrive as one block and the
   site can render them as a figure — co-location is the only association
   markdown can express (ADR 0011). It has to run second because Readability
   selects on the very attributes folding replaces; done first, a
   `<figure hidden>` became a plain `<p>` and its hidden image was published.

   A figure the page draws with script — a `<figure>` holding only empty
   containers, or a `<canvas>` and the labels, narration and buttons laid over
   it — has nothing markdown can hold, and used to lose everything but its
   caption. It crosses Readability with its label in a marked `<span>`, and
   after it becomes one block: `[Interactive figure](page#id): label`, with the
   caption on the next line, translated as prose. Its overlays are chrome and
   are dropped. Which figures qualify is an allow-list, so images, quotes,
   code and third-party embeds (a `<script src>` in the figure) convert as they
   always did. Clip replaces each link with a picture of the figure before it
   commits (ADR 0039, ADR 0045): it scrolls the tab to the figure, takes the
   visible tab, crops it, and re-clips with the pictures in. A figure it cannot
   picture stays a link, and the popup says why and what to do.

   A chart drawn as `<svg>` — four or more painted labels — becomes the same
   block (ADR 0044) rather than being deleted with nothing left in its place.
   Its host is its `<figure>`, or, with none, the outermost `<div>` holding
   it and nothing but a chart's chrome (GitHub's blog mounts its charts that
   way). Inside it, captions, paragraphs and sentences are kept as the
   caption, and titles, legends, controls and the tooltip a hover fills in are
   dropped. A chart nothing can be said for is still deleted, so its labels
   never arrive as one run of glyphs.

   A video becomes its still, linked to where it plays: a `<video>` its
   poster and file, and an embedded player Readability keeps (YouTube, Vimeo…)
   its thumbnail and watch page, `[![label](still)](watch)` (ADR 0040).
   Readability's own player allowlist, plus the few players a publisher hosts
   itself (The Atlantic's, linked to its video page), is handed to it as
   `allowedVideoRegex`, so the frames it keeps and the frames converted after
   it are the same set. Turndown has no rule for either, and wrote nothing.

   A pull quote, the sentence a magazine repeats in large type between its
   paragraphs, is kept and marked as one (ADR 0041). Readability removes every
   `<aside>`, which is how The Atlantic writes them, so an element the page
   calls a pull quote is marked before it, its text kept in a paragraph as
   Readability would make one, and written as a blockquote whose first line is
   `<!-- pull quote -->`: one block, translated like any other, that the site
   can tell from a quotation.

   Every other `<aside>` stays out, including the one Readability lets through
   itself. It appends a sibling of the article that scores well enough, and
   renames it `<div>` first, which takes an aside out of reach of its own
   rule: GitHub's blog follows each post with an aside of promotional cards,
   "Explore more from GitHub", that came out at the foot of the article. Each
   aside is marked before Readability, and one that comes back renamed is
   dropped in Readability's serializer.
   - **The exception is the article Readability chose.** Readability's choice
     is read the moment it is made, as the article reaches `_prepArticle`:
     the block holding the element it scored highest is the article, since
     every step it takes from its best candidate goes up.
   - **Read then, not later.** Its clean-up afterwards replaces a one-child
     wrapper with its child, copying the wrapper's attributes (the mark goes
     with them) but not its score.
   - **Length tells nothing here:** the article can be the shorter.
   - **The hook is a private method.** If it is renamed, nothing is dropped,
     and the tests say so.

   The title is the headline the page shows (ADR 0042). Readability reads
   JSON-LD first, and a publisher may put a headline written for search there.
   The Atlantic does so on about half its articles. So the page's `<h1>` wins
   when `og:title`, `twitter:title` or a JSON-LD article's `headline`, `name`
   or `alternativeHeadline` confirms it. The evidence is read before
   Readability, which removes the `<h1>`, and the body is untouched.

   An X Article is read from X's own labels (ADR 0043). Its rendered page has
   no metadata to confirm anything, so the title is the element X labels
   `twitter-article-title`. Its text is Draft.js blocks of `<div>`s, which
   Readability split at every link and stripped of every heading, so each text
   block becomes the paragraph, heading, list item or quote it is before
   Readability reads it.

   A page of pictures and no prose clips as its pictures (ADR 0050).
   Readability scores text, so on a photo essay it chose the next most
   text-like block, a site header. When its choice holds no picture and fewer
   than 100 letters, the page's `<main>`, `role="main"` or `<article>` with the
   most pictures (at least 3) and as few words outside its captions is taken
   instead: its images in order, each `<figure>` whole, and none of its other
   words.

   An article keeps the header Readability leaves beside it (ADR 0052).
   Readability looks only at its chosen block's siblings, so a page that sets
   its header next to the body — The Atlantic's hero, a Substack subtitle —
   lost its dek and lead picture. The page is read again between the
   confirmed `<h1>` and where Readability's article begins, and two things
   may come back from there, in the page's order: a dek the page's own
   description confirms, as a paragraph, and a lead picture the page's
   `og:image` or JSON-LD names, or that it sets as a `<figure>`, with its
   caption. The byline never does; it stays `author`. If Readability kept any
   of it, nothing is added. The clip reports the lead on its own too
   (`ClipPayload.lead`), for the repair that adds it to articles saved before.

   **Adding a missing lead** (ADR 0053). An article saved before ADR 0052 gets
   its lead without a re-clip: "Add missing lead" in the popup, on a page this
   machine clipped, or `sweep --fill-leads` / `--dek-from-excerpt` offline.
   All three go through `mergeLead` (`@tiro/shared`), which inserts only the
   missing parts at the top of the body, keeps every other byte, refuses a
   page that no longer begins where the article does, and swaps
   `tiro.processed_at` for `tiro.refresh: translation`.

   **Saving a link instead** (ADR 0034). A phone's Share Sheet shortcut — or
   the extension's "Clip link" — writes one file into the vault's `inbox/`
   holding the URL, through the same Contents API. A file rather than an event,
   so the save is in git before any workflow runs. Nothing else happens on the
   phone: it cannot compute a slug, and does not need to.

   **Removing one** (ADR 0036). "Remove", at the foot of the popup — on the
   article's Tiro page, or on a page this machine clipped — reads the article
   from the vault to name it, then, on confirm, deletes every file under
   `articles/<slug>/` (`sha: null` tree entries) and drops the slug and any
   pinned cover from every collection, as one Git Data API commit built
   against the head it lands on. That push runs `process.yml`, which has
   nothing to process and deploys. A run already working on the article lets
   the deletion win at its commit-back and commits the rest.

   **Filing one** (ADR 0037). Once a clip saves, the popup reads every
   `collections/*.md` at the branch head and offers the Tiro page's tick-list
   under it. Ticks join ADR 0029's queue and flush as one Git Data API commit
   when the popup closes — a second push after the clip's own. An add for an
   article clipped minutes ago that the vault does not show yet is kept
   pending rather than refused, since GitHub's reads can trail its writes.
2. **Process.** A push to `articles/**` or `inbox/**` triggers the vault job —
   the vault's workflow on Actions, or the same scripts on another host when
   the vault's `TIRO_PROCESSOR` variable says so (ADR 0046) — which checks out
   this repo and runs `tiro-process`:
   - turn each `inbox/` file into a stub article — normalized URL, the domain
     as a placeholder title, `tiro.capture: "link"`, no body — and delete it;
     a URL that already has an article keeps it (ADR 0034),
   - for a stub with `capture: "link"` and no body, fetch the page and clip it
     with `@tiro/clip` — the extension's clipper — in a hardened happy-dom
     document that runs no script and loads nothing. A failure retrying will
     not change (a 404, a bot check, a sign-in redirect, a page built by
     scripts) is recorded as `tiro.fetch_failed` and the article left alone;
     a link that is a PDF goes on to the PDF step,
   - for a PDF (`tiro.source_media: "pdf"`), build the body first. A web PDF is
     fetched under the same guards the image stage uses and read structurally:
     where its typography carries a heading hierarchy or a fixed-width face,
     the Markdown is built from that and **no model is called at all** (ADR
     0028). Only a document with nothing to read falls back to the flat text
     and the structure pass. An imported one arrives with all of this already
     done, or, where it did not read cleanly, with the flat text and the pass
     still owed — the branch is taken from the URL scheme, since `local:`
     cannot be fetched (ADR 0027). Where the model does run it is asked to
     restore Markdown structure — checking each reply kept its content and
     rebuilt no tables, and keeping the extracted text where it did not
     (ADR 0026). A refusal leaves the article pending, so nothing is re-clipped,
   - detect language (CJK-codepoint ratio, no LLM call),
   - download images into `assets/` and rewrite body URLs to relative paths
     (per-image fallback to hotlink on failure),
   - one LLM call for a structured summary, one category (from the taxonomy in
     `config/tiro.yml`), and tags — Chinese first, in one canonical form, through
     the aliases `tiro.yml` may set (ADR 0033, ADR 0035) — written into frontmatter — and, for
     an article not already in the target language, the title translated into it
     and the summary written a second time in the article's own language. One
     call, so a title and the summary it renders under agree on their terms
     (ADR 0016),
   - for non-Chinese articles, a block-aligned Chinese translation → `zh.md`,
     batched and checkpointed so a long article resumes rather than restarts
     (ADR 0008),
   - commit results back and fire a `repository_dispatch` to this repo —
     after every push and manual run, committed or not, so a hand edit to the
     vault publishes itself (ADR 0032),
   - only then, turn the job red if an article failed hard or could not be
     read, so GitHub's failed-run email is the alert — or, off Actions, the
     host's own. The processor itself always exits 0 and hands the count to
     the job (ADR 0032).

   Pending articles are processed cheapest-first, under a wall-clock budget
   (`processing.run_budget_ms`) the processor enforces itself so it stops in
   time to commit. Anything it does not reach stays pending for the next run.
3. **Publish.** The deploy workflow checks out both repos, builds the Astro
   site from the vault content, indexes it with Pagefind, and deploys to
   Cloudflare Pages. The site is fully public. Large images are served as
   WebP copies at most 1600 px wide, made at build time and cached between
   deploys by content hash; the originals are published beside them and stay
   untouched in the vault (ADR 0049).

   The site's shape follows the "Later Reader" design (ADR 0014): a paginated
   Library at `/` and `/page/N/`, a 搜索与标签 page carrying Pagefind search
   plus every tag as a chip (`/tags/` redirects to it — `astro.config.mjs`
   for dev and the static fallback, `public/_redirects` for Cloudflare's
   edge; categories are reached from each article, ADR 0031), the reader, and a settings
   page. Reading preferences — paper, text size, default layout, list view —
   live in the browser's `localStorage` and are applied by an inline script
   before first paint; nothing about a reader ever reaches the server.
   Reading time and the status pill are derived at build time from the
   contract's existing fields (`src/lib/article-meta.ts`). The Chinese title is
   *stored* — `title_zh`, written by the processor (ADR 0016) — with the title
   lifted out of `zh.md` kept as the fallback for articles processed before the
   field existed. That lifted pair still decides one thing on its own: whether
   the body repeats its own title and the reader should skip its first row.

   Rendering is one unified pipeline (`apps/site/src/lib/render.ts`). It parses
   with `remark-cjk-friendly`, as `@tiro/shared` does, so a translation whose
   emphasis touches CJK punctuation renders as emphasis rather than asterisks
   (ADR 0025). Shiki
   and KaTeX run *after* rehype-sanitize, as trusted generators over
   already-scrubbed text, so the allowlist never has to admit the classes and
   inline styles they emit — which would admit them from clipped markup too
   (ADR 0009). One more pass sits between the sanitizer and those generators:
   the sanitizer clobbers `id` to `user-content-…` and leaves `href="#…"` alone,
   so in-document links are reconciled with their targets there — and scoped to
   the pane they render into, since both columns share one document (ADR 0024).
   A picture linking to a video gets a play badge the same way: a pass after
   the sanitizer marks it with a class no clipped markup can carry, and the
   stylesheet draws the badge. The site runs no player (ADR 0040).
   A pull quote's blockquote becomes `<aside class="pull-quote">` in a pass
   there too, decided before rendering since the mark is a comment the
   sanitizer drops, and in paired rows by the original for both panes, since
   the translator may lose it (ADR 0041).

   A fence that still carries no language after the clipper's chain gets one
   inferred from its code at build time (`@tiro/shared`'s `detect-language.ts`),
   on unambiguous
   signatures only. Inference lives here and not in the clipper because a guess
   written into the vault is permanent while a guess made at build time costs
   one build — and because roughly 16 of the vault's 40 fenced blocks are
   English prose that an author fenced for display, so the failure that matters
   is a paragraph painted as Ruby, not a block left plain (ADR 0012).

## The content contract

`packages/shared` is the single source of truth shared by all three
components: frontmatter schema (Zod), slug/path rules, block-alignment
helpers, and the `tiro.yml` config schema. Key invariants:

- **Slug is deterministic from the URL** (normalized URL → slugified
  host+path + 8-hex SHA-256 suffix). Articles live flat at
  `articles/<slug>/` (ADR 0007), so the path itself guarantees a re-clip
  overwrites the same article and reprocesses it.
- **A publisher may define its own identity** (ADR 0013). `canonicalizeUrl`
  runs last in `normalizeUrl` and rewrites a URL to the form its publisher
  declares canonical. Two rules today:
  - **arXiv**, whose `/abs/`, `/pdf/` and `/html/` forms and `v1`/`v2` suffixes
    all name one paper, and whose abstract page says so in its own
    `rel="canonical"`. The rewrite fires only on a known host, a known paper
    route and an exact identifier match, so `/list/cs.AI/recent` stays an
    ordinary page.
  - **GitHub markdown** (ADR 0023), where the raw bytes and the blob page are
    one file and `refs/heads/main` and `main` are one ref. The rewrite carries
    `<ref>/<path>` as an opaque tail and only replaces the prefix, because a
    branch name may contain slashes and nothing offline can say where the ref
    ends. A different ref stays a different article — a tag or SHA is a pin,
    not a variant — and the rule is gated on markdown, because identity is only
    safe to claim where the clipper can read the file.

  `tiro.source_url` records the URL the body was read from when that is not the
  article's own — for arXiv the versioned HTML page (or that revision's
  abstract, when it has no HTML), for GitHub the raw file.
  Changing a rule renames existing articles: `validate` detects it,
  `sweep --recanonicalize` repairs it.
- **Short links are derived, not assigned** (ADR 0019). `/s/<id>` redirects to
  `/articles/<slug>/`, where `<id>` is the slug's own 8-hex suffix read back
  out — so there is no registry, nothing in the vault knows short links exist,
  and any component that can compute a slug can compute the link. The long URL
  stays canonical; the aliases carry `noindex` and are filtered out of the
  sitemap. Two articles deriving one id lose it both, rather than one of them
  being reassigned something a later rebuild could resolve differently.
- **Needs processing** = frontmatter lacks `tiro.processed_at`. Idempotent and
  retry-safe; no dependence on push diffs. How much is redone is a separate
  question: the optional `tiro.refresh: translation`, set by a lead repair
  (ADR 0053) and named on `ArticleFrontmatterSchema` only, has the run keep
  the summary, tags and titles it already wrote and translate only the new
  blocks; the run that finishes the article removes it, and `--force`
  ignores it. Every translated article keeps a
  `.tiro-zh-cache.json` checkpoint beside it: an article too long for one run
  resumes from it (ADR 0008), and a finished one holds onto it so a later
  re-clip pays only for the blocks whose source text changed (ADR 0010). A
  block is found by its words with its link and picture addresses set aside,
  which are filled back in from the block as it stands, so a picture the
  image stage moves to `./assets/` keeps its caption's translation (ADR
  0054). The checkpoint is invisible to every reader, which glob
  `index.md`/`zh.md` only.
- **Translation alignment**: `zh.md` has strict 1:1 top-level-block alignment
  with the `index.md` body (`code` and `math` blocks byte-identical). The site
  zips the two block arrays for side-by-side rendering; misalignment falls back
  to stacked rendering, and the processor never writes a misaligned `zh.md`.
  The shared parser runs remark-math, so `$$…$$` is a single `math` block even
  with blank lines inside, the way a fenced code block already is (ADR 0009).
  Math and code *inside* a translated block (a list item, a quote) are masked
  before the model sees them, put back verbatim, and checked afterwards: a
  block whose formulas or code came back different stays in the original
  (ADR 0009, ADR 0038).
- **Each article records what produced it**: `tiro.clipper_version` and
  `tiro.clipper_commit` alongside `tiro.processor_version`, all optional so
  articles predating any of them simply lack them. The version names a
  *release*; the commit — `git describe` output injected at build time, e.g.
  `ext-v0.11.0-8-gbe3dcc8` — names the *source* it was built from, which is the
  honest answer when the extension is loaded unpacked from a working tree
  rather than installed from a release. A `-dirty` suffix records that the tree
  differed from that commit without saying how, so two dirty builds off one
  commit are indistinguishable: it narrows an investigation rather than
  settling it. Answering "which clipper wrote this?" per article beats comparing
  `clipped_at` against the extension's git history, which is how the arXiv
  equation regression had to be traced. Note that both must be named on
  `ArticleFrontmatterSchema`, not just the clip schema: zod strips keys an
  object does not name, and the processor reparses and rewrites frontmatter on
  every run, so an unnamed field is deleted the first time an article is
  processed.
- **The translated title is stored, not derived** (ADR 0016): the optional
  `title_zh`, and beside it `summary_orig`, the summary written a second time in
  the article's own language. Both are named on `ArticleFrontmatterSchema` only
  — the inverse of the provenance rule above, and for the inverse reason: the
  processor writes them, so a re-clip *should* drop them. The page's title may
  have changed, and the clip that rewrites `index.md` also clears
  `tiro.processed_at`, so the next run writes them again. Optional and additive,
  so no `tiro.schema` bump.
- **Unlisted articles are kept out of every public index** (ADR 0017): the
  optional `unlisted` flag, set by hand in the vault, keeps an article out of
  the library, the pager, the tag and category pages, the search index, the feed
  and the sitemap, while leaving it built and reachable at its URL. Nothing
  originates it, but it is named on *both* schemas, because both sides rewrite
  frontmatter: the processor spreads it through, and the clipper reads it off
  the article a re-clip is about to overwrite (in the GET that already fetches
  the blob sha) so hiding survives a re-clip. The site is public
  and slugs are deterministic (ADR 0007), so this hides an article from anyone
  browsing, not from anyone who knows the source URL: it is not access control.
  Optional and additive, so no `tiro.schema` bump.
- **Collections are the owner's, not the pipeline's** (ADR 0029). One file per
  collection at `collections/<id>.md`, the filename stem being the id, holding
  an ordered list of member slugs; favorites is the reserved id `favorites`.
  They are the vault's only cross-reference — a collection names articles —
  so `validate` checks every member exists and `sweep --recanonicalize`
  rewrites memberships when it moves a slug. Nothing in the processor sees
  them: every glob it runs is rooted at `articles/`, and a collections push
  triggers the vault's `publish.yml`, which only dispatches a deploy. The site
  joins members through the listed funnel, so an unlisted article stays off a
  public collection page while its own page still shows its chips. A
  collection's cover is derived from its listed members' lead images unless a
  hand-set `cover:` pins one article asset by vault path (ADR 0030); `validate`
  checks it exists and is listed, and the sweep carries it across a rename.
  An item may carry a `section:`, repeated on every member of it; consecutive
  members sharing one are drawn under that heading (ADR 0051).
  Every page
  carries a `tiro:site` meta and article pages a `#tiro-page` JSON island (slug,
  memberships, catalog), which is how the clipper recognizes a Tiro page on any
  domain. The clipper also offers them under a clip it has just saved, reading
  the catalog from the vault instead of a page (ADR 0037).
- **Math is declared, not guessed**: the optional `has_math` flag records that
  the clipper escaped every literal `$` in the article's prose, so every bare
  `$…$` left in it is a formula. Only those articles read `$…$` as a delimiter;
  everywhere else the site renders `$$…$$` alone, so prose dollar amounts are
  never mistaken for formulas. Only the clipper may set it — it is the one
  component that sees the DOM and can tell a price from a formula (ADR 0009).
- **LLM access is provider-configurable**: an OpenAI-compatible
  chat-completions endpoint configured in `config/tiro.yml` (`base_url`,
  `model`, `api_key_env`). Default: Aliyun Bailian + `qwen-plus`.

## Repositories and credentials

| Where | Secret / token | Purpose |
| --- | --- | --- |
| Extension options page | fine-grained PAT (tiro-vault, Contents RW) | clip, collection and removal commits — in `chrome.storage.local`, and in `chrome.storage.sync` too if the user opts into settings sync (ADR 0022) |
| tiro-vault Actions | `TIRO_LLM_API_KEY` | LLM calls |
| tiro-vault Actions | `TIRO_DISPATCH_TOKEN` (tiro, Contents RW) | repository_dispatch, from `process.yml` and `publish.yml` |
| Processing host off Actions (ADR 0046) | files the job user can read: the LLM key (`TIRO_LLM_API_KEY_FILE`) and the dispatch token (`TIRO_DISPATCH_TOKEN_FILE`) | the same, for `run.sh` |
| Processing host off Actions | a key that can push to tiro-vault (a deploy key with write access) | the run's checkout and commit-back — pushes that, unlike `GITHUB_TOKEN`'s, start runs |
| tiro Actions | `VAULT_READ_TOKEN` (tiro-vault, Contents R; only if vault is private) | deploy checkout |
| tiro Actions | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Pages deploy |
| iPhone Shortcut | fine-grained PAT (tiro-vault, Contents RW) | writing a saved link into `inbox/` — its own token, so a lost phone is one revocation (ADR 0034) |

## Risk register

- **A captured figure is checked only live** (ADR 0039). The sweep and the
  tests cover the placeholder and the DOM transform; scrolling, the screenshot
  and the crop need a real browser, which is the manual pass. A chart a script
  mounts into an empty box — GitHub's blog — exists only live too: the sweep
  sees the empty box and cannot report on it (ADR 0044). A re-clip
  with the pictures box unticked goes back to links, and the processor prunes
  the pictures; the popup says so before it happens (ADR 0045).

- **A popup closed while Clip takes pictures saves nothing** (ADR 0045). Clip
  takes about two seconds a figure before it commits, and the popup holds the
  pictures until then; a click on the page closes it. The vault keeps what it
  had and the page's watchdog restores the scroll. The worker hears the
  popup go mid-clip and puts a "!" on that tab's toolbar button, which says
  why in its tooltip — the one notice; it cannot keep the clip. The cure is a
  capture loop owned by the service worker, which is deferred.

- **A saved link reads less than a browser clip** (ADR 0034). The processor's
  fetch carries no cookies and runs no script, so a paywall answers as to a
  stranger and a script-built page arrives as a shell. Measured on the live
  vault, about one page in ten; each becomes `tiro.fetch_failed`, reported
  once, and a clip from the browser replaces it.
- **A page parsed on the processor could try to act** — scripts, subresource
  requests — in a job holding the LLM key and a vault-writing token. The
  parser (`@tiro/clip/happy-dom`) runs none and fetches nothing, and both are
  tested against a mutation that turns each guard off.
- **Silently empty article list** when the vault path is wrong: the site
  asserts the vault dir exists and fails the build if the list is empty. The
  default `fixtures/vault` is found by searching upward rather than by counting
  `..` — the reader is bundled for the build, where a fixed depth pointed at
  `apps/fixtures/vault` and only this guard caught it.
- **One unreadable vault file blocking every deploy** — an article whose
  frontmatter fails the contract, or a collection file that will not parse.
  It used to fail the build, so the old site stayed live and every later
  change, deletions and unlistings included, was held back with nothing
  announcing it. A deploy now leaves such a file off the site, publishes the
  rest, and goes red naming it (ADR 0048). CI and local builds stay strict.
- **A clipped asset that cannot be measured** — a tracking pixel served as a
  dimensionless SVG, say. It used to fail the whole build, because Astro's
  content layer measured every image an article referenced. The site reads the
  vault itself now and serves assets as plain copies, so a bad one costs its own
  image and nothing else (ADR 0020); a fixture holds the line. The resized
  copies of large images keep that rule: an image that will not encode, or a
  build where sharp will not load, serves the original (ADR 0049).
- **An imported document cannot be re-read at all.** Its bytes were never in
  the vault and CI cannot reach the disk they came from, so `--force`
  re-restructures the body rather than re-extracting it. Re-importing the file
  is the way to genuinely start over (ADR 0027).
- **A PDF whose source disappears** cannot be reprocessed: unlike a clip, a PDF
  article's body is derived from bytes the vault never stored, so a 404 later
  means the article keeps the Markdown it already has. The same position a
  re-clip of a dead URL is in, and the price of keeping binaries out of the
  vault (ADR 0026).
- **A model that summarizes instead of restructuring** a PDF would be invisible:
  the reply is clean Markdown either way. Each reply is measured against its
  input for retained content and refused for rebuilding tables; a batch that
  fails every attempt keeps the extracted text instead.
- **`btoa` throws on non-Latin1** (Chinese titles): the extension encodes
  base64 via a chunked `TextEncoder` helper.
- **Readability returns `null`** on SPAs/paywalls: fall back to capturing
  `document.body` with a `readability_failed` frontmatter flag.
- **Readability judges content by a regex over class names**, before it looks at
  what an element holds, and ordinary CSS collides with those regexes by
  accident. Three collisions have cost published articles their content:
  `ltx_guessed_headers` matched `header` and deleted arXiv's data tables
  (0.9.0); a CSS-module `…media-gallery` matched `media` and deleted every image
  in a gallery (0.11.0); Tailwind's `overflow-hidden` and `code-block-scroll`
  matched `hidden` and `scroll` and deleted every code block on a docs page
  (0.11.1). The remedy each time is to hand Readability a DOM it judges
  correctly, never to re-derive its rules — see `dom-prepare.ts`. Expect a
  fourth; the sweep is what finds them.
- **Hotlink-protected or oversized images**: per-image fallback to the
  original URL; an image failure never fails the article. Stage-wide caps
  (`images.max_count`, `total_max_bytes`, `stage_timeout_ms`) stop an
  image-heavy page from running the job past its `timeout-minutes`.
- **Contents API 1MB GET limit**: above 1MB the Contents API returns a file's
  sha but not its content, and a re-clip needs both — the sha to overwrite, the
  old file for its `unlisted` flag and, on a PDF stub, its body (ADR 0026).
  `findExistingIndex` and `readTextAt` read the content from the Git blobs API
  instead, which serves up to 100MB, so a very large article re-clips and
  removes like any other.
- **Workflow recursion**: pushes made with the default `GITHUB_TOKEN` do not
  retrigger workflows; the processing workflow also uses a concurrency group
  and rebase-retry pushes. Off Actions (ADR 0046) the processor's push does
  come back as a trigger: `run.sh` treats a push whose head commit is
  `tiro-processor`'s as scheduled — it deploys only what it commits — and
  after three of its own commits in a row leaves the rest to the daily run.
- **Two hosts processing at once** — a manual run on Actions while another
  host is live: the work both do is paid for twice, and nothing is lost,
  since processing is idempotent and the commit-back rebases.
- **Name resolution on the processing host.** The fetch guard resolves a name
  before fetching it, so a resolver that answers with reserved addresses keeps
  images as hotlinks and refuses saved links and web PDFs. A proxy's fake-ip
  answer leaves them pending, with a red run naming it (ADR 0047). Any other
  reserved answer, such as some poisoned ones, settles them for good. Off
  Actions, or in a run by hand behind such a proxy, the host needs clean DNS.
- **A missed webhook** (off Actions) is not redelivered by GitHub. The daily
  run picks up its processing; a hand edit's deploy waits for the next one,
  or for a redelivery by hand.
- **An article deleted while a run processes it.** The run's commit-back
  rebase cannot settle an edit to a file `main` deleted, and used to fail the
  step and lose the whole run's work. It now measures which articles `main`
  deleted since the run's checkout and drops the run's changes to each before
  rebasing, so the deletion wins and the rest commits (ADR 0036). The
  commit-back is `packages/processor/job/commit-back.sh`, which the step
  calls; a test runs the step's real shell, and so the script, against
  scratch repositories. Not covered: a single
  file deleted by hand inside an article the run changed, which aborts the
  rebase and is redone next run.
- **An article too long to process in one run**: translation is checkpointed
  per batch and the processor stops on its own budget with time left to commit,
  so successive runs converge instead of each restarting from batch 1
  (ADR 0008). `timeout-minutes` is a backstop above that budget, and the commit
  step runs `if: always()` so even a kill keeps the run's work. Off Actions
  `run.sh` keeps both promises itself: `timeout` stops the processor first, the
  commit runs after it whatever its exit, and a run the host killed outright
  is committed by the next one to start (ADR 0046). Ordering pending articles
  cheapest-first stops one such article from starving the rest.
- **Expiring fine-grained PATs** (four kinds: `TIRO_DISPATCH_TOKEN`,
  `VAULT_READ_TOKEN`, an extension PAT per machine, and the phone's). Give the
  phone's the extension's expiry date, so one reminder covers both. A weekly
  `tokens.yml` in each repo fails 30 days before a workflow token expires, and
  the extension's Test connection shows its own (ADR 0032).
- **Pagefind index only exists after a build**: the search UI degrades
  gracefully in `astro dev`.
- **Cloudflare Pages 25MB/file cap**: the asset copy step skips and warns on
  oversized files (the processor already caps downloads at 10MB).

## Decision log

See [`docs/adr/`](./adr/) for the individual decision records.
