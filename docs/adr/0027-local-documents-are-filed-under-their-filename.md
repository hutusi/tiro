# ADR 0027: A local document is filed under its filename

Status: accepted (2026-09). Amends ADR 0026 clause 3, which put local files out
of scope, and extends ADR 0007's identity rule to a document that has no URL.

## Context

ADR 0026 refused local PDFs for a reason that was true when written: the
processor fetches the document at processing time, and CI cannot reach a path
on somebody's disk. Supporting them therefore meant committing bytes, and the
vault stores text.

Two things moved.

**A document turned up with no web source to clip instead.** Its producer is
`jsPDF` and it was generated in a browser — not published anywhere, so the
usual answer ("clip the page it came from") had nothing to point at. It is 12
pages with text on all 12 at 1,436 characters a page: the kind of document this
pipeline handles *best*, refused on provenance alone.

**And the assumption that the extension cannot read a PDF turned out to be
narrower than stated.** ADR 0026 says "the extension cannot read a PDF — Chrome
renders it in a plugin the DOM does not see". That is true of a PDF *in a tab*,
which is what the clipper meets. It says nothing about bytes handed over by a
file picker. Checked against the installed package: `unpdf` inlines its worker,
so `workerSrc`, `new Worker` and the blob-URL CDN wrapper that MV3's CSP would
block are all unreachable; there is no `eval` and no `new Function`;
WebAssembly exists but never on the text path, and the one reachable site
catches its own failure and falls back to JavaScript. No `wasm-unsafe-eval`, no
`web_accessible_resources`, and `<input type="file">` needs no file access
permission — the picker hands over a `File` and `arrayBuffer()` works.

So the constraint was never the extension's reach. It was that a local file has
no identity, and nothing to re-fetch.

## Decision

**1. The extension extracts; nothing binary enters the vault.** This keeps ADR
0026 clause 3's promise rather than reversing it — the vault still stores only
text. The extension reads the text layer itself and commits an article whose
body *is* that text; the processor restructures it in place.

The extraction is one implementation, moved to `@tiro/shared/pdf` and shared
with the processor. A subpath rather than the barrel, because invariant 6 keeps
the root browser-safe and 1.7 MB of pdf.js reachable from the root would land
in the clipper (ADR 0005).

**2. Identity is a `local:` URL built from the filename**, with every reserved
character escaped. That last clause is load-bearing rather than pedantic: `#`
and `?` are URL *syntax*, so a filename carrying one has to be encoded as a
component and not merely as a URI, or `C# Notes.pdf` becomes a fragment,
`normalizeUrl` strips it to `local:C`, and every such name collapses onto one
identity that silently overwrites the last. No rule changes to
get it: `local:stacked-prs-guide.pdf` has an empty hostname and a pathname of
the filename, so `slugForUrl` produces `stacked-prs-guide-pdf-<8hex>` by the
existing rules, deterministic and stable across re-imports of the same name.
`canonicalizeUrl` already declines anything that is not http(s), so it passes
through untouched.

Chosen over a content hash, which was the other candidate. A hash is the more
honest identity for bytes with no source — but it makes `url` optional, which
is invariant 2's premise, and it produces a slug nobody can read. The filename
is what the owner already calls the document.

**3. `domain` carries a `"local"` sentinel.** The field is required and
non-empty and there is no hostname to put in it. Recorded as a sentinel rather
than left to look like a hostname, because the site renders it as the source
label and a reader has to be able to tell.

**4. The site shows the name, never a link.** `frontmatter.url` becomes the
"read the original" anchor, and for a local document it opens nothing. The
reader prints the filename as plain text instead. Without this the decision
above ships a visibly broken page, which is the difference between an identity
and a lie.

**5. A local import is unlisted by default.** An owner's disk is not the open
web, and a document nobody published should not walk into the library. Stated
as a default rather than a guarantee, because ADR 0017 is explicit that
unlisted is enumeration removed, not access control: the slug is derivable, and
for these articles it *is the filename*. The owner sees the name before
importing, and that is the whole of the protection.

**6. The processor infers the branch from the scheme.** `source_media` stays
one value. Where the URL is http(s) the document is downloaded as it is today;
where it is not, the body already holds the extracted text and only the
structure pass runs.

This codebase normally refuses inference — `source_media` itself exists because
"a `.pdf` URL proves nothing". The difference is that a scheme does not *hint*
at fetchability, it decides it: `fetchPdf` speaks http(s) and nothing else, so
a second field would record a fact already stated, and could contradict it.

**7. The body says whether it is the article yet.** An import writes
`tiro.pdf_unstructured`, and the processor removes it in the same write that
lays down the converted body.

Recorded rather than inferred, which took two attempts to get right.
`processed_at` looks like it carries the same information — a converted article
has one — and it does not: `markPending` clears it when a forced run is
deferred, leaving a *finished* body that reads as unconverted, so the next
ordinary run would feed Markdown back through the structure pass as a single
batch with its page separators long gone. A fact about the body belongs beside
the body, not deduced from a marker that means something else and moves for its
own reasons. This is ADR 0026's own rule about `source_media`, applied a second
time after being forgotten once.

**8. `tiro.schema` stays at 1.** `pdf_unstructured` is additive and optional,
on the precedent of `unlisted` (ADR 0017), and the `"local"` domain and scheme
are values the existing fields already admit.

## Consequences

- **Reprocessing a local document cannot re-read its source, so it does not
  try.** The download path re-fetches and re-extracts; there is nothing here to
  re-derive, because the bytes were never in the vault. A `--force` therefore
  keeps the converted body and redoes only what it still can — summary, tags,
  translation. Restructuring again would not merely be redundant: a converted
  body has no page separators left, and batching never splits a page, so the
  whole document would go out as a single request. Re-importing the file is the
  way to genuinely start over — and it works only because the conversion
  checkpoint is stamped with the article's `clipped_at`. Content addressing
  makes reuse safe but not wanted: an unchanged file re-imported extracts to
  byte-identical batches, so every entry would hit, fallbacks included, and the
  documented way out of a bad conversion would quietly change nothing. The
  stamp separates the two cases exactly — a resumed run carries the same one
  and keeps its work, a fresh import carries a new one and starts over.

  Imports only. A web re-clip re-downloads the document, so unchanged bytes
  give unchanged batches and reuse is precisely what ADR 0010 keeps a
  checkpoint for, while a document that really changed misses the cache by
  content. Stamping those as well threw away every batch of every re-clip,
  which for a long paper is a great many model calls spent rediscovering the
  same answers. `--force` stays the way to retry one of those, and it clears
  the checkpoint outright.
- **The filename becomes a public slug.** `unlisted` keeps it out of every
  index, and the address remains derivable by anyone who knows the name. A file
  named for something sensitive should be renamed before importing, or not
  imported.
- **Extraction runs on the options page's main thread.** unpdf's inlined worker
  is a `LoopbackPort`, not a real one, so a large PDF will make the page
  unresponsive while it parses. Accepted: it is a deliberate action with
  progress on screen, not a background cost.
- **cMaps and standard fonts are not bundled**, so a PDF relying on a
  predefined CJK CMap or non-embedded base-14 fonts extracts poorly. The
  density gate catches the worst of it by refusing the import. Shipping them is
  possible later and needs no new permission.
- **Two ways in now produce one kind of article.** A clipped web PDF and an
  imported local one differ only in where the bytes came from, and downstream
  cannot tell beyond the scheme — which is the point.
