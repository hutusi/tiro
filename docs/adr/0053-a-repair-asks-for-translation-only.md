# ADR 0053: A repair asks for translation only

Status: accepted (2026-10). Adds the optional `tiro.refresh` to the article
frontmatter, written by the extension and the sweep and read by the processor.
It is additive and optional, so `tiro.schema` is unchanged (ADR 0002).

## Context

ADR 0052 makes new clips keep the dek and the lead picture that a header
beside the body held. A code fix only helps the next clip, and about 260
articles in the vault were saved without their lead: some 228 of them on The
Atlantic.

**A re-clip is the wrong tool for this.** It replaces the whole body and
hands the article back for full processing: a new summary, new tags, a new
translated title, all to gain a paragraph and a picture. The body it
replaces with may also differ for reasons that have nothing to do with the
lead, such as a page edited since or a layout changed. The owner asked for
something lighter: insert only the missing parts, keep the rest of the body
byte for byte, keep the translation aligned, and translate only what is new.

**No raw HTML is saved.** The vault holds only Markdown. What exists is the
sweep's cache of 231 pages, none of them The Atlantic's (it refuses a fetch
that is not a browser), and the Wayback Machine, whose recent Atlantic
captures are mostly paywall pages: 43 of 247 articles had a usable one. Most
Atlantic articles can be repaired only from the reader's own browser, which
the Atlantic login lets past the paywall.

## Decision

### One rule for every repair: `mergeLead`

In `@tiro/shared`, so the extension and the sweep cannot disagree about what
is missing:

- **Only the missing parts go in.** A dek is there if its words are anywhere
  in the body. A picture is there if the article already opens with one, or
  if its address or its caption is in the body; a saved article names its
  pictures by downloaded file, so the address alone cannot say.
- **In the page's order.** A missing part goes after the last part before it
  that the article already opens with, otherwise at the very top. That puts a
  picture under a dek the article opens with, and a dek above a picture it
  opens with.
- **Every other byte stays.** Parts are inserted by offset into the body.
  The frontmatter is edited as written, with its key order kept, and only two
  lines change.
- **Only the same article.** The page's first paragraph after its lead must
  be the article's first paragraph after whatever lead it already opens
  with. A page edited since, a paywall stub, or an archived copy of another
  version is refused, and nothing is written. Paragraphs only: a section
  heading both versions open with survives an edit to the paragraph under
  it.

### `tiro.refresh: translation`

The repair removes `tiro.processed_at`, so the article is selected exactly
as before (invariant 3). When the article had a summary worth keeping, it
also sets `tiro.refresh: translation`. A run that finds the hint keeps the
summary, category, tags, `title_zh` and `summary_orig`, and does everything
else as always:
- **It downloads the new picture.**
- **It translates only the new blocks.** The checkpoint (ADR 0008) supplies
  every block it already translated, so for a dek that is one call. An
  image-only paragraph is copied verbatim.

The write that finishes the article removes the hint along with setting
`processed_at`. A run that stops before then leaves both, so the next run
does the same work. `--force` ignores the hint, because it asks for
everything. A summary marked for review, or an article with no category, is
summarized again. A re-clip rebuilds the frontmatter and drops the hint,
which is right: a new body needs everything. Between the repair's commit and
that run, `zh.md` is one block short, and the site shows the article
stacked, as it shows a re-clip (ADR 0003).

### Three ways to repair

- **"Add missing lead"**, in the popup, beside Re-clip on a page this machine
  clipped before, whenever the clip recovered a lead (`ClipPayload.lead`).
  - It reads the vault's copy, merges, and commits `index.md` in place.
  - A commit landing between the read and the write is merged against rather
    than overwritten, and if that commit already added the lead, nothing is
    written.
  - This is the way for pages only the reader's browser can see.
  - The privacy disclosure names it.
- **`sweep --fill-leads`**, over saved pages (`--pages`, or the cache).
  - It clips each page as today's clipper clips it and offers only the lead.
  - It is a report until `--write`.
- **`sweep --dek-from-excerpt <host>`**, for a host whose stored excerpt is
  its visible dek, as ADR 0042 measured The Atlantic's to be.
  - That is a claim about the host, so it is checked again before it is used.
    Every saved page of the host must show its excerpt, either as the lead
    the clip recovered or in the clip itself, or the whole run is refused.
  - 41 of 43 Atlantic pages do. The other two are 2011 and 2012 technology
    blog posts whose dek box is empty: the excerpt is an `og:description`
    the page never shows.
  - `--skip-url` names that kind of page, and those articles are left for
    "Add missing lead".

## Rejected

- **Re-clipping.** Above: full reprocessing for a paragraph and a picture,
  and a body that may change for other reasons.
- **Plain `processed_at` removal.** It re-rolls about 260 summaries and their
  tags and titles, which readers already see, to replace one reading of the
  same text with another. The owner chose the hint.
- **`--force`.** It discards every checkpoint and translates every block
  again.
- **Writing `zh.md` in the repair.** The caption and the dek need a model to
  translate them, and an English line in the Chinese column would be aligned
  and wrong.
- **A new processor command for translation alone.** A second entry into the
  pipeline would have to honour invariants 7 and 8 on its own. A hint the
  existing run reads changes one stage of a path that already honours them.
- **Copying Wayback pages into the sweep cache.** A later regression run
  would then compare an archived page against a fetched one without saying
  so. `--pages` reads them, and never writes.

## Consequences

- About 70 articles can be repaired from saved pages, and about 220 Atlantic
  deks from their excerpts. The Atlantic's lead pictures (roughly 200 of them)
  come back one page at a time, through "Add missing lead".
- A repaired article costs one small translation call, or a full translation
  when it has no checkpoint; the sweep names those.
- A collection whose cover is chosen automatically may change once its
  members gain lead pictures (ADR 0030).
