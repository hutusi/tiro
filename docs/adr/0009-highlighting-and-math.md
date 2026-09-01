# ADR 0009: Syntax highlighting and math — generated after sanitization, gated per article

Status: accepted (2026-09)

## Context

The site rendered neither. Fenced code arrived as a flat `<pre><code>` on one
hardcoded background, and `$$E = mc^2$$` reached readers as those literal
characters. Both are basic expectations for the technical writing this vault
mostly holds.

Two constraints make the obvious implementation wrong here.

**The site is fully public and its input is hostile.** Every article body is
HTML scraped from an arbitrary page, so it passes `rehype-sanitize` before
rendering (invariant 5). The installed default schema allows `className` on
`code` only for `/^language-./` and allows `class`/`style` on nothing else —
which is exactly what Shiki and KaTeX emit. Making their output survive by
widening the schema would also hand every clipped page arbitrary inline CSS and
class names on the public site, for the sake of markup we generate ourselves.

**Math was never really captured.** ADR 0003 records an arXiv paper that lost
all 364 blocks of its translation because Turndown flattened MathML into text,
leaving a paragraph whose last line was a lone `=` — a setext heading. Nothing
downstream can render math that the clipper destroyed, so rendering support is
only half the change.

A third problem was latent in the block contract: `splitBlocks` parsed with
remark-gfm alone, so display math containing a blank line split into two
`paragraph` blocks. Since blocks render in isolation, neither half could ever
be typeset, and the translator received two orphaned half-delimited fragments.

## Decision

- **Shiki for code, KaTeX for math**, both run at build time. Shiki is already
  in the lockfile via Astro. A synchronous highlighter
  (`createHighlighterCoreSync`) keeps `render.ts` on `processSync`, so nothing
  downstream has to become async.
- **Both run *after* `rehype-sanitize`, not before.** Untrusted HTML is scrubbed
  first; Shiki and KaTeX then act as trusted generators over plain text nodes,
  emitting markup that was never attacker-authored. Shiki escapes every token it
  emits, and KaTeX's default `trust: false` disables `\href`, `\htmlClass`, and
  `\includegraphics`. The sanitizer's allowlist therefore never widens to
  accommodate them, and `allowDangerousHtml` stays where invariant 5 put it —
  on `remarkRehype` only. The single schema addition is two class *markers*,
  `math-inline` and `math-display` on `code`, without which `rehype-katex`
  running post-sanitize could not tell inline math from display math.
- **Unknown code languages fall back to plaintext**, never throw. Info strings
  come from arbitrary web pages; one exotic value must not fail the site build.
- **Math is gated per article, defaulting to display-only.** `remark-math` with
  its defaults reads `$` as a math delimiter everywhere, so "it costs $5 to $10"
  becomes a formula. Only articles flagged `has_math` enable single-dollar
  inline math. Everything else — including every article clipped before this
  landed — is rendered with `singleDollarTextMath: false`, which still typesets
  `$$…$$` and can never misread prose. The default is deliberately not "math
  off": it costs nothing and needs no reprocessing to benefit.
- **`has_math` means the article's dollar signs are curated, not that it
  contains maths.** The first version of this decision made the flag mean the
  latter, and it was the wrong shape: a flag saying "there is a formula
  somewhere" was used to switch the parser for the whole document, so any
  article that was *both* a maths article and a prose article broke — "the API
  costs $5 to $10 … $O(n^2)$" typeset `5to` as a formula. A document-wide switch
  cannot answer a question that is per-occurrence.
  So the clipper, which is the only component that sees the DOM and can tell a
  price from a formula, escapes every literal `$` in the prose when it recovers
  math, and sets the flag to record that it did. `has_math: true` then states
  something enforceable: every *bare* `$…$` in this file is a formula. The flag
  is read from the HTML that survives Readability, not from the page, so a
  formula discarded with a sidebar cannot set it. Nothing else may set it —
  in particular the processor must not infer it from an already-clipped body,
  because it cannot establish the escaping guarantee.
- **The translator never sees LaTeX.** Each inline formula is replaced by an
  opaque token before a block is sent and restored afterwards; if a token does
  not round-trip, the block reverts to its original. A prompt asking the model
  to leave LaTeX alone is not a guarantee, and a mangled formula passes every
  structural gate — the block still parses as one paragraph, so alignment is
  satisfied and wrong mathematics publishes silently. One untranslated
  paragraph is the better failure, and it is the trade ADR 0003 already makes.
- **An unclosed `$$` is prose, not math.** micromark runs an unterminated math
  fence to the end of the document, exactly as it does an unterminated code
  fence. That is almost never what a line beginning `$$` means in prose — "$$
  is the shell's PID", "$$10 for the basic plan" — and left alone it swallows
  the rest of the article into one verbatim block that is never translated and
  renders as a single red error. `splitBlocks` re-reads such a fence with a
  math-free parser; renderers escape it.
- **The clipper recovers TeX before Readability runs**, normalizing KaTeX,
  MathJax, and MathML (`annotation[encoding="application/x-tex"]`, then
  `<math alttext>`, then MathJax v2's `script[type="math/tex"]`) into a single
  marker element that a Turndown *rule* converts to `$…$` / `$$…$$`. It must be
  a rule: Turndown's text escaping rewrites `\` and `_`, which would destroy
  every formula. Math with no recoverable TeX source is dropped rather than
  flattened — losing a formula beats poisoning the document's block structure,
  which is the ADR 0003 failure.
- **`math` becomes an alignment-protected block type.** `splitBlocks` parses
  with `remark-math`, so display math is one block the way fenced code already
  is; `checkAlignment` requires `math` blocks to be byte-identical between
  original and translation; and the processor never sends them to the LLM.
- **`tiro.schema` stays at 1.** `has_math` is optional, and a Zod object strips
  unknown keys rather than erroring, so the change is compatible in both
  directions: an old article simply lacks the field, and an old reader tolerates
  a new file. ADR 0002's bump is for breaking document-format changes; this is
  not one.
- **Display math is a top-level construct.** Nested inside a table cell, list
  item, blockquote or heading, a recovered formula is emitted inline instead. A
  `$$` block in a table cell has its newlines turned into `<br>` by the GFM cell
  rule and is then typeset literally; inside a list the enclosing block is a
  `list`, not a `math`, so it is not verbatim and the formula reaches the
  translator unprotected. Inline math is protected everywhere, so degrading to
  it is strictly safer than either.

## Consequences

- The sanitizer's allowlist stays as narrow as it was, and stays the *only*
  thing standing between clipped HTML and readers. Any future renderer that
  emits its own markup belongs after it, for the same reason.
- Ordering is now load-bearing and easy to break by accident: moving Shiki or
  KaTeX before the sanitize step would silently strip all their output, and
  "fixing" that by widening the schema would reopen the hole. Invariant 5 names
  the ordering for that reason.
- Display math containing a blank line renders and translates correctly for the
  first time. An already-processed article whose original contains block-level
  `$$` may now segment differently from its stored `zh.md` and fail alignment —
  which degrades to the existing stacked rendering, not to breakage, and is
  fixed by reprocessing.
- Articles clipped before this get display math but not inline math until
  re-clipped. Setting `has_math: true` by hand is a supported override, but it
  is a promise about the file: any literal `$` in its prose must be escaped in
  the same edit, or the flag will make prices render as formulas.
- Escaped dollars appear in the vault markdown of maths articles. This is
  standard markdown — it renders as a literal `$` anywhere — which is why it was
  preferred over writing inline math as `$$x$$`, a form that would have made the
  gate unnecessary but would render as a display block in every other tool.
- Math that a page renders without shipping its TeX source (some MathJax v3
  configurations) is dropped. Converting presentation MathML back to LaTeX would
  recover it and is deliberately deferred.
