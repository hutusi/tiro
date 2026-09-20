# ADR 0026: A PDF is clipped from its text layer, never from its pixels

Status: accepted (2026-09). Extends the publisher-fetch flow of ADR 0013 and
ADR 0023 to a document the tab cannot read at all, and narrows ADR 0004's
provider contract by staying inside it rather than amending it.

## Context

Until now a PDF was refused outright. `isPdfViewerDocument` detects Chrome's
viewer by shape and the popup stops there, because the bytes are rendered by a
plugin the DOM cannot see — "A PDF served to the tab itself is refused outright
rather than committed as an empty article." The one exception is arXiv, where
ADR 0013 collapses `/pdf/` onto the paper's identity and the popup fetches
`/html/<id>` instead. That path never touches PDF bytes, and it only exists
because arXiv publishes an HTML twin. Most publishers do not.

So the question is not "can the extension read a PDF" — it cannot, and no
amount of bundling changes that. It is "where does a PDF become Markdown, and
by what mechanism".

**The mechanism is constrained harder than it first appears.** The obvious
answer — hand the PDF to the model — is not reachable from this codebase.
`ChatMessage.content` is a `string`: the client is text-only chat completions,
so multimodal content parts are not even representable. And file input is not a
chat-completions feature in the first place. `input_file` belongs to OpenAI's
*Responses API*, and OpenAI-compatible chat-completions servers — DashScope,
which this vault uses, along with Zhipu, DeepSeek and vLLM — reject a
`{"type":"file"}` part whether or not the model behind them is multimodal.

That leaves two mechanisms, and they are not equally priced. Rendering each
page to an image and sending `image_url` parts is the multimodal chat-completions
shape, so it would work — but it requires a vision model, a page rasterizer, and
a `content` union, and it makes "any OpenAI-compatible endpoint" (ADR 0004) into
"any OpenAI-compatible endpoint that also serves vision". Extracting the text
layer and asking the model to restore its structure is text in, text out: it
runs on the endpoint already configured, unchanged.

Measuring the text layer decided it. On real papers — single-column, two-column,
math-heavy, table-heavy — `pdfjs` reading order is correct, including across
columns, which was the failure this approach was expected to die on. Prose comes
out clean, with line-end hyphenation (`mo-\nments`) a model rejoins trivially.

What it does *not* recover is specific and worth naming, because it is what the
gate below is built from:

- **Figures are gone.** They are not in the text layer. Captions survive, and
  text baked *inside* a figure survives as orphan fragments in the flow.
- **Math is flattened.** `Attention(Q, K, V ) = softmax( QKT / √dk )V` arrives
  linearized, with the superscript `T` and the subscript in `d_k` indistinguishable
  from ordinary letters.
- **Headings carry no level.** `extractText` exposes no font size, so `##` versus
  `###` is a judgement the model makes from wording alone.
- **Sparse table cells are ambiguous.** `ByteNet [18] 23.75` gives nothing that
  says which of four columns the number sits in. The information is absent, not
  merely hard to read.

## Decision

**1. A PDF is clipped as a stub; the processor converts it.** The extension
records `url`, the title Chrome took from the document's `/Title`, and
`tiro.source_media: "pdf"`. It fetches nothing. This keeps the whole feature
inside the existing selection rule — "needs processing" is `tiro.processed_at`
absent (invariant 3) — so a stub is pending work by definition, and a conversion
that fails leaves it pending rather than failing the run (invariant 7).

**2. Conversion is text-layer extraction plus LLM structure restoration, not
rasterization.** Chosen because it stays inside ADR 0004 rather than amending
it: a vault pointed at any OpenAI-compatible endpoint can convert a PDF, with no
vision model and no second provider. The cost is everything in the list above,
and clauses 4-6 are how that cost is paid honestly instead of hidden.

**3. Nothing binary enters the vault.** The processor re-downloads the PDF at
processing time, under the guards the image stage already uses — SSRF host
rejection per redirect hop, a streaming byte cap, a content-type gate — which
moved to `net-fetch.ts` for exactly this. The vault keeps text, as it always
has. This is also what makes a local `file://` PDF out of scope: CI cannot reach
one, so supporting it would mean committing bytes.

**4. A PDF without a usable text layer is refused, not OCR'd.** A scanned page
yields an empty extraction, an empty extraction yields an empty body, and an
empty body is the article `docs/architecture.md` refuses today. The refusal is
the same promise the current code makes, kept by other means — so it must be a
real gate on extracted density, not a hope that the model says something.

The gate asks two questions, because either alone is wrong. Density is averaged
over the document, so the full-page figures a real paper carries do not sink it
— but an average is a sum, and one dense page among nine scanned ones clears a
per-page bar comfortably while the article gets filed as a whole document
holding a tenth of one. So coverage is asked as well: enough of the pages must
carry text at all. Coverage alone would refuse the figure-heavy paper the
average exists to admit.

**5. Tables are not reconstructed into Markdown tables.** This is the one place
the model would be asked to invent. A blank cell and an absent cell are the same
bytes in the text layer, so a reconstructed row is a guess presented as data, and
a wrong one reads as authoritative. ADR 0023 stated the asymmetry this follows
from: a rewrite silently not made costs a link its resolution, a rewrite silently
made wrong corrupts the document, and only the second is unrecoverable. A table's
lines are kept as they were extracted.

**6. `has_math` is never set on this path, and math is not reconstructed into
LaTeX.** The flag promises every literal `$` in prose was escaped, and the
Turndown hook that keeps that promise does not run here — the same reasoning as
ADR 0023's clause 10. Beyond the flag, a flattened equation does not carry the
sub- and superscripts LaTeX would need, so rebuilding one is clause 5's problem
in another notation.

**7. `tiro.schema` stays at 1.** `source_media` is an additive optional field, on
the precedent of `unlisted` (ADR 0017). It is named on **both** the clip and
article schemas: Zod strips unnamed keys and the processor round-trips
frontmatter every run, so a field only the write side knows is deleted the first
time the article is processed.

## Consequences

- **A PDF article is honestly worse than an HTML clip, and the gate is where
  that is admitted.** Figures do not survive, equations read as flattened text,
  and a table stays a block of lines. Clause 4's density check is what keeps the
  floor from falling through entirely; it does not raise the ceiling.
- **The extension must not ship before the converter.** A stub nothing can
  process is an article pending forever, indistinguishable from queue backlog.
- **Some running heads survive the strip.** Where extraction fuses one to text
  baked into a figure — on three of Adam's fifteen pages the ICLR head comes out
  joined to a chart's axis ticks — the line no longer matches and is kept.
  Matching on a prefix would catch them, and would also license deleting the
  start of any line that begins like a header, across every document. Three
  noise lines is the cheaper side of that trade.
- **A fallback batch is recorded as settled.** Checkpointing only successful
  replies left a document whose batches are slow *and* rejected stopping at the
  same place on every run, redoing exactly the work it redid last time — ADR
  0008's failure by a third route. A batch that spent every attempt has reached
  its verdict, so it is stored, marked so a resumed run still reports the
  article as partly unformatted. `--force` invalidates the checkpoint, which is
  what makes asking again possible — for a PDF fetched from a URL, which is
  every PDF this ADR knew about; ADR 0027 adds imported documents, where
  re-importing the file is what asks again — by deletion, or by emptying it in place
  when the file cannot be removed, and refusing the article outright when
  neither works. A `--force` that silently replayed what it was invoked to
  discard would be worse than one that failed.
- **The stage cap reaches into the model call.** A cap the client cannot see is
  one it will overrun: it retries on the run's clock, so a batch admitted with
  room to spare could return long afterwards. The call carries an abort signal,
  and the client treats an aborted call as final rather than retryable, so the
  request stops rather than merely stopping being waited for. The wait is
  bounded too, as a backstop — an abort only helps if the callee honours it, and
  hanging forever on one that does not would be worse than overrunning.
- **The sweep needs teaching or excluding.** `scripts/sweep.ts` replays cached
  bytes through `response.text()`, so a PDF article reports a permanent phantom
  diff. `plainTextShell` is the precedent for teaching it a non-HTML source.
- **Re-processing a PDF article re-downloads it.** Unlike an HTML clip, whose
  body is in the vault, this body is derived from bytes held nowhere. A source
  that 404s later cannot be reprocessed — the article keeps the Markdown it
  already has, which is the same position a re-clip of a dead URL is in.
- **A paywalled or access-controlled PDF cannot be clipped**, because the
  processor's fetch carries no cookies. Aligned rather than merely accepted: the
  site is fully public (invariant 5's premise), so a document the public cannot
  reach is one that should not be published from here — the position ADR 0023
  took for private repositories.
