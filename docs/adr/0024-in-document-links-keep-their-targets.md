# ADR 0024: In-document links keep their targets

Status: accepted (2026-09). Third user of the marker contract in ADR 0009;
extends the post-sanitize rule in ADR 0009 with a second pass.

## Context

Clicking a footnote link on a clipped article did nothing, and it turned out not
to be a footnote problem. Across the vault, **35 of 132 articles** contained
`](#…)` links and **not one contained a single anchor target**, so every one of
those links was dead. `arxiv-org-abs-2608-23691` alone carries 258 of them —
every citation in the paper.

Two independent causes, either of which alone makes the feature impossible.

**The clipper never kept a target.** Turndown emits a link only for `<a href>`;
`<a name="f1n">` has none, so it was unwrapped to bare text. `id` on a heading,
section or list item was dropped because markdown has no syntax for an anchor.
Readability is not at fault for any of this — it preserves `id`, `name` and hash
hrefs intact. (It *is* at fault for one class of target, which it deletes
outright; that was found later and is decision 14.)

**The site would have broken them anyway.** `rehype-sanitize` clobbers `id` and
`name` to `user-content-*`, a defence against a page-chosen id shadowing a DOM
property, while leaving `href="#f1n"` untouched. A preserved target would no
longer have matched the link pointing at it.

And the reader renders **both panes into one document**, so the same id in
`index.md` and `zh.md` would collide and a jump would land in whichever came
first.

## Decision

**1. Mark before Readability, insert after.** The third use of ADR 0009's
contract, and here it is a requirement rather than a convenience in both
directions. The information survives Readability on its own — but `_prepArticle`
*deletes* a paragraph with no text in it, which is exactly the hand-written
`<p><a name="x"></a></p>` idiom, and an inserted empty child changes the counts
`_isElementWithoutContent` and `_hasSingleTagInsideElement` judge by. So
`markInDocumentAnchors` writes `data-tiro-anchor` before, and `placeAnchorsIn`
builds the anchor after, from the HTML Readability returned.

**2. Bounded to ids something actually links to — asked twice.** The arXiv paper
carries 2257 ids and 258 references. Anchoring every id would put two thousand
spans of noise into a public article to no end. The question is asked once
before Readability, where it is the only place the whole page is visible, and
again after, of the extract: Readability routinely drops the table of contents
whose links are the sole reason a heading was marked, and marking alone would
leave an anchor behind for a link no longer in the article. The baseline sweep
is what surfaced this — eight articles reported a changed body with no link
recovered, every one of them a dropped contents list.

**3. `getElementById`, never a built selector.** `bib.bib4` and `fn:1` are ids a
page is entitled to choose and neither is a valid CSS selector. A page-chosen id
must not reach a selector parser.

**4. An `ANCHOR_ID` grammar both ends validate.** Anchored, ASCII, and chosen so
that every string matching it is its own `decodeURIComponent` — which removes
percent-encoding from the problem rather than handling it. The value ends up in
an attribute in a public article, so the emitting end validates again rather
than trusting what came across the extraction boundary (the `CODE_LANG_ATTR`
precedent).

**5. A `<span>`, not an `<a>`.** An `<a>` nested inside another `<a>` is a shape
that really occurs and markdown cannot express it; `<a>` would take the prose
link styling on an element that shows nothing; and `marker()` already builds a
`<span data-tiro-*>` for math.

**6. Reached through Turndown's `blankReplacement`, not a rule.**
`rules.forNode` short-circuits to the blank rule *before* consulting any rule,
and an empty span is blank by definition. The math marker never hit this because
its span holds the TeX. This is not a style choice — a rule silently never fires.

**7. Three placement hazards, measured, and guarded.** Written down because each
one is invisible until it isn't:

- **Inside `<pre>`: refused outright.** Turndown's fenced-code rule wants the
  `<code>` to be the block's first child; one inserted sibling turns
  ` ```js\nconst a = 1;\n``` ` into `` `const a = 1;` `` — inline code, language
  gone.
- **Never before a leading picture.** `rehypeFigureCaptions` reads the image at
  the start of the paragraph, and an anchor in front of it stops the figure being
  recognised. The test for what counts as a picture is the one `pictureOf` here
  and `isPicture` in the site's renderer already share — ADR 0011 requires those
  two to move together, and this is a third reader of the same definition.
- **Never before a checkbox.** An anchor ahead of a task list's `<input>` breaks
  the item. Only reachable on the raw-body path, since Readability strips form
  elements — which is exactly why it would have gone unnoticed.

**8. Anchors are scoped to their pane, and the clobber prefix is replaced.**
One post-sanitize pass re-prefixes every property the sanitizer clobbered — read
off the schema rather than named, so an `aria-labelledby` still points at its
label once both have moved — and prefixes every in-document href to match. Any
non-empty prefix satisfies what the clobber is for, `#tiro-o-fn:1` is a fragment
a reader can look at where `#tiro-o-user-content-fn:1` is not, and stripping
exactly one occurrence hands back the author's own id on a GitHub-clipped page,
whose footnote ids really do begin `user-content-`.

Its position is load-bearing in both directions: after the sanitizer because it
must see the clobbered id, and before Shiki and KaTeX so it can only ever touch
clipped markup. They emit no ids today; keeping this upstream of them makes that
structural rather than a fact about their configuration.

**9. A dead fragment stays a link.** Whether a target exists cannot be asked in
`renderBlockHtml`, which sees one block — and the answer would be "leave it"
regardless. A dead link is exactly as dead as it was before; rendering it as
plain text would remove the reader's ability to see, hover or copy it, for a
class of links that are legitimately unresolvable here because Readability
dropped the section they point into. ADR 0023's asymmetry applies.

**10. The translator is not given a masker.** An anchor kept is best; an anchor
dropped costs one pane its links and still passes `checkAlignment`; an anchor
moved onto its own line is caught by the existing revert gate in
`translateBlocks`. Masking the way ADR 0009 masks LaTeX would be the wrong trade:
a mangled formula is silent, wrong mathematics, while a missing anchor is a link
that does nothing — which is where we started.

**11. The marker holds a list, not an id.** Two empty named anchors in one
paragraph both hoist onto the following heading, and a single-valued attribute
let the second erase the first — both links survive, so the loss is silent. The
hoist also walks past empty paragraphs rather than stopping at the first, since
handing the marker to another empty `<p>` hands it to an element Readability
deletes for the very reason it deletes this one — and "empty" is *Readability's*
rule, not a text test: it keeps a `<p>` holding an `img`, `embed`, `object` or
`iframe`, and a text-only test moved a photo's target onto the heading below it,
so the link jumped past the thing it named.

**12. Scoping moves aria references too, including the array-valued ones.**
`schema.clobber` lists `ariaDescribedBy` and `ariaLabelledBy` beside `id`, and
hast parses those as arrays because they are space-separated id lists. Handling
only string values renamed the id and left the reference pointing at the old
spelling — remark-gfm's own footnotes carry exactly that shape, so the failure
was a screen reader losing a label with nothing visibly wrong.

**13. `tiro.schema` stays at 1.** Nothing in frontmatter changes, and bodies
already carry raw HTML by construction — `VERBATIM_NODE_TYPES` includes `"html"`
precisely because "clipped articles carry raw HTML the converter could not
express", which also means `verbatimRanges` protects these anchors from every
repair for free. An older reader renders the span as inert markup.

**14. A target Readability deletes is restored before it is marked.** Added
after the fact, and it corrects the Context above: Readability *is* at fault for
one class of target. It deletes every `<button>` outright
(`_clean(articleContent, "button")`), and pages increasingly enhance a footnote
reference into one — vale.rocks swaps every `sup a[data-footnote-ref]` for a
popover trigger, so the reference reaches the clipper carrying no `href` at all
and leaves carrying the `data-tiro-anchor` this ADR had just written onto it.
Both halves of the footnote were published and neither could reach the other.

`restoreFootnoteRefs` runs immediately before `markInDocumentAnchors` and turns
the button back into the `<a>` the page replaced, recovering the lost href by
reciprocity: the note's backref says which id was the reference, and the `<li>`
holding it says which id is the note. So this is the one place a *reference* is
created rather than found, which widens decision 2's bound by one link —
deliberately, and only ever back to a link the page itself once had.

**What counts as a backref took three review rounds, each the same error one
step narrower.** Reciprocity through an identified list item is not a footnote:
a numbered tutorial whose steps carry ids, linking at a `Run example` button,
matches it exactly and had that button's label republished as a paragraph. A
footnotes region is not a backref either: a note may link anywhere the article
goes, and one saying "jump to the example control" made that control the note's
reverse link — beside a real footnote that was marked and repaired correctly, so
the section being genuine was no protection. What the repair needs is evidence
about the *link*: markup declaring it a backref, or, inside a footnotes region,
content that reads as one.

**The corpus sweep cannot see any of this**, and that is worth recording next to
decision 2's praise of it. It fetches static HTML, where the page still ships
the real `<a>`, so it reported 0 of 141 differing before and after. Replaying
the page's own enhancement script over the fetched document is what actually
tested the repair — and showed the enhanced page clipping byte-identically to
the page before its script ran.

## Consequences

- **Measured recovery**, on real pages: paulgraham.com 9 links / 9 live;
  `arxiv 2608.23691` 194 / 188; doubleword.ai 34 / 34; tautology.town 30 / 30.
  Block structure is unchanged in every case, which is the alignment contract.
- **No article gains anchors without a re-clip.** The same position ADR 0009
  records for fence languages: it is not in the markdown, so nothing downstream
  can repair it.
- **The sweep counts it.** `countMarkdown` gained `anchors` and `anchors_live`,
  so `--baseline` reports the recovery as a number rather than an anecdote.
- **Two articles the sweep cannot speak for.** darioamodei.com builds its
  footnotes client-side, so the cached HTML is a shell and the sweep reports
  nothing for 149 of the vault's in-document links. They need a browser clip.
- **A lifted title carries its anchors, and the renderer says which.** When the
  body's opening H1 *is* the article title, `liftTitles` skips that row — so an
  anchor on it would never reach the page and a `#top` link would stay dead,
  every time, since an anchor lands there only because something links to it.
  `buildReaderView` reports the first block's ids on `firstAnchors` and the
  title block re-emits them.

  **Which ids those are is a question only the renderer can answer.** It was
  asked of the markdown source first, and got a different wrong answer four
  times: a code span quoting anchor markup, an HTML comment, a `<script>` the
  sanitizer removes, and inline HTML that mdast splits one node per tag. Each
  fix was a new special case in an enumeration with no end — the ids now come
  from the finished tree, in a `rehypeCollectAnchorIds` pass that runs **last**,
  and arrive already scoped. Last is the load-bearing part: collecting at the
  scoping pass still reported an id KaTeX went on to delete with the `<code>`
  it replaced. Scoping must run early, right after the sanitizer; collection
  must run late, after the generators. They are two passes because they answer
  to two different positions in the pipeline. That also retired
  a `scopedAnchorId` helper that existed only to spell the pane prefix a second
  time.

  **Ids, not markup:** the title is not rendered through `render.ts`, and
  nothing that bypasses the sanitizer may carry clipped markup (invariant 5) —
  an id is a token in an attribute Astro escapes, which is a different thing.
  **`skipsLiftedH1` decides both halves**, because stacked keeps the row and its
  anchors are already on the page; emitting them in the title as well put two
  copies of every id in one document.
- **Heading slugs are out of scope.** A markdown-source article (ADR 0023)
  linking `](#some-heading)` wants *generated* slugs, which is a renderer
  feature needing a document-wide slugger that per-block rendering cannot
  supply. Two articles carrying GitHub's own `#user-content-fn-N` stay dead.
- **A jump would have landed under the reader's sticky toolbar**, so the scroll
  port is offset, and `:target` marks the destination briefly — a zero-width
  span is a good scroll target and an invisible arrival.
