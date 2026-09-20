# ADR 0028: A PDF's layout decides its structure

Status: accepted (2026-09). Supersedes ADR 0026's account of what a PDF can
yield — specifically its claims about headings and tables — and changes when the
model pass of that ADR runs at all.

## Context

ADR 0026 said, of a PDF's text layer:

> **Headings carry no level.** `extractText` exposes no font size, so `##`
> versus `###` is a judgement the model makes from wording alone.

That is true of `unpdf`'s `extractText` and false of pdf.js underneath it. The
wrapper flattens every item to a string; the library hands back, for each run of
text, its font, its size, its position and whether a line ended there. The
decision to have a model infer structure was taken against a limitation that
belonged to one convenience function, and it was never checked.

What that cost is measurable. A twelve-page guide imported under ADR 0027 came
out as unbroken prose — no title, no headings, and none of its SQL in a fence —
while the document itself carries:

| | Measured |
| --- | --- |
| Title | one size at 20pt, bold |
| Chapters | 16pt bold — "Introduction:", "Chapter 1/2/3:" |
| Subsections | 13pt bold — "Velocity and throughput" |
| Body | 11pt, 12,431 characters, the dominant size |
| Code | **372 items in Courier** |

Every one of those is recoverable without asking anything of a model.

Four documents were measured rather than one, because a rule read off a single
PDF is a rule about that PDF. Three LaTeX papers behave differently in ways the
design has to survive, and they are the reason several clauses below are shaped
the way they are.

## Decision

**1. Structure is read from the layout; the model is the fallback, not the
route.** Extraction emits Markdown directly — headings, fences, lists,
paragraphs — and says whether the layout was legible enough to do so. Where it
was, no model call is made at all. Where it was not, the flat-text path and the
structure pass of ADR 0026 run exactly as before.

This makes the common case cheaper, and it makes conversion quality *testable*:
the reason ADR 0026 shipped unmeasured is that its output depended on a model,
and a deterministic extractor can be asserted against.

**2. Fonts must be woken before they can be read.** `commonObjs.get(fontName)`
throws "isn't resolved yet" until `page.getOperatorList()` has run for that
page. Nothing in the text-content API hints at this, and it is the most likely
reason the layout looked unavailable in the first place. Recorded because the
next person to reach for font data will hit exactly this.

**3. Body size is the character-weighted mode, not a median.** Measured, and it
matters: a median over *items* returned 8pt for the guide, because short 8pt
code fragments outnumber long 11pt prose lines, and every body line then
classified as a heading. The body of a document is the size that most of its
*text* is set in.

**4. Sizes are clustered, not compared.** LaTeX bodies measure 9.7, 10 and 10.9
in the three papers, and neighbouring sizes within a document differ by tenths.
Exact equality would shatter one logical size into several.

**5. Heading level comes from size rank, and never from volume.** Every distinct
size above the body, ranked descending, capped at three levels. Not weighted by
how much text is set in it: in the papers the headings are a rounding error
beside the body — 241 characters at 12pt in one, 62 at 14.3pt in another — and a
volume threshold would discard exactly the thing being looked for.

**6. Monospace is detected by name, and that is a heuristic.** pdf.js does not
set `isMonospace` for embedded fonts — the resolved objects carry `vertical`,
and `bold`/`italic` only for the standard fourteen. So the name decides, after
its subset prefix is stripped (`PNNOIE+NimbusRomNo9L-Regu` is a subset tag plus
a font). `Courier`, `Mono`, `Consolas` and `Menlo` are caught; TeX's typewriter
faces are caught by their `TT` convention (`CMTT10`, `SFTT1000`), which is a
convention and not a guarantee.

A font this misses renders as a paragraph rather than a fence. That is a
readability loss and not a corruption, which is the side of the trade this
codebase keeps choosing.

**7. Tabular blocks are fenced, not rebuilt.** Consecutive lines sharing two or
more column positions are recognised and emitted preformatted. ADR 0026 clause 5
refused to rebuild tables because a blank cell and an absent cell are identical
in plain text — with positions that is no longer true, and the reasoning could
now be revisited. It is not being revisited here: a mis-read column corrupts
data while a fenced block merely looks plain, and alignment preserved inside a
fence recovers most of what was actually lost.

**8. What layout does not rescue.** Figures are not in the text layer at all and
remain absent. Math remains flattened — the TeX math fonts are visible
(`CMSY`, `CMMI`, `CMR`) and could mark where a formula was, but marking is not
reconstructing, and ADR 0026 clause 6 stands.

**9. No new frontmatter field.** Confidence routes through the lifecycle ADR
0027 already named. A confident import commits finished Markdown and does not
set `tiro.pdf_unstructured`, so the processor sees a converted article and
leaves the body alone; an unconfident one sets it and is restructured as today.
A confident import therefore needs no LLM to become a readable article.

## Consequences

- **A PDF already in the vault keeps the body it was given.** The improvement is
  in extraction, and extraction does not re-run for an imported document (ADR
  0027). Re-import the file to pick it up.
- **Two conversions of the same document can differ**, depending on whether the
  layout read clearly. The run log says which path was taken.
- **Heading levels are relative, not semantic.** A document whose body is set
  larger than its own headings — rare, but posters and slides do it — will
  produce headings that are not headings. The confidence check does not catch
  this, because a size hierarchy exists; it is simply inverted.
- **The structure pass is no longer the common path**, so its own defects get
  exercised less often. It stays tested rather than being left to rot, because
  the documents that reach it are the ones with the least to go on.
