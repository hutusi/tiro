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
3. **Inference from the code text** — `packages/shared/src/detect-language.ts`,
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

That promise is easy to write and easy to break, and it was broken in four
places before review caught it. `select … from` plus `create table` matched
*"Select a source from the list. Then create table rows for each item."*;
`: number` plus `such as string` matched another sentence; `import duties` plus
`print(the contract)` matched a third; and `FROM users` in a SELECT was read as
a Dockerfile, because `FROM` sat among the single-match rules where a base image
and a SQL clause are indistinguishable. Each was an unanchored keyword in a file
whose comment claimed there were none.

### Markdown is not inferred, by decision

`# ` opens a heading in markdown and a comment in shell, and nothing inside a
block settles which. Three rules were tried across four review rounds — two
headings; then two *different* heading depths; then depth joined by a sentence —
and each was defeated by a four-line script within a round. The last fell to
`echo This command installs every required package.`, because full stops are a
habit of prose rather than a property of it.

The only version that could not be defeated required two list items, which a
script does not write — and it missed a real spec document in the vault with six
headings and no lists. Rather than take that trade or keep patching, **markdown
inference was removed**, and the frontmatter rule with it, though frontmatter
was never implicated.

The cost is recorded because it is not zero:

- Seven vault blocks that are genuinely markdown now infer to nothing. All seven
  already carry an explicit fence language from the clipper or the backfill, so
  the rendered site is unchanged — but a future clip of a markdown block with no
  stated language will render plain.
- **The backfill's conflict guard is narrower.** Three of the four real
  mislabels it caught on `claude.com/blog` were markdown documents tagged
  `javascript`; with nothing to disagree with, those would now be written
  through. It still catches the fourth, and every conflict an inferable language
  can raise.

### SQL is built on operands, not keywords

SQL's keywords are ordinary English verbs, so position cannot separate them:
"Select a source from the list" begins a line as readily as a query does. Two
rules failed here — one anchored to line starts, one vetoing full stops — and
the second died the moment the punctuation was dropped.

What separates them is what follows the keyword. English puts an article after
`from`; SQL puts an identifier. English does not write a typed column
definition, a `VALUES (…)` tuple, or `= true`. The rule is built from those, and
the general lesson is the one this file kept failing: **a rule must be made of
what the other side cannot produce, not of what it usually does.** Punctuation
frequency, sentence length and heading depth are all the second kind.

The guard against the next one is not another regression test but
`detect-language.test.ts`'s prose table: one English paragraph per language,
seeded with that language's own keywords, asserted to return `null`. It is the
test the claim deserves, and it catches this whole class at once — it found the
Python case on its first run.

Two orderings inside that are load-bearing, and both were found by the corpus
rather than by reasoning:

- **Code signatures run before markdown and YAML.** `# ` is a heading in one
  language and a comment in Python and shell — without this, the reported
  article's 85-line Python block was read as markdown off its own comments.
- **Markdown runs before YAML.** A spec's `Author: J. Ortiz. Status: draft.` is
  a mapping to any test that has not first asked whether the block has headings.
  (Markdown was later removed — see below — but the heading guard stays in
  `isYaml` for exactly this reason.)

### Backfill re-clips rather than re-scans

`sweep --fill-languages` recovers labels for fences already committed by
re-clipping the page through `clipPage` and copying the info strings that come
back — not by scanning cached HTML for hints itself. A second scanner is a
second opinion that drifts from the shipping clipper, which is the argument
`clip-page.ts` already makes about the three copies of the pipeline it deleted.

Where an article has a translation, it rewrites `index.md` and `zh.md` together
or neither. `checkAlignment` compares a code block's source slice with its fence
lines included, so a language written into `index.md` alone breaks byte-identity
— and a misaligned article does not render wrong, it silently stops rendering
side by side at all (ADR 0003). An article with no `zh.md` has nothing to keep
in step and only `index.md` is written.

Both files are written whole to temporaries and then renamed, so a torn write
cannot leave one corrupt and a failure mid-run cannot leave the pair
disagreeing. The window between the two renames is left open deliberately: no
I/O happens in it, and the recovery for a local tool writing to a git
repository is `git checkout`, not a journal.

### A stated label the page got wrong

The precedence above assumes a page that states a language is right about it.
The first real backfill disproved that: `claude.com/blog` mislabels **4 of its
own 13 blocks** — a markdown document tagged `javascript` (twice), an agent
skill file tagged `javascript`, a GitHub Actions step tagged `markdown`. That is
what a per-block language dropdown in a CMS produces, and it is not rare.

Rendered, the markdown document tagged `javascript` colours `-` as a minus
operator and `test` as a function call. Worse than plain, and permanent once
written.

So the backfill — and only the backfill, not the clipper — cross-checks a
declared label against the inference and **leaves the fence bare when they
disagree**, reporting it for a human. Aliases are normalized first, so `ts`
against `typescript` is not a disagreement, and an inference of `null` is no
opinion rather than a contradiction. The clipper keeps writing what the page
says at clip time: it has no inference to check against, and the site's
inference will not fire on a fence that carries a label anyway.

The asymmetry is the same one that puts inference at render time. Precedence
decides what to *believe*; this decides what to make *permanent*.

## Consequences

- The vault gains 14 labels from layers 1–2 without a re-clip — 10 written by
  the backfill and 4 corrected by hand after it flagged them. Inference covers
  about 10 more at build time; the remaining 24 return nothing — 17 prose, 7
  markdown by the decision above.
- Built against the live vault, the site goes from **0 coloured tokens to 2686**.
- `detect-language.ts` is a heuristic and will be wrong eventually. The cost is
  bounded to one build, and `packages/shared/test/fixtures/code-blocks/` — all 40
  real blocks with their expected answers, `plain` included — is where a
  regression shows up.
- The grammar list in `highlight.ts` now has to cover what the detector can
  return; `bibtex` was added for exactly this reason.
- Adding a language means three edits: a grammar import in `highlight.ts`, an
  entry in `languages.ts` if pages name it in chrome, and a signature in
  `detect-language.ts` if it should be inferable.
- The detector lives in `@tiro/shared` rather than in the site because the
  backfill needs it too, for the guard below.
- **One vocabulary for fence languages.** `canonicalLanguage` in
  `languages.ts` is what both the site's `languageFor` and the backfill's
  conflict check resolve through. They had separate tables briefly, and
  `shell-session` resolved in one and to nothing in the other — so a fence the
  renderer understood was reported as disagreeing with its own inferred
  language. Two readers of one string must share a vocabulary or every alias
  looks like a dispute. `languageFromLabel` stays separate and conservative: it
  reads untrusted *human* chrome, where the allowlist is the safety property.

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
