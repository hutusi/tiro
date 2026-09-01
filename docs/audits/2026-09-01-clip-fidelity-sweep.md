# Clip-fidelity sweep — 2026-09-01

Comparison of every published article against the page it was clipped from, grouped by publisher
family. **Catalogue only — nothing was fixed in this pass.**

## Scope and method

**All 32 articles.** The first pass covered 30; the two re-clips (`arxiv…2608-23691`,
`newsletter-powderworks…`) were swept after their vault runs converged —
`tiro-process validate` now reports **32 articles / 0 errors**, 0 pending.

Three channels, because the two approaches already tried are spent: a markdown signature scan can
only re-find defects someone already named, and render-only checks over `dist` find nothing. Adding
the **source page** is what makes an unnamed defect findable.

- **A — source skeleton vs. rendered skeleton.** Source body extracted with the same
  `@mozilla/readability` the clipper uses, so the baseline is apples-to-apples; both sides reduced to
  comparable HTML skeletons (headings, images, tables, `pre`, blockquotes, figures, `sup`, embeds)
  and diffed. The rendered side reads the `.pane-original` panes of the live site.
- **B — rendered page vs. markdown.** The decisive check is rendered `<img>` count vs. `![` count in
  the vault markdown.
- **C — browser pass** on ranked candidates, which also unblocked the two gatesnotes pages (they
  return 403 to `curl`).

30 of the 32 were clipped **before** extension 0.7.0. The two re-clips are the only 0.7.0 articles,
and they are the control group: they score **0 on every legacy defect class** — no boilerplate, no
anchor-`#` headings, no orphan brackets, no empty table headers, no indented non-list content, no
empty image refs. Where a pre-0.7 article shows one of those, "re-clip and re-measure" is now an
evidence-backed first move rather than a guess.

## Two calibration rules

These cost real effort to learn and should survive into the next sweep.

1. **Raw word-count ratio is not a truncation signal.** Naive text extraction counts Blogspot
   sidebars and Apple nav chrome, which made `muratbuffalo` (0.28) and `apple` (0.16) look severely
   truncated. Both are faithful. With Readability-extracted baselines every article lands at
   **92–108%** of source. *There is no truncation anywhere in the corpus.*
2. **Indentation is only a defect out of list context.** 4-space-indented content becomes a code
   block — but legitimately-nested list continuations look identical to a grep. `swyx/create-luck`
   (indented blockquotes) and `arxiv…2404` (indented display math) are both correct nesting.

## Symptom taxonomy

| Class | Origin | What the reader sees |
| --- | --- | --- |
| `IMG-AS-CODE` | render | Image markup displayed as literal text in a code block |
| `CODE-FLAT` | clip | A code block reflowed as proportional-font prose |
| `CODE-AS-TABLE` | clip | A code block rendered as a table, gutter line numbers as column 1 |
| `FIG-SEMANTICS` | clip | `<figure>`/`<figcaption>` lost; caption becomes ordinary body prose |
| `FN-REF` | clip | Footnote reference collapses to a bare digit glued to the sentence |
| `FN-INLINE` | clip | Footnote *body* inlined mid-sentence, interrupting the text |
| `ALT-PLACEHOLDER` | clip | Every image alt reads `Refer to caption` |
| `ANCHOR-HASH` | clip | Every heading ends in a stray permalink `#` |
| `CITE-DROP` | clip | Citation elements vanish, leaving orphan `) ,` spacing |
| `EMBED-LOSS` | clip | A content video disappears with no placeholder |
| `IMG-LOSS` | clip | In-body images missing relative to source (lazy-load race) |
| `TABLE-DROP` | Readability | Data table pruned; its caption is left stranded on the page |
| `DUP-IDENTITY` | product | Same essay stored twice under two URLs |
| `BOILER` | clip | Subscribe/share/"opens in new window" text inside the body |

Attribution matters: `FIG-SEMANTICS`, `FN-*`, `CITE-DROP` and `EMBED-LOSS` all trace to the same
root — **there is no post-Readability cleanup and no Turndown rule for these elements**
(`apps/extension/src/clipper.ts:25-37` goes straight from `parse()` to `htmlToMarkdown()`).

`TABLE-DROP` is the one class no Turndown rule can reach: the content is gone **before** Turndown
runs. The architecture already has the right seam for it — `prepareForClipping` runs *pre*-Readability
precisely so pruning cannot destroy structure, which is why `unwrapEquationTables`
(`dom-prepare.ts:167`) lives there. A `preserveDataTables` pass belongs in the same place.

## Ranked candidates

### 1. `unsung-aresluna-org-i-just-chose-words-carefully` — critical, article destroyed
`IMG-AS-CODE`. All five images are indented 4 spaces outside any list, so they render as
Shiki-highlighted code blocks showing literal `![](/vault-assets/…)`. The live page has **zero
`<img>`**; the blocks also overflow their pane. This is a visual essay about monospace typesetting in
which the images *are* the argument — the article is entirely non-functional.
Source has 5 `<figure>`, 0 `<pre>`; rendered has 0 `<img>`, 5 `<pre>`.

### 2. `gatesnotes` ×2 — duplicate identity plus catastrophic image loss
`DUP-IDENTITY` + `IMG-LOSS`. The same Bill Gates essay is stored twice, clipped 11 seconds apart
under two nav paths both ending `a-turbulent-ai-era-and-critical-choices-to-make`. The source page
carries **15 substantial in-body images**; the `work/` clip captured **0**, the `home/` clip **10**.
166 of 221 images use `loading="lazy"` + `srcset`, so this is a **clip-time lazy-load race** — the
clipper serialises whatever is in the DOM at click time. The two clips also disagree on title, and
the live page now serves the `home/` title at the `work/` URL.

### 3. `arxiv…2608-23691` — three tables dropped, captions left stranded
`TABLE-DROP`. The paper has three numbered data tables. **All three captions render; none of the
tables do.** On the live page "Table 1: Summary of the Station's rooms and their functions." and
"Table 2: Important findings by the Station." sit back-to-back as bare paragraphs, then the text
runs straight into `## 3 Results`. The body makes **9 cross-references** to them (Table 1 ×4,
Table 2 ×3, Table 3 ×2) that now point at nothing, and the translator faithfully reproduced the
orphaned captions as 表1/表2, so Chinese readers see the same phantom tables.

Attribution is Readability, not the clipper: `AlphaEvolve Problem 6.1` appears 4× in the raw HTML
and **0×** in Readability's output, before Turndown runs. Only one table in the whole document
survives (the unnumbered Construction / Touching-pairs table). Also carries `ALT-PLACEHOLDER`
(2 of 2 images alt=`Refer to caption`).

### 4. `arxiv…2404-19756` (KAN) — three overlapping defects
`ALT-PLACEHOLDER` (19 of 19 images alt=`Refer to caption`), `FN-INLINE` + `FN-REF` (12 source `<sup>`
render as none; LaTeXML puts the mark and the footnote body adjacent inline, producing
`…\approx 0$ 11 1 This is done by drawing B-spline coefficients…` mid-sentence), and
`FIG-SEMANTICS` (32 figures flattened; the 16 `Figure N.M:` captions survive only as plain
paragraphs).

### 5. `simonwillison…understanding-chatgpt-work` — two independent defects
`CODE-FLAT`: the JavaScript example renders as a proportional-font `<p>`, wrapped as prose
(`preInPane: 0`). Because it is a paragraph rather than a code block, `VERBATIM_BLOCK_TYPES` no
longer shields it from the translator. `ANCHOR-HASH`: **14 of 14** headings end in a visible red `#`.
Also 5 `BOILER` hits.

### 6. `blog-lyc8503…dn42-2-dnet` — code block rendered as a table
`CODE-AS-TABLE`. A 26-line `dig` transcript renders as a 1-row, 2-cell table with 50 `<br>`s: line
numbers in column 1, output in column 2, **in proportional font**, line numbers misaligned against
wrapped rows, and one URL auto-linked. The theme is Chroma-like but not `table.lntable`, so
`unwrapChromaTables` (`dom-prepare.ts:248`) does not catch it.

### 7. `FIG-SEMANTICS` — systemic, 12 of 32 articles
`arxiv…2404` (32), `kuleshov` (30), `arxiv…2608` (22), `lilianweng` (18), `cloudflare` (9),
`greenlightning` (9), `powderworks` (8), `apple` (7), `unsung` (5), `claude.com` (4), `betonit` (1),
`lyc8503` (1). It is the **only** defect class the 0.7.0 clipper still reproduces. Every `<figure>` becomes a
bare image plus a paragraph; captions are indistinguishable from body prose. Worst in `kuleshov`,
where a caption ending "Figure credit: M. Grootendorst & Gemma Diffusion." runs straight into the
next body paragraph.

### 8. `FN-REF` — 4 articles, 3 different markup styles
`calv.info` (`<sup><a href="#footnote-fn-1">1</a></sup>`), `brennan.day`
(`<sup class="footnote-ref">[1]</sup>`), `apple` (plain `<sup>1</sup>` → `…memory bandwidth.1`),
`arxiv…2404`. `paulgraham` is the same class via a different path: refs and definitions survive as
escaped `\[1\]` text, and per-block rendering means they can never link.

### 9. `kuleshov` — citations dropped
`CITE-DROP`. Distill `<d-cite key="…">` elements vanish, leaving `(Inception Labs) ,` with a space
before the comma, throughout a heavily-cited academic post. The elements are JS-populated and empty
in the served HTML, so no clipper change recovers the text — but the orphan spacing is fixable.

### 10. `schlarp` — content video lost
`EMBED-LOSS`. `<video src=led-before-after.mp4 poster=led-before-after.jpg>` — a before/after LED
demo, the payoff of a DIY post — is dropped silently, poster frame included.

## Non-findings — do not re-investigate

- **No truncation anywhere.** All 32 land at 92–108% of the Readability-extracted source
  (`arxiv…2608` 98%, `powderworks` 101%).
- **The 0.7.0 re-clips are clean on every legacy class.** Both score 0 for boilerplate, anchor-`#`
  headings, orphan brackets, empty table headers, indented non-list content and empty image refs.
  `arxiv…2608` has **0 `ltx_note`** in source, so the `FN-INLINE` leak that afflicts 2404 is
  impossible there; it renders **518 KaTeX formulas with 0 errors** and **106 display-math blocks**.
- **`powderworks` having 0 headings is faithful** — the source has 0 headings too. A 13k-word
  article with no headings looked like a defect and is not one. Its `code` 12→11 delta is one inline
  span out of 22 in the raw page: noise, not a finding.
- **No misalignment, no KaTeX errors.** Zero stacked-fallback articles; `arxiv…2404` renders **873
  KaTeX formulas with 0 errors**.
- **arXiv 2404's 50→7 table delta is correct.** 43 of the 50 source tables are LaTeXML equation
  tables (`ltx_eqn_table`); `unwrapEquationTables` converts them to display math by design. All 7
  real `ltx_tabular` data tables render. The superficially identical 51→1 delta on **2608 is not
  benign** — see candidate 3. The two look the same in a count and differ entirely in cause, so
  always separate `ltx_eqn_table` from `ltx_tabular` before drawing a conclusion.
- **Class-based filtering of Readability output does not work.** Readability defaults to
  `keepClasses: false`, so `ltx_tabular` is absent from its output whether or not the table survived.
  Probe by distinctive **cell text**, and pick a needle that cannot also occur in prose — two of my
  first three probes matched body text elsewhere and produced a false "table survived" reading.
- **arXiv indented math is correct** — it sits inside numbered-list items and renders as KaTeX. An
  earlier reading of this as "math rendering as a code block" was wrong.
- **`gatesnotes-home` is not missing tags/category** — both are present at lines 22-23. An earlier
  claim to the contrary came from a truncated `head -20`.
- **swyx indented blockquotes** are legitimate list nesting.
- **`dwarkesh` `\[Excitement\]` brackets** are real transcript text.
- **3 of 4 embeds are correctly dropped**: a GTM tracking iframe (`12factor`), a decorative hero
  video (`claude.com`), a Substack subscribe box (`muratbuffalo`).
- **`inventati` heading mismatch is source drift** — it is a homepage that changed after clipping,
  not a clip defect.
- **Metadata is uniformly complete**: all 30 have `lang`, `tags` and `category`; no
  `readability_failed`. Separately, `published_at` is declared at
  `packages/shared/src/frontmatter.ts:41` but written by nothing and read by nothing — a dead field.

## Suggested fix order

1. `unsung` — one article, total loss, and the root cause is unknown; diagnose first.
2. `FIG-SEMANTICS` — one Turndown rule, 10 articles.
3. `FN-REF`/`FN-INLINE` — one rule family, 5 articles, most-cited content.
4. `ANCHOR-HASH` and `CODE-FLAT`/`CODE-AS-TABLE` — narrow, per-theme.
5. `gatesnotes` — decide the duplicate, then re-clip to beat the lazy-load race.
6. `TABLE-DROP` — needs a pre-Readability `preserveDataTables` pass in `dom-prepare.ts`; a
   post-Readability rule cannot reach it. Affects `arxiv…2608` today and any table-heavy paper next.

**Re-clipping is now a measured remedy, not a hope.** The two 0.7.0 clips clear every legacy class,
so items 3–5 below the systemic ones are largely "re-clip and re-measure". `FIG-SEMANTICS` is the
exception — 0.7.0 still reproduces it, so it needs a code fix.
