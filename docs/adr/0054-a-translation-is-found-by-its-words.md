# ADR 0054: A translation is found by its words, not by where its links point

Status: accepted (2026-10). Refines the key of the translation checkpoint
(ADR 0008, kept by ADR 0010). The file's format and version are unchanged.

## Context

The checkpoint keyed each block by a hash of its exact source text, so a
translation was reused only for byte-identical input. ADR 0008 called that
"safe by construction", and it is. But it is too strict for one change the
pipeline makes to articles on its own.

**The image stage runs before translation.** A picture that could not be
downloaded stays a hotlink, and a later run that downloads it rewrites the
address to `./assets/<hash>` before translation reads the body. The caption
block under that picture then has new text. Its checkpoint entry no longer
matches, so the caption goes back to the model for not one changed word.

The lead repair measured it. The first run after the repair (vault dc07148)
downloaded pictures that earlier local runs had left hotlinked. It
translated 38 picture captions again, and in 13 places swapped a translation
readers had already seen for a new one. A link retargeted to another address
costs a block the same way.

## Decision

**A block is checkpointed under its text with every link and picture
destination replaced by an indexed token** (`checkpoint-key.ts`).
- The destinations are those of inline links and images, found by the parser
  (`markdownLinks`), and the `src` and `href` values in raw HTML.
- Reuse fills the tokens back in from the block as it stands now, so the
  translation always points where the source does.
- A block that points nowhere is keyed by its own text, as before. That is
  most of them, so most entries never move.

**Only destinations, never markup.** Alt text, link text and titles stay in
the key: they are words. So do emphasis, a link gained or lost, and a code
span, because the translation mirrors them. A clipper fix that adds a link
must change the Chinese too, or the two columns disagree. The owner chose
this scope.

**A translation is stored by its tokens only when it is exact.**
- Its destinations must be the source's, each once.
- One the model altered, dropped or doubled is stored under the exact text,
  as before, and is reused only for that text. So is a block that names one
  address twice: once the source points the two links apart, a translation
  that reordered them could not be filled in correctly.
- A stored translation whose tokens do not fit the block is never filled. It
  reads as a miss.

**Old checkpoints carry over.**
- Lookup tries the new key first, then the exact text, which is how every
  existing checkpoint is keyed.
- An entry found by exact text is stored again under its new key. `retain`
  keeps whichever is live (`liveKeys`), so a file is rewritten once and never
  holds a block twice.
- The pipeline also offers the body as it stood before the image stage
  (`adoptExactEntries`). On the run that downloads a hotlinked picture, that
  body is the last place the caption's old entry can be found.
- No version bump: the loader requires version 1, so a bump would discard
  every checkpoint in the vault.

**The prompt is unchanged.** The model still sees the addresses.

## Rejected

- **Masking addresses in the prompt too**, as math and code are. It would
  shorten prompts, but a token the model drops sends the block back to its
  original, untranslated. That is a new way to fail, and this change does not
  need it.
- **Ignoring markup as well.** It saves more calls, but zh.md could then keep
  a link, emphasis or code span the source no longer has. The alignment
  check, which counts blocks, would not notice.
- **A version-2 file.** It would discard every checkpoint in the vault, which
  costs more than this saves.

## Consequences

- **Measured on the vault** before merge:
  - Across 483 checkpoints, the new keys find exactly the 33,813 entries the
    old ones did.
  - 43 articles still have 198 captioned pictures hotlinked. Simulating their
    download, none of those captions would have been reused before; 192 now
    are. The other 6 have an address the model altered.
- A checkpoint holding tokens can only be read by a processor with this
  change. The vault job always runs `main`.
- The PDF checkpoint (ADR 0026) shares the cache module but not this key. Its
  batches are page text with no addresses to move.
