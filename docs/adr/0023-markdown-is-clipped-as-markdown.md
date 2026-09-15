# ADR 0023: Markdown served as text is clipped as markdown

Status: accepted (2026-09). Applies the publisher rule of ADR 0013 to a second
publisher, and the code-block provenance of ADR 0012 to the case where the whole
document is not code at all.

## Context

Clipping
`raw.githubusercontent.com/matthiasn/talk-transcripts/refs/heads/master/Hickey_Rich/SimpleMadeEasy.md`
produced an article that was wrong in four ways at once, and every one of them
followed from a single unasked question.

Chrome renders `text/plain` as an HTML shell whose body is one `<pre>` holding
the file. Nothing in the pipeline asked what kind of document had arrived, so
`recoverCodeBlocks` did what it does with any bare `<pre>` on any page — it
synthesized a `<code>` inside it (`dom-prepare.ts`) — and Turndown fenced the
result. The consequences compound:

- The body was 473 lines inside one bare fence.
- `code` is in `VERBATIM_BLOCK_TYPES` (invariant 4), so the processor never sent
  it to the model. `zh.md` was written as a byte-identical copy of the English,
  and the reader showed English in both panes.
- The title was `raw.githubusercontent.com`: Chrome sets `document.title` to the
  host, and `buildClipFile` falls back to the domain.
- All 39 images were repo-relative (`SimpleMadeEasy/00.00.00.jpg`). The
  processor mirrors absolute URLs only (`images.ts`), so they were not merely
  unmirrored — they stayed relative and resolved against the *site's* origin.

ADR 0012 decided that markdown is never *inferred* for a code block, so nothing
downstream could have recovered this later. And the file was already markdown:
everything the pipeline did to it was work spent converting something that
needed no conversion.

GitHub then poses the identity question ADR 0013 answered for arXiv. One file is
served at `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` and presented
at `github.com/<owner>/<repo>/blob/<ref>/<path>`; the ref may be spelled `main`
or `refs/heads/main`; `github.com/.../raw/...` redirects to the bytes. Left
alone, one file accumulates four articles.

## Decision

**1. A document that *is* markdown is carried, not converted.** The question is
asked in `clipPage`, beside the PDF-viewer probe and before anything rewrites
the DOM, because it is a fact about the document that arrived.

**2. The detection is structural, not host-keyed** — the body is exactly one
`<pre>` and holds all of the document's text — paired with a markdown path
extension. This follows ADR 0013's split: identity is host-keyed because a
publisher owns its URLs, content is structure-keyed because a renderer owns its
markup. GitLab, Codeberg, Gitea and any static `.md` get the same treatment for
free, and a page that merely opens with a code block fails the shape test
because its prose sits outside the block.

`document.contentType` is deliberately not consulted: the clone Readability is
handed does not reliably carry it and no test DOM implements it. The shape is
the stronger test regardless.

**3. Only markdown is claimed.** `.txt` is hard-wrapped prose and ASCII art that
markdown would reflow; `.mdx` is JSX. Both stay code blocks.

**4. GitHub's URL forms are one identity, and the rewrite never splits the
tail.** A branch name may contain slashes, so nothing offline can say where the
ref ends and the path begins — `o/r/feature/x/README.md` parses both ways and
only the repository knows which. The rule never needs to: every URL form puts
the *same* tail behind a different prefix, so rewriting the prefix alone
collapses them exactly.

```
raw.githubusercontent.com/o/r/refs/heads/TAIL ┐
raw.githubusercontent.com/o/r/refs/tags/TAIL  ├→ github.com/o/r/blob/TAIL
raw.githubusercontent.com/o/r/TAIL            │
github.com/o/r/raw/TAIL                       ┘
```

The canonical form is the blob page — what "read the original" should open.
Rebuilding it from parts also folds `?plain=1`, which `normalizeUrl`'s tracking
blocklist has no reason to know about.

**5. A different ref is a different article.** Unlike an arXiv version, which
the publisher declares subordinate to the paper, a tag or a commit SHA is a pin.
`blob/main/F.md`, `blob/v2.0/F.md` and `blob/a1b2c3d/F.md` stay three documents.

**6. The identity rule is gated on markdown too** — this is ADR 0013's fifth
clause, not timidity. Identity and content acquisition move together: claiming
two URLs are one article is safe only where the clipper can read the file
behind them, and a `.py` blob page yields GitHub's virtualized code viewer,
which holds only the lines currently scrolled into view.

**7. A blob page is fetched, never clipped.** Because the identity collapses,
clipping the page would not add an article but *replace* one — with GitHub's
rendering run back through Turndown — and cost a re-translation to undo. So
GitHub gets what arXiv has: an optional host permission for
`raw.githubusercontent.com`, asked for from the Clip flow's own user gesture,
and `tiro.source_url` recording the bytes. Nothing is fetched when the reader is
already on the raw URL — the tab holds the file and `activeTab` covers it.

**8. Destinations are absolutized against the raw URL, then re-canonicalized —
in attributes as well as in nodes.** Against the blob page an image resolves to
another HTML page; against the raw URL it resolves to the image. Passing each
result back through `canonicalizeUrl` then turns a link to a sibling `.md` into
its blob page, at no cost, because the rule that decides this article's own
identity answers the same question.

"Destinations" has to mean the ones in raw HTML too, and saying so cost a
review round. A README's first line is routinely
`<p align="center"><img src="logo.png"></p>`; `img[src]`, `a[href]` and
`source[srcset]` all survive the site's sanitize allowlist, so a relative one
reaches the public page and 404s, and the processor's mirroring matches
absolute URLs only and never localizes it. No `<pre>` guard is needed: that
element preserves whitespace but does not escape markup, so a literal
`<img src=…>` inside one is an image rather than source, and HTML shown *as*
source is entity-escaped and holds no attribute to match.

**8a. A boundary the parser cannot confirm is not guessed.** Finding where a
link's label ends looked like a small scan — skip escapes, skip code spans —
and is not: the grammar also admits an unescaped `]` inside an autolink, an
HTML comment and any inline attribute, and the list cannot be closed by hand,
because even "skip from `<` to `>`" is wrong where a bare `<` is literal text.
`markdownLinks` therefore takes the boundary from the parser's own node
positions and reports *nothing* for the one shape it cannot ask about — a
reference whose identifier does not survive being written back as a label. A
rewrite silently not made costs a link its resolution; a rewrite silently made
wrong corrupts the document it was in, and only the second is unrecoverable.

**9. Reference-style links are inlined at clip time and their definitions
dropped.** The site renders each top-level block through its own processor
(`renderBlockHtml`), so a `[ref]: …` in one block cannot resolve a
`[text][ref]` in another — both would render as literal text. Turndown only ever
emitted inline links, which is why no article has hit this; raw markdown uses
references routinely. Every definition goes, used or not: remark reports a
reference node only where a definition matched, so one left standing is one
nothing pointed at, and it would render as an empty block the translation would
have to match.

**10. `has_math` is never set on this path.** The flag promises that every
literal `$` in prose was escaped, and that promise is kept by a Turndown escape
hook (`escapeLiteralDollars`) which this path does not run. Claiming it would
let the site read "$5 to $10" as a formula. `$$…$$` renders for every article
regardless, so little is lost.

**11. The body keeps its opening `# Heading`.** `liftTitles` already drops that
row when it matches the article title, and lifts the translated heading as the
Chinese title. Stripping it at clip time would throw both away, and the
passthrough would stop being verbatim.

**12. `tiro.schema` stays at 1.** `markdownSource` is a payload field, not a
frontmatter one, and `source_url` already exists (ADR 0013).

## Consequences

- **The transcript in the vault must be re-clipped, and it moves.** Its slug
  changes from `raw-githubusercontent-com-…` to
  `github-com-matthiasn-talk-transcripts-blob-master-hickey-ric-db26414f`.
  `sweep --recanonicalize` performs the rename offline — bodies and `zh.md`
  untouched, no LLM cost — and the re-clip then lands on the migrated path.
  Run in that order, or the re-clip creates a second article beside the first.
  It is the only affected article in the vault.
- **Site URLs change for it, and there are no redirects.** The same trade ADR
  0013 took, at one article rather than two.
- **Footnotes render literally.** `[^1]` and its definition cannot see each
  other across the per-block processors, and unlike a reference link a footnote
  has no inline form to rewrite it into. Accepted and recorded rather than
  worked around; the fix, if it is ever wanted, belongs in the site's renderer.
- **A branch literally named `refs` would misparse the legacy raw form.** Git is
  broken by such a name in other ways; noted rather than defended against.
- **The popup's fetch flow is now written once.** Both publisher rules create
  the same trap, so the arbitration — prefer the body that *is* the document,
  and gate the button until that is settled — moved to `clip-candidate.ts`, and
  the strings moved to a per-publisher block in `i18n.ts`. A third publisher
  adds a descriptor and a message block, not a parallel flow.
- **The sweep needed teaching.** It replays cached bytes, and for `text/plain`
  the bytes are not the document; `plainTextShell` builds the one Chrome would.
  Without it every markdown article would report a permanent phantom diff.
- **The parser was already there.** `markdownLinks` leans on remark, which the
  `@tiro/shared` barrel had already pulled into the clipper bundle — the whole
  change costs 7.8 kB raw, 2.7 kB gzipped.
- **A second optional origin appears in the disclosure and the privacy page**,
  and in the Chrome Web Store justification at the next submission.
