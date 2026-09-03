# ADR 0012: A code block's language has four sources, in order of trust

Status: accepted (2026-09)

Extends [ADR 0009](0009-highlighting-and-math.md) (highlighting and math). It
does not reverse it: Shiki still runs after `rehype-sanitize`, and the grammar
list is still curated. This records where the *language* comes from, which 0009
assumed was simply present.

## Context

Every code block on the site rendered as plain text, and the reason was not the
highlighter. Shiki has been wired in and working since 0009 — the live pages
emit `<pre class="shiki github-dark-dimmed">` on every block. What was missing
was the language: **all 40 fences in the vault were bare**, so every block
resolved to `plaintext`.

The clipper's detection chain was not at fault either. It reads `language-*`,
`lang-*`, `highlight-source-*`, Pandoc's `sourceCode`, SyntaxHighlighter's
`brush:`, and four `data-*` spellings, and `02e8a20` carries the result across
Readability. On the pages that matter it had nothing to read:

| Source | Fences | What the DOM says |
| --- | --- | --- |
| `claude.com/blog` | 13 | `<code class="language-bash">` — handled; that clip simply predates the chain |
| `platform.claude.com/docs` | 15 | `<pre class="shiki shiki-themes github-light-default dark-plus">` — no language; a tab reads `Python` |
| `blog.cloudflare.com` | 8 | the same Shiki output, and no label anywhere on the page |
| `lilianweng`, three others | 4 | bare `<pre>` |

The mechanism is worth stating plainly because it will keep happening: **the
tool we highlight with is the tool that erased the information upstream.** Shiki
emits theme names and inline token colors and no language id, and it is now the
default for docs sites and engineering blogs. Class-based detection degrades as
Shiki adoption grows.

The second fact shapes the design more than the first. **Sixteen of those 40
fences are not code.** They are English prose — LLM prompt snippets the source
author fenced for display. On the reported article 14 of 15 are. So the
expensive failure here is not a block left plain; it is a paragraph of English
painted as Ruby.

## Decision

A fence's language comes from the first of these that answers:

1. **Markup the page wrote** — the existing chain in `dom-prepare.ts`.
2. **Chrome the page wrote for a human** — a tab strip's selected tab, a header
   naming `src/main.rs`. Resolved through allowlists in
   `@tiro/shared/languages.ts`, never through a pattern.
3. **Inference from the code text** — `apps/site/src/lib/detect-language.ts`,
   at build time, high confidence only.
4. **Plain text** — unchanged.

Layers 1 and 2 write into the vault. Layer 3 never does.

### Why inference is at render time and not at clip time

This is the load-bearing choice. A language written into the vault is
permanent — the clipper does not revisit content it has written, so a wrong
guess costs that block its highlighting for as long as the article exists, and
the only repair is a hand edit. A language decided at build time costs one build
and is reversible by editing one file.

That is the right asymmetry for an answer that is a guess, and it is the same
argument `dom-prepare.ts` already makes about reading `data-lang` off a
container: "the wrong language is written into the vault permanently". Reading a
*stated* label is a different act from inferring one, and only the first is
allowed to persist.

### Why the label readers are allowlists

The text sitting where a language name sits is very often not a language.
`Copy`, `Output`, `Response`, `Request`, `Terminal`, `Example` all appear in
exactly that position in real code-block chrome. `LANG_TOKEN` — the existing
regex, `^[a-z0-9][a-z0-9+#._-]{0,19}$` — accepts every one of them. So chrome
reading resolves through a map of known languages and filenames, and an
unrecognised label yields nothing at all.

Cloudflare is the standing illustration: its pages carry
`class="language-trigger"` on the site's *human*-language switcher. Nothing
reaches it today only because it sits 360 KB from any `<pre>`, which is what the
two-ancestor cap on `CONTAINER_LANG_PATTERNS` buys.

### Why inference fires only on a positive signature

There is no "reject prose" test, because there does not need to be one. Nothing
fires unless a rule matches, so prose falls through to plain and renders exactly
as it does today. Every rule is anchored to line starts or to punctuation prose
does not produce, and most require two independent signals: one match is a
coincidence, two are a language.

Two orderings inside that are load-bearing, and both were found by the corpus
rather than by reasoning:

- **Code signatures run before markdown and YAML.** `# ` is a heading in one
  language and a comment in Python and shell — without this, the reported
  article's 85-line Python block was read as markdown off its own comments.
- **Markdown runs before YAML.** A spec's `Author: J. Ortiz. Status: draft.` is
  a mapping to any test that has not first asked whether the block has headings.

### Backfill re-clips rather than re-scans

`sweep --fill-languages` recovers labels for fences already committed by
re-clipping the page through `clipPage` and copying the info strings that come
back — not by scanning cached HTML for hints itself. A second scanner is a
second opinion that drifts from the shipping clipper, which is the argument
`clip-page.ts` already makes about the three copies of the pipeline it deleted.

It rewrites `index.md` and `zh.md` together or neither. `checkAlignment`
compares a code block's source slice with its fence lines included, so a
language written into `index.md` alone breaks byte-identity — and a misaligned
article does not render wrong, it silently stops rendering side by side at all
(ADR 0003).

## Consequences

- The vault gains 14 labels from layers 1–2 without a re-clip; inference covers
  about 10 more; the remaining 16 are prose and correctly stay plain.
- Built against the live vault, the site goes from **0 coloured tokens to 2684**.
- `detect-language.ts` is a heuristic and will be wrong eventually. The cost is
  bounded to one build, and `apps/site/test/fixtures/code-blocks/` — all 40 real
  blocks with their expected answers, `plain` included — is where a regression
  shows up.
- The grammar list in `highlight.ts` now has to cover what the detector can
  return; `bibtex` was added for exactly this reason.
- Adding a language means three edits: a grammar import in `highlight.ts`, an
  entry in `languages.ts` if pages name it in chrome, and a signature in
  `detect-language.ts` if it should be inferable.

## Alternatives considered

**`highlight.js`'s `highlightAuto`.** Covers ~200 languages against a
hand-rolled detector's dozen. Rejected because its relevance scores are
unnormalised — they grow with block length — so the threshold that separates
code from prose is length-dependent, and separating code from prose is the whole
problem here, not an edge case. The corpus is half prose.

**Inferring in the clipper and writing the guess to the vault.** Rejected on the
permanence argument above.

**Asking the LLM to label bare fences during processing.** Cheap in tokens, and
it would put the answer in the vault where it is auditable. Rejected because
code blocks are `VERBATIM_BLOCK_TYPES` and the processor never sends them to the
model — making it do so for a label would put the one class of content that must
survive byte-identically onto the path most likely to alter it.
