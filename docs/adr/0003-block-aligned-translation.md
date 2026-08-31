# ADR 0003: Paragraph alignment via strict 1:1 top-level markdown blocks

Status: accepted (2026-08)

## Context

The site renders original and Chinese translation side by side,
paragraph-aligned. LLMs merge and split paragraphs when translating whole
documents, which silently breaks any alignment scheme based on trust.

## Decision

- `zh.md` must have **strict 1:1 top-level-block alignment** with the
  `index.md` body: equal block count, equal block type per index, and
  byte-identical code blocks. Lists and tables are single blocks.
- Blocks are derived with remark/mdast, slicing the original source text by
  node offsets (never re-stringifying blocks that weren't changed). mdast
  guarantees blank lines inside fenced code don't split blocks.
- The processor translates block-by-block (batched with sentinel markers,
  falling back to one call per block), copies verbatim blocks byte-identically,
  and treats `checkAlignment` as a hard gate: on failure it writes no `zh.md`
  at all rather than a misaligned one.
- **Each translation is checked on its own before the body is joined**, and a
  block whose translation no longer parses as one block of the same type is
  replaced by its original. Alignment then holds by construction and one bad
  block costs one untranslated block, not the article's whole translation.
  Added after an arXiv paper lost all 364 blocks over 8: Turndown converting
  MathML left paragraphs whose last line was a lone `=`, which markdown reads
  as a setext heading, so the model translated the prose and sensibly dropped
  the stray line. No prompt fixes a source that means something other than it
  looks like. The gate stays as the backstop for what per-block checks cannot
  see — two lists with different bullets are two blocks, but translations that
  normalise the bullet merge into one when joined.
- The site zips the two block arrays into grid rows; if alignment fails at
  render time it falls back to stacked full-document rendering.

## Consequences

- Alignment is structurally guaranteed, not prompt-hoped.
- Losing a whole article's translation now takes a join-time interaction, not a
  single misbehaving block; the common case degrades a block at a time.
- Per-block translation loses some cross-paragraph context; acceptable for
  reading support, and batching restores most of it.
- Chinese originals simply have no `zh.md` and render single-pane.
