# ADR 0044: A chart drawn as svg is a figure, described and captured

Status: accepted (2026-10). Extends ADR 0039 to charts drawn as `<svg>`.
Amends four of its lines:

- the allow-list that kept "an `<svg>` with no canvas" out;
- its out-of-scope note on drawings with no `<figure>` round them, for charts;
- §4's index space;
- "only children change", for the box an orphan chart is drawn in.

Changes what a clip contains, not the document's shape, so `tiro.schema` is
unchanged.

## Context

The owner reported that GitHub's "Building Git infrastructure for agent-scale
development" had lost its chart. GitHub's blog draws charts with an inline
script into a plain `<div id="gh-chart-…" class="ghchart">`, with no
`<figure>`. Rendered, the box holds:

- a title span and a subtitle `<p>`;
- an HTML legend;
- the plot, `<svg role="img" aria-label="Git events per repository line chart">`;
- a tooltip, `role="status"`, hidden only by the stylesheet.

The 0.16.0 clip published the title and the subtitle. It also published the
tooltip's rows, frozen on the first data point:
`P25 / Fetches1 / Pushes2 / Clones1 / Requests (all)15`, which reads as data
and is not. There was no chart.

That is `dropChartSvgs` (0.11.0) working as designed. It deletes any `<svg>`
painting four or more `<text>` labels, so axis ticks do not arrive as glyph
soup. But it leaves no trace of the chart. The chart's own words outside the
`<svg>` are left to Readability, which keeps whatever its class names do not
rule out. ADR 0039 had the remedy, a described link and a picture on request,
but it refused any figure holding an `<svg>` without a canvas, and only ever
looked at `<figure>`.

Scanning the sweep's page cache found the same loss in five more vault
articles:

- **Anthropic's Opus 5.5, Sonnet 5.5 and Fable 5.1 posts.** Each chart is a
  `<figure>` holding a nested figcaption (title and subtitle, published glued
  as "Terminal-Bench 4.0Accuracy vs Cost"), a legend of buttons, and a
  footnote `<p>` saying what the benchmark measures.
- **archerhume's Jev post.** Two charts share one figure, and their panel
  headings were published glued ("MMLU sample1,200 items · ECE 0.031").
- **Anthropic's econ-scenarios.** It has no `<figure>` either.

## Decision

### 1. A chart is what `dropChartSvgs` deletes

`isChartSvg` is the one test: four or more painted `<text>`, not inside a link.
Both passes read it. A chart this ADR describes is never seen by
`dropChartSvgs`. A chart it cannot describe is deleted as before.

### 2. Its host is a `<figure>`, or the box it is drawn in

The host is the chart's nearest `<figure>`, if it has one.

With none, the host is found by climbing from the `<svg>` **through `<div>`s
only**. It is the outermost box that holds:

- this one chart and no other;
- none of the article's own structure: headings, links, lists, media, tables,
  quotations, code, forms;
- at most 500 characters and two paragraphs of text beside the drawing.

Measured on the two orphans: GitHub's renderer puts about 210 characters beside
its plot, Anthropic's scenario chart 75. A `<section>`, `<article>` or `<main>`
ends the climb, so does a third paragraph, and so does a box with nothing to
say (no label and no paragraph).

An orphan's box is renamed `<figure>`, every attribute kept. Left a `<div>`
holding one `<span>`, Readability would replace it with a paragraph of its
own, and the marker with it.

A box the page hides is never renamed. A class that hides it (Tailwind's
`hidden`) reaches Readability only as weight, which Readability weighs on a
`<div>` and never on a `<figure>`, so a renamed box would publish a chart the
page hid. That chart is deleted, as before.

### 3. Prose is kept, chrome is dropped

Inside the host:

| | What |
|---|---|
| **Kept, as the caption** | every `<figcaption>` at any depth; every `<p>` that holds no `<svg>` (a paragraph of swatches is a legend); a `<div>` or `<span>` of inline text that reads as prose |
| **Dropped** | controls; live readouts (`role="status"`, `tooltip`, `tab`, `toolbar`, `group`, `aria-live`); anything hidden; anything Readability would remove before reading (its unlikely-candidate names and roles); swatches and icons; any run of text that reads as a label |
| **Leaves the host as it converts today** | anything else: a picture, a table, a heading, a quotation, code, math, a link outside the caption, a sentence loose beside the chart, an element nobody has considered |

**A label versus prose.** A run is prose if it is longer than 80 characters
or ends the way a sentence ends. Length alone failed: "Sales rose in every
region this quarter." is shorter than any limit and is content. No label
measured ends in a full stop. The longest measured label is 39 characters.

**The block.** It is ADR 0039's: `[Interactive figure](page#id): label`, then
the caption, its lines separated by breaks (spaces in a table cell). It is one
block, so `zh.md` stays aligned.

- **Stacked boxes split into lines.** A caption made of two or more
  `<span>`/`<div>`/`<p>` children is one line each, which un-glues "Terminal-Bench
  4.0" from "Accuracy vs Cost".
- **Said once.** A line that repeats the label is dropped.

**The label.** The host's own `aria-label` or `title`. Else the charts' own
names, each `<svg>`'s `aria-label` or `<title>`, joined. These ride across
Readability on the keep span (`data-tiro-label`) because the `<svg>` is gone by
the time the paragraph is built, and an attribute on the `<figure>` would meet
`_fixLazyImages`. Like every marker, a page-authored one is stripped first.

**Several charts in one host** are one link, one block and one capture.

### 4. One list names figures for a capture

ADR 0039 §4 named a figure by its index among the page's `<figure>`s. The list
is now `figureHosts`: every `<figure>` and every orphan host, in document
order. Both sides build it with the same exported function: the extension on
the live page, and the clip on its clone. It reads only structure, attributes
and text, so the two agree.

The index is never stored. It goes from the payload to the popup to the scout,
and back as a snapshot request.

### 5. An orphan is captured whole

The scout crops a `<figure>` to the children holding its drawing, as before.
For Anthropic's charts that is the panel: title, legend and plot, not the
footnote.

An orphan's box sets its title and legend beside the plot, and a chart whose
colours nothing names cannot be read. So it is taken whole, less two things:

- what is not on screen. GitHub's tooltip is invisible and parked at the box's
  corner, and would stretch the crop.
- its paragraphs, which the article carries as text.

## Rejected

- **One link per chart.** Two panels of one figure share a caption and a
  capture. Splitting them needs a caption per panel that no page writes.
- **Treating every nearby paragraph as caption.** That is the article. The
  climb stops at the third paragraph for this reason.
- **Hosts beyond `<div>` chains.** A `<section>` is how articles are divided.
- **The `<svg>` itself as an asset, now.** It renders blank without its
  computed styles inlined, and an HTML legend is not part of it. Kept for a
  later change, on top of this one.

## Consequences

- **The corpus sweep against `main`** changes exactly the five articles above
  (ten charts), and only at their charts.
- **The two github.blog articles do not change in the sweep.** Their static
  HTML holds only the empty mount box, so a chart mounted by script exists only
  in a live clip, as ADR 0039's canvases do. The tests stand in with a
  GHChartEngine-shaped fixture, and a headless-Chromium clip of the live page
  gives the described link and a crop with title, legend and plot.
- **Only the visible tab of a tabbed chart is kept.** Inactive panels are
  `hidden`, and Readability drops them as it did before.
- **A legend outside the host still leaks.** Econ-scenarios' key sits in the
  next box beside its caption.
- **"Interactive figure" also names a static chart.** It is one vocabulary for
  one thing: a drawing the clip links to rather than holds.
- **Capture needs the figure to stay where it was scrolled to.** Anthropic's
  smooth-scroll library put its position back after the first scroll, so the
  first chart was refused as too big. The scout now reports a figure that
  would fit but is off screen as `moved`, and the capture frames it once more.
