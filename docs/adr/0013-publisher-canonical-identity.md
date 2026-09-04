# ADR 0013: Publisher-canonical identity — one paper, one article

Status: accepted (2026-09). Extends the slug contract of ADR 0002 and the
path-is-identity rule of ADR 0007; neither is superseded.

## Context

Identity is `normalizeUrl` → slug (ADR 0002), and `normalizeUrl` is
deliberately host-agnostic and deliberately a *blocklist*: it strips known
trackers and touches nothing else, because a stripped content-identifying
param (`?v=`, `?id=`, `?p=`) would silently merge distinct pages, and losing an
article is worse than showing a duplicate.

arXiv breaks that model, not by being an exception but by being a publisher
whose URL forms are documented to mean one thing:

- One paper is served at `/abs/<id>`, `/pdf/<id>`, `/html/<id>`, `/format/`,
  `/ps/`, `/src/`, `/e-print/`, each optionally versioned (`v1`, `v2`), across
  `arxiv.org`, `www.arxiv.org`, `export.arxiv.org` and the ar5iv hosts.
- The abstract page states the answer itself:
  `<link rel="canonical" href="https://arxiv.org/abs/2404.19756">` — no
  version.
- arxiv.org already redirects `/abs/math.GT/0309136` to `/abs/math/0309136`,
  so even the pre-2007 identifier has a canonical spelling arXiv defines.

Left alone, one paper accumulates up to five articles and a re-clip from a
different URL form never overwrites the first — the exact failure ADR 0007 was
written after, in a form no tracking-param blocklist can reach.

Two of the vault's 36 articles were affected, both filed under
`arxiv-org-html-<id>v1-<hash>`.

## Decision

- **A publisher may define its own identity, in one place.**
  `packages/shared/src/canonical-url.ts` holds the rules;
  `canonicalizeUrl` runs last in `normalizeUrl`, after every generic step, so
  the generic normalizer stays host-agnostic. arXiv is the only rule today.
- **The canonical arXiv URL is the abstract page, versionless.** That is what
  arXiv declares, and it is the better "read the original" destination: it
  links onward to the PDF, the HTML, every version and the DOI.
- **The rewrite never guesses.** It fires only when the host is a known arXiv
  host, the first path segment is a known paper route, *and* the tail matches
  an arXiv identifier exactly. `/list/cs.AI/recent` and `/a/liu_z_1` are arXiv
  URLs that are not papers and pass through untouched. This is what keeps the
  ADR 0007 "blocklist, not allowlist" reasoning intact: the risk there is
  merging pages that only *look* alike, and a publisher's own identifier
  grammar is not a resemblance.
- **Versions collapse into the paper.** A reader wants one entry per paper,
  not one per revision. The version is not lost: `tiro.source_url` records the
  URL the body was actually read from, including it.
- **Content acquisition moves with identity.** Collapsing `abs`/`pdf`/`html`
  without this would be a trap — `/pdf/` has no readable text and `/abs/` is a
  one-paragraph abstract, so clipping either would *overwrite* a full-text
  clip with less. The extension therefore always fetches
  `arxiv.org/html/<id>`, under an optional host permission requested from the
  Clip flow's own user gesture, and falls back to the abstract page when there
  is no usable HTML.
- **`tiro.schema` stays at 1.** The article document format is unchanged;
  `tiro.source_url` is an added optional field, like `clipper_version` and
  `clipper_commit` before it.

## Consequences

- A slug-rule change renames existing articles, which ADR 0007's migration
  runbook did not cover — it is explicit that slug identity was unchanged
  there. `sweep --recanonicalize` is the repair path: it renames the
  directory and rewrites the frontmatter, leaving bodies and `zh.md` alone, so
  no article is re-queued and the migration costs no LLM calls. `validate`
  remains the gate that detects the mismatch.
- Site URLs change for the articles that move, and there are no redirects.
  ADR 0007 waived that when the site was days old; here it is two of 36
  articles, and the trade was taken again rather than assumed.
- Metadata for LaTeXML pages is read from the document (`.ltx_personname`,
  `.ltx_abstract`) rather than guessed by Readability. Keyed on the LaTeXML
  classes, not on arxiv.org — the renderer is the fact, the host is not — so
  ar5iv and every mirror benefit too. This is the same split the decision rests
  on: **identity is host-keyed because a publisher owns its URLs; content is
  structure-keyed because a renderer owns its markup.**
- A second publisher rule (a YouTube video id, a Medium canonical) now has an
  obvious home and an obvious test shape. Each one is a deliberate decision
  about a documented identity, never a heuristic.
