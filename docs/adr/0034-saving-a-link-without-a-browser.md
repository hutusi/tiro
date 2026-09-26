# ADR 0034: Saving a link without a browser

Status: accepted (2026-09).

## Context

Capture was the Chrome extension on a desktop and nothing else. A page met on a
phone, or a link not worth opening yet, had no way into the vault.

The code that turns a page into Markdown never needed Chrome. `clipPage` takes
a `Document` and a URL; its repair pass, Readability and Turndown touch only
the document they are given. `sweep` has run it under happy-dom on fetched
HTML since the clip-fidelity work, and PDFs already arrive as stubs whose body
the processor builds. What was missing was a way to hand the processor a URL,
and the processor being able to run the clipper at all.

## Decision

### 1. The clipper is its own package

`packages/clip` (`@tiro/clip`) holds page → Markdown: `clipPage` and
`clipMarkdownFile`, the DOM repair pass, the Markdown conversion, and the
arXiv and GitHub-markdown fetch paths, with their tests. The extension bundles
it as before; `sweep` imports it; the processor can.

- **A package, not a path into the extension.** A package depending on an app
  is the layering the repo otherwise avoids, and the extension's tsconfig,
  dependencies and build are the wrong thing for the processor to inherit.
- **Not `@tiro/shared`.** That is the content contract, and its root has to
  stay light enough for a service worker to load a subpath of it. The clipper
  needs a DOM by design.
- **TypeScript source, no build step**, like `@tiro/shared` (ADR 0001). The
  plugin's ambient types are referenced from the module that imports it, so
  every program compiling the package gets them.
- **The move changed nothing it produces.** `sweep --baseline main` over the
  live vault compared the old clipper with the moved one on every page it
  could fetch: 0 of 180 differ (12 refused the fetch, 7 are client-rendered).
  `sweep` finds a baseline's clipper at either path, so refs from before the
  move stay comparable.

### 2. One hardened parser for pages nobody vetted

`@tiro/clip/happy-dom` is the one way to turn fetched HTML into a document
outside a browser — `withHtmlDocument(html, url, fn)` — shared by `sweep` and
the processor, and a separate entry point so the extension never bundles it.
The processor runs holding the LLM key and a token that can push to the vault,
so the page gets a document and nothing more:

- **No script runs.** Measured rather than assumed: a script parsed through
  `innerHTML` never runs, in happy-dom as in a browser, and `clipPage` moving
  nodes about does not change that. The one way happy-dom runs one is a script
  element created and connected, which nothing does today; evaluation is
  switched off explicitly so a future change that does still runs nothing. A
  test builds exactly that path and fails with evaluation on.
- **No request leaves.** happy-dom fetches for itself, bypassing any guard the
  caller puts on its own fetch; a `<link rel=preload as=script>` really is
  requested. Script and CSS loading and every kind of navigation are off, and
  a fetch interceptor refuses anything left. A test serves the page's
  resources from a real local server and counts zero requests.

### 3. The contract: what a saved link is, and how it ends

- **`tiro.capture: "link"`** marks an article whose URL was saved without its
  page. Separate from `source_media`, because a link can turn out to be a PDF
  and then both are true. Kept after processing, as provenance: the body was
  read without the reader's cookies or the page's scripts, and an audit may
  want to find those.
- **`tiro.fetch_failed: "<reason>"`** records a failure that will not change
  by retrying — a 404, a bot wall, something that is not a document, a page
  that builds its text with scripts. The article is marked processed, so no
  run retries it forever (the daily run would), and the site already hides an
  article with no body. `--force` with its slug asks again. A transient
  failure — a 5xx, a timeout — never sets it; that article stays pending.
- **`fetch` in `tiro.yml`**: a 5 MB cap (a page is text; past it, refused
  rather than truncated), a 30-second timeout, and `min_chars: 500`, below
  which a clip is taken to be a script-built page — the threshold `sweep`
  already flags one at.

All optional and additive, so no `tiro.schema` bump.

### 4. A save is a file in `inbox/`

A phone's shortcut saves a link by writing one file into the vault's `inbox/`
through the Contents API: the URL, as text. The processor turns each into a
stub at the start of a run — `normalizeUrl`, the slug, the domain as a
placeholder title, an empty body, `capture: "link"` — and deletes the file in
the same run, so the commit that adds the stub removes the file that asked
for it.

- **A file, not a message.** GitHub's `repository_dispatch` would carry the URL
  in an event, and the processing workflow keeps one pending run per
  concurrency group: a newer run cancels an older pending one, and the URL in
  it goes with it. A file is in git the moment the phone sees its 201, and any
  later run, or the daily one, picks it up.
- **The processor, not the phone, makes the stub.** Normalizing a URL, hashing
  it and slugifying it are not things a share-sheet shortcut can do, and a
  slug computed any other way is a second identity rule (invariant 2).
- **Never overwrites.** A URL that already has an article keeps it — a browser
  clip is always the better body — and saving one link twice makes one
  article.
- **A file with no usable link is deleted and fails the run.** Kept, it would
  fail every run after; deleted silently, the save would be lost without a
  word. The run's summary is where it is named.
- **Not under `--slug`**, which is about one article, not about what was saved.

### 5. The processor fetches the page and clips it

A stub with `capture: "link"` and no body yet has its page fetched before
anything else reads it, and clipped with `@tiro/clip` in the hardened document
— the extension's own code, so a saved link and a browser clip of the same
page cannot disagree about anything but what the fetch could see.

- **Publisher rules first**, as in the extension: an arXiv paper is read from
  its HTML rendering, a markdown file on GitHub from its raw bytes.
- **Guarded like every processor fetch**: every redirect hop's host checked
  (`fetchCheckedWithUrl`, which also reports where the redirects ended — the
  page's base, and `tiro.source_url`), the body capped, the request clamped to
  the run's budget. Running out mid-fetch is a deferral, never a failure
  (invariant 8).
- **Decoded as the page says**: the header's charset, then a `<meta>`, then
  UTF-8. A GBK page read as UTF-8 is not a thin article but a wrong one.
- **A PDF goes to the PDF stage**, which downloads it again under its own caps
  and gates; the link fetch abandons its body rather than read 25 MB twice.
  The article then records both `capture: "link"` and `source_media: "pdf"`.
- **The page's title, excerpt, author and math flag** replace the stub's
  placeholders before the summary is asked for, and are written with it.
- **After the fetch, the body is the clip.** `--force` does not fetch again —
  re-reading a page that has since changed would silently replace the article
  and discard the translation checkpoint keyed on its blocks (invariant 8).
  Only a stub with no body is fetched, which is also how `--force` on a
  settled one asks again.

What a fetch cannot see is what a tab can: no cookies, so a paywall answers as
to a stranger; no script, so a page that builds its text in JavaScript
arrives as a shell. Measured on the live vault with `sweep`, which reads pages
the same way: of 180 articles, 12 refused a plain fetch outright (403, mostly
one publisher) and 7 came back as shells — about one saved link in ten will
need a browser.

### 6. A failure retrying will not change is settled, not retried

`SettledRefusal` (and `PdfRefusal` from `@tiro/shared`) mark a failure that is
the answer rather than a mishap: a 4xx other than 408, 425 and 429; a
Cloudflare challenge; a response that is not a page; a body past the cap; a
host that is not public; a clip under `fetch.min_chars`; a PDF that is a scan,
too long, or not a PDF. The pipeline writes the article as processed with
`tiro.fetch_failed` and the reason — keeping whatever body it had, so a PDF
whose source has gone keeps the text it already has — and reports it, which
turns the run red once. A body built later drops the marker.

This narrows ADR 0026, where every refusal left a PDF pending: with a daily
run (ADR 0032) that is a download, a refusal and a red run a day, forever, for
a document nothing will change.

## Consequences

- The service worker's rule (invariant 6) covers `@tiro/clip` too: types only,
  never values.
- A phone holds a vault-writing token. It is its own, so losing the phone is
  one revocation, and it should share the extension's expiry date so one
  reminder covers both; nothing checks it automatically.
- About one saved link in ten needs a browser after all. Each is named once,
  in the run that settles it, and a clip replaces it.
- The processor typechecks with DOM types now, since it compiles
  `@tiro/clip`'s source.
