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
- The site zips the two block arrays into grid rows; if alignment fails at
  render time it falls back to stacked full-document rendering.

## Consequences

- Alignment is structurally guaranteed, not prompt-hoped.
- Per-block translation loses some cross-paragraph context; acceptable for
  reading support, and batching restores most of it.
- Chinese originals simply have no `zh.md` and render single-pane.
