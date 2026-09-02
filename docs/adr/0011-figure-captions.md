# ADR 0011: A figure is one block — image and caption travel together

Status: accepted (2026-09)

Extends [ADR 0003](0003-block-aligned-translation.md) (block-aligned
translation) and supersedes the direction suggested by the revert commit
`5a8669f`, on evidence gathered after it — see *The site cannot do this alone*.

## Context

`FIG-SEMANTICS` is the largest open defect class in the
[2026-09-01 clip-fidelity sweep](../audits/2026-09-01-clip-fidelity-sweep.md):
12 of 32 articles, and the only class the current clipper still reproduces.
Every `<figure>` becomes a bare image paragraph followed by a loose caption
paragraph, so a caption is typographically indistinguishable from the article's
next sentence. On `kuleshov` a credit line reading "Figure credit: M.
Grootendorst & Gemma Diffusion." runs straight into the body prose.

A first attempt shipped and was reverted (`5a8669f`). The clipper emitted a real
`<figure>`/`<figcaption>`, which meant emitting **raw HTML**, and raw HTML is
opaque to this pipeline: math recovery, dollar escaping, link handling and
translator masking all had to be rebuilt by hand inside the block. Four
independent code paths each had to answer "do not mask this — then what?", and
each answered "send it whole"; one published a rewritten image `src` with no
model call at all. Seven review findings across four passes, all real, none
found by the tests written alongside the fixes. The reason to stop was the rate,
not the difficulty.

That revert proposed the next direction: ask whether the **site** can present an
image and its following paragraph as a figure, rather than whether the clipper
can encode one.

## The site cannot do this alone

Measured against all 34 vault articles before designing anything. The vault
holds **125 image-only blocks, 116 of them followed by a paragraph** — and that
following paragraph is a caption in some articles and ordinary body prose in
others, with no reliable textual difference:

| Signal | Result |
| --- | --- |
| Paragraph opens with a `Figure N:` / `Table N:` style label | **13 of 116 (11%)** — all of them arXiv |
| Paragraph length | Does not separate. `kuleshov`'s genuine captions have a median of 292 chars; `bankstatementconverter`'s body prose 221; `swyx/america250`'s body prose 1038; `greenlightning`'s captions 14 |

`kuleshov` (30 captions) and `swyx/create-luck` (4 body paragraphs) are the
decisive pair: both are unlabelled descriptive sentences immediately after an
image, and treating position alone as the signal would caption four paragraphs
of `swyx`'s argument. **The association is knowledge the clipper has and the
markdown throws away.** No amount of site-side cleverness recovers it, so the
clipper has to preserve it — the open question is only in what form.

## Decision

**The clipper emits an image and its caption as a single paragraph block**,
separated by a soft line break rather than a blank line:

```markdown
![Notations of activations](assets/fig-2-2.png)
Figure 2.2: Left: notations of activations that flow through the network.
```

The site renders any paragraph whose **first child is an image and which has
further inline content** as a `<figure>` with a `<figcaption>`, reusing the
existing block pipeline in `apps/site/src/lib/render.ts`. A paragraph of nothing
but images stays a plain image — `isImageOnlyParagraph` in
`packages/shared/src/blocks.ts` already draws exactly that line and is already
used by `repair`.

Verified against the real parser before writing this down:

- `![img](x)\ncaption` parses to **one** block, `type: "paragraph"`, children
  `image -> text`. `![img](x)\n\ncaption` still parses to two.
- `isImageOnlyParagraph` returns `false` for the combined block, so `repair`'s
  `deindentBlockImages` continues to ignore it.
- `checkAlignment` passes for a combined block against its translation.

### Why co-location rather than the alternatives

The association is expressed by **being in the same block**, which is the one
thing markdown can say about it. That is not a stylistic preference — it is the
property that makes the association impossible to desync:

- **Rejected: a frontmatter list of caption block indices.** Exact, and it keeps
  the caption a pure-prose block. But it is a second source of truth indexed by
  position, and this pipeline edits bodies in place (`repair`). ADR 0010's
  lesson was that correctness coming to depend on bookkeeping kept beside the
  work, rather than in it, produces the same defect at every call site that
  touches the work. An index list is that shape.
- **Rejected: emitting the caption in emphasis (`*…*`) and detecting that.**
  Markdown-native and degrades gracefully, but the marker is *content the
  translator may drop*: a model that returns the caption without its asterisks
  silently demotes a figure to a paragraph in the Chinese pane only. A signal
  the translator can quietly delete is not a signal.
- **Rejected: raw `<figure>` HTML.** Attempt one. See above.

### On sending an image URL to the translator

The combined block carries the image destination into the text the model sees.
This is **not a new exposure**: `translate.ts` masks math and nothing else, so
every paragraph containing an inline link already reaches the model with its
URL protected only by a prompt instruction ("keep inline code spans, URLs,
proper nouns … unchanged"). A figure block is that same case.

It is also a bounded one. Only `zh.md` is written from a model response, so a
mangled destination breaks the image in the Chinese pane while the original
pane and `index.md` keep the correct path — visible, confined, and repairable,
not the revert's failure mode of an article silently pointing at an image the
page never named.

Masking link and image destinations the way math is masked would remove the
exposure for figures and for every other linked paragraph at once. That is
worth doing and is **independent of this decision**; it is not a prerequisite.

## Consequences

- **The 12 affected articles need re-clipping to benefit.** A clipper fix only
  helps the next clip. Since ADR 0010 this is cheap: the translation checkpoint
  survives, so a re-clip re-pays only for blocks whose source text changed, and
  a caption merging into its image block changes exactly those two blocks.
- **Block count drops by one per figure**, so `index.md` and its existing
  `zh.md` will not align after a re-clip until the processor regenerates the
  translation. That is the normal, transient post-re-clip state already
  described in ADR 0003, and the site falls back to stacked rendering meanwhile
  rather than showing misaligned rows.
- **No schema change.** `tiro.schema` versions the article document format; a
  paragraph containing an image and text is already valid under it. Nothing in
  the frontmatter contract moves, so extension, processor and site do not need
  to ship in lockstep (ADR 0002).
- **The caption is translated as ordinary prose**, in the same call as
  everything else. No masking machinery, no verbatim carve-out, no new block
  type — which is the entire difference from attempt one.
- A caption that a page marks up but does not visually place after its image
  will still land after it. Acceptable: the reading order is the one Readability
  already chose.
