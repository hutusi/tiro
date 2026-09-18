# ADR 0025: Emphasis in CJK text

Status: accepted (2026-09).

## Context

Half the library rendered its italics as punctuation. On
`tiro.ainaive.com/articles/tornikeo-com-code-is-debt-d2265469/` the English pane
read "Which company is *better off*?" and the Chinese pane read
"哪家公司\_处境更好\_？", underscores and all. Nothing was wrong with the
renderer: both panes run the same pipeline, and the markdown itself was
unreadable — in two unrelated ways.

**Intraword `_`.** CommonMark will not read `_` as an emphasis delimiter between
two word characters, so that `snake_case_name` stays one word. CJK ideographs
are word characters by that definition — neither whitespace nor Unicode
punctuation — and Chinese prose has no spaces to separate them, so
`细节_真的_很重要` is two literal underscores. `*` carries no intraword rule.
Measured over the live vault: 383 spans in 67 of 134 translations.

The source of the `_` is the clipper. Turndown's default `emDelimiter` is `_`,
which costs nothing in English, where a space always flanks the delimiter, and
everything downstream: the translator faithfully mirrors whichever delimiter it
was given.

**A span whose edge is CJK punctuation.** `**事实上，**` does not close either.
The `，` inside the span is Unicode punctuation and the character outside it is
not whitespace, so the closing run is not right-flanking. Around 85 more spans,
and no delimiter choice can express them — `*事实上，*` fails identically. This
one is the model's own punctuation placement, not the clipper's.

## Decision

Fix the first class in the content and the second in the parser.

1. The clipper writes `*` (`emDelimiter: "*"`), so the defect stops at the
   source and the translator mirrors a delimiter that works.
2. `normalizeCjkEmphasis` (`@tiro/shared`) rewrites `_x_` to `*x*` where the
   parser refused it next to CJK. The processor applies it to every translated
   block as it is recorded, and `tiro-process repair` applies it to the vault.
3. The site and `@tiro/shared` parse with `remark-cjk-friendly` — the proposed
   CommonMark amendment for CJK, byte-identical to CommonMark 0.31.2 for any
   input without CJK.

The normalizer is parser-driven rather than a scan over the source, and that is
the whole safety argument: **an underscore that survives into an mdast `text`
node is by construction a delimiter the parser refused.** Successful delimiters
are never part of text, so working from text-node ranges puts code spans, fenced
code, math, raw HTML and link destinations out of reach without a rule for each.
Deciding *which* of those refused delimiters were meant as emphasis needs a
second rule, because `*` works inside a word where `_` does not: "would it parse
after the swap?" would happily turn `fire_and_forget` into italics. The rule is
that **this repair only ever cures CJK adjacency**, so a span with no CJK letter
immediately outside either delimiter is left alone whatever else is wrong with
it — which is what tells `my_报告_draft` from `细节_真的_很重要`. Given the
adjacency, two ways for it to be the whole story: CJK *inside* the delimiters
settles it, since no identifier is a fragment of CJK text (and the obstacle is
then on the inside edge, where no substitution outside could lift it); otherwise
the content is Latin, and the pair is a repair only if replacing the CJK letters
just outside with spaces makes `_x_` emphasis. What follows the closing run is
then doing the separating — punctuation in `一个_tick_（时刻）`, a word character
in `中文_file_name` — which is CommonMark's own intraword rule read on the Latin
side. Delimiter runs are matched whole, so `__强调__` becomes `**强调**` rather
than being half-rewritten. Every rewrite is checked afterwards — same blocks,
same rendered text bar the delimiters — and retried one span at a time if the
whole-body swap does not hold.

One boundary is left ambiguous on purpose: `用户_信息_table` is repaired and
`my_报告_draft` is not, and the only difference is the CJK character in front.
An identifier can look like either, so this follows the corpus — a delimiter
that ran into CJK is overwhelmingly prose, and the alternative would lose
ordinary sentences like `不会_少于_8个月`.

## Consequences

- **The two classes are fixed in different places on purpose.** Content, where
  the markdown can say what it means; the parser, where it cannot. Fixing the
  second in content would mean moving the author's punctuation outside the
  delimiters, which is an edit to what the article says, not a repair of how it
  is spelled.
- **`@tiro/shared` parses the same dialect as the site**, not strict CommonMark.
  The contract has to read an article the way its reader sees it; otherwise
  `plainText` keeps a stray `**` in an excerpt the site renders as bold. Inline
  emphasis cannot move a block boundary, so alignment is unaffected — verified
  block-for-block across every file in the vault. It costs ~36 KB in the
  extension bundle, which already carries micromark.
- **The vault is repaired, including the checkpoints.** `.tiro-zh-cache.json`
  holds the same Chinese text keyed by its English block, and a later `--force`
  or re-clip rebuilds `zh.md` from it, so a repair that skipped the checkpoints
  would silently revert. All three files are written together or not at all.
- **A `_` span the swap cannot verify stays broken.** If the new `*` would pair
  with a literal asterisk elsewhere in the line, the pair is left alone: a
  visible underscore is better than emphasis over the wrong words.
- **Re-clipping an old article now costs a re-translation of the blocks whose
  delimiters changed**, since the checkpoint is keyed on the English source.
  That is the price of fixing the clipper rather than only the output.
