/**
 * Page repairs that must happen **before** Readability runs.
 *
 * Two things are lost otherwise. Math: every renderer (KaTeX, MathJax,
 * LaTeXML) ships both a visual rendering and the original TeX, and Turndown
 * flattens the visual half into glyph soup — an arXiv paper once lost its
 * whole translation to a paragraph ending in a lone `=`, which markdown reads
 * as a setext heading (ADR 0003). And languages: Turndown only reads a fence's
 * language from a `language-*` class on the `<code>`, so every page that marks
 * it up some other way arrives as an unhighlightable bare fence.
 *
 * Both are fixed by rewriting the DOM into the shape the rest of the pipeline
 * already understands, rather than by teaching the pipeline every convention.
 * Readability has to see the result, not the original: it prunes low-text
 * subtrees, and a formula it drops cannot be recovered afterwards.
 */

import type TurndownService from "turndown";

/** Marks a recovered formula for the Turndown rule in clipper.ts. */
export const MATH_ATTR = "data-tiro-math";

/**
 * Carries a fence's language across Readability, which strips `class`.
 *
 * The second marker on the `MATH_ATTR` contract, and it exists for a narrower
 * reason: `_cleanClasses` removes the `class` attribute from every element
 * Readability returns, and Turndown reads a fence's language *only* from
 * `language-*` on the `<code>`. So the language this file works out is erased
 * between the two, and every one of the vault's 50 fences is bare — the whole
 * of `recoverCodeBlocks`' language handling, and the ten tests covering it, has
 * been dead on the shipping path since it was written, because those tests go
 * straight from `prepareForClipping` to `htmlToMarkdown` and never run
 * Readability. A `data-*` attribute survives untouched, so the language rides
 * one across and `restoreCodeLanguagesIn` puts the class back afterwards.
 */
export const CODE_LANG_ATTR = "data-tiro-lang";

const TEX_ANNOTATION = 'annotation[encoding="application/x-tex"]';

/** Rendered MathJax v2 output; the TeX lives in a sibling script tag. */
const MATHJAX_V2_RENDERED =
  ".MathJax_Preview, .MathJax, .MathJax_Display, .MathJax_SVG, .MathJax_SVG_Display, .MathJax_MathML";

/**
 * Line-number gutters that syntax highlighters render *inside* the code, where
 * Turndown reads them as part of the source.
 */
const GUTTERS =
  ".lineno, .linenos, .line-numbers-rows, .line-number, .gutter, .hljs-ln-numbers, .code-line-numbers, .rouge-gutter, .ln, .lnt";

/** Conservative: a language token, not arbitrary attribute content. */
const LANG_TOKEN = /^[a-z0-9][a-z0-9+#._-]{0,19}$/i;

const LANG_CLASS_PATTERNS = [
  /^language-([\w+#.-]+)$/i,
  /^lang-([\w+#.-]+)$/i,
  /^highlight-source-([\w+#.-]+)$/i, // GitHub
  /^brush:([\w+#.-]+)$/i, // SyntaxHighlighter, after whitespace is stripped
];

const LANG_ATTRS = [
  "data-lang",
  "data-language",
  "data-code-language",
  "data-highlight-language",
];

/**
 * Patterns unambiguous enough to trust on an element that is not the code
 * itself. `data-lang` and friends are *also* the standard spelling for a
 * natural language on an i18n or tab-group wrapper, so reading them from an
 * ancestor turns `<div data-lang="en">` into ```en and costs every code block
 * on the page its highlighting — permanently, since the wrong language is
 * written into the vault.
 */
const CONTAINER_LANG_PATTERNS = [
  /^language-([\w+#.-]+)$/i,
  /^highlight-source-([\w+#.-]+)$/i, // GitHub
];

/**
 * Classes that sit beside Pandoc's `sourceCode` without being the language.
 * Its line-numbered output is `class="sourceCode numberSource javascript
 * numberLines"`, so taking the first bare class name yields "numberSource".
 */
const NOT_A_LANGUAGE = new Set([
  "sourcecode",
  "numbersource",
  "numberlines",
  "highlight",
  "chroma",
  "code",
  "hljs",
  "pre",
  "line",
]);

function texFrom(element: Element): string | null {
  const annotation = element.querySelector(TEX_ANNOTATION);
  const annotated = annotation?.textContent?.trim();
  if (annotated !== undefined && annotated !== "") return annotated;
  // LaTeXML (arXiv's HTML papers) puts the source in an attribute instead.
  const math = element.matches("math")
    ? element
    : element.querySelector("math");
  const alt = math?.getAttribute("alttext")?.trim();
  return alt !== undefined && alt !== "" ? alt : null;
}

function isDisplay(element: Element): boolean {
  if (element.closest(".katex-display, .MathJax_Display") !== null) return true;
  if (element.getAttribute("display") === "block") return true;
  if (element.getAttribute("display") === "true") return true;
  const math = element.querySelector("math");
  return math?.getAttribute("display") === "block";
}

function marker(doc: Document, tex: string, display: boolean): Element {
  const span = doc.createElement("span");
  span.setAttribute(MATH_ATTR, display ? "display" : "inline");
  // Inline math has to survive on one line; a newline inside `$…$` ends it.
  span.textContent = display ? tex : tex.replace(/\s*\n\s*/g, " ");
  return span;
}

function replaceMath(doc: Document, element: Element): void {
  const tex = texFrom(element);
  // A page that renders math without shipping its source leaves us nothing to
  // write. Removing it beats letting Turndown flatten the glyphs into text
  // that changes the document's block structure (ADR 0003).
  const display = isDisplay(element);
  // Replace the display wrapper rather than the formula inside it, or the
  // wrapper survives as an empty block — but only when this formula is the
  // whole of it. Taking a wrapper that holds two formulas would delete the
  // sibling, and the `isConnected` check below would then skip it silently.
  const wrapper = element.closest(".katex-display");
  const target =
    wrapper !== null && wrapper.children.length === 1 ? wrapper : element;
  if (tex === null) {
    target.remove();
    return;
  }
  target.replaceWith(marker(doc, tex, display));
}

function normalizeMathJaxV2(doc: Document): void {
  const scripts = Array.from(
    doc.querySelectorAll('script[type^="math/tex"]'),
  ) as Element[];
  if (scripts.length === 0) return;
  // MathJax v2 keeps the TeX in the script and renders beside it, so the
  // rendered nodes are pure duplication once the scripts are converted.
  for (const rendered of Array.from(
    doc.querySelectorAll(MATHJAX_V2_RENDERED),
  )) {
    rendered.remove();
  }
  for (const script of scripts) {
    const tex = script.textContent?.trim() ?? "";
    if (tex === "") {
      script.remove();
      continue;
    }
    const display = (script.getAttribute("type") ?? "").includes(
      "mode=display",
    );
    script.replaceWith(marker(doc, tex, display));
  }
}

/**
 * LaTeXML — which is what arXiv's HTML papers are built with — lays every
 * displayed equation out as a table: one cell for the formula, one for the
 * equation number. The `<math>` inside is marked `display="inline"`, because
 * the display-ness lives in that table rather than on the element.
 *
 * Left alone it costs twice. The formula is inside a `<td>`, so it degrades to
 * inline math, and the table itself converts to a markdown table of mostly
 * empty cells wrapped around it. Every displayed equation in the paper reads
 * as a cramped inline formula in a four-column grid.
 */
function unwrapEquationTables(doc: Document): void {
  const tables = doc.querySelectorAll(
    "table.ltx_eqn_table, table.ltx_equationgroup",
  );
  for (const table of Array.from(tables)) {
    const holder = doc.createElement("div");
    for (const math of Array.from(table.querySelectorAll("math"))) {
      math.setAttribute("display", "block");
      const paragraph = doc.createElement("p");
      paragraph.appendChild(math);
      holder.appendChild(paragraph);
    }
    if (holder.childNodes.length === 0) continue;
    table.replaceWith(holder);
  }
}

function normalizeMath(doc: Document): void {
  normalizeMathJaxV2(doc);
  // Document order puts a container ahead of the `<math>` nested inside it, so
  // the container wins and the descendant is skipped as already detached.
  const candidates = Array.from(
    doc.querySelectorAll("span.katex, mjx-container, math"),
  );
  for (const element of candidates) {
    if (!element.isConnected) continue;
    replaceMath(doc, element);
  }
}

function classListOf(element: Element): string[] {
  return (
    (element.getAttribute("class") ?? "")
      // SyntaxHighlighter writes `class="brush: js;"` — one token, oddly spaced.
      .replace(/\s*:\s*/g, ":")
      .split(/\s+/)
      .map((name) => name.replace(/;$/, ""))
      .filter((name) => name !== "")
  );
}

function languageFromClasses(
  element: Element | null,
  patterns: readonly RegExp[] = LANG_CLASS_PATTERNS,
): string | null {
  if (element === null) return null;
  const classes = classListOf(element);
  for (const name of classes) {
    for (const pattern of patterns) {
      const value = name.match(pattern)?.[1];
      if (value !== undefined && LANG_TOKEN.test(value)) return value;
    }
  }
  if (patterns !== LANG_CLASS_PATTERNS) return null;
  // Pandoc writes `class="sourceCode javascript"` — the language is a bare
  // class name, only safe to read because `sourceCode` vouches for it.
  if (classes.some((name) => name.toLowerCase() === "sourcecode")) {
    const bare = classes.find(
      (name) =>
        !NOT_A_LANGUAGE.has(name.toLowerCase()) && LANG_TOKEN.test(name),
    );
    if (bare !== undefined) return bare;
  }
  return null;
}

function languageFromAttrs(element: Element | null): string | null {
  if (element === null) return null;
  for (const attr of LANG_ATTRS) {
    const value = element.getAttribute(attr)?.trim();
    if (value !== undefined && LANG_TOKEN.test(value)) return value;
  }
  return null;
}

/**
 * Chroma's line-numbered layout is a two-column table: numbers on the left,
 * code on the right. Left alone it converts to a markdown *table* holding a
 * code block. Unwrapping to the code cell's `<pre>` is the only repair that
 * leaves a fence behind.
 */
function unwrapChromaTables(doc: Document): void {
  for (const table of Array.from(doc.querySelectorAll("table.lntable"))) {
    const cells = table.querySelectorAll("td.lntd");
    const codeCell = cells[cells.length - 1];
    const pre = codeCell?.querySelector("pre");
    if (pre === undefined || pre === null) continue;
    // Chroma often emits the code cell with no <code> inside. Turndown's
    // fenced-code rule requires one, so unwrapping alone would turn the block
    // into a paragraph — indentation and monospace gone.
    if (pre.querySelector("code") === null) {
      const code = doc.createElement("code");
      while (pre.firstChild !== null) code.appendChild(pre.firstChild);
      pre.appendChild(code);
    }
    table.replaceWith(pre);
  }
}

/**
 * Copy every fence's language onto `CODE_LANG_ATTR`, so extraction cannot erase
 * it.
 *
 * A separate pass over the finished DOM rather than a line inside the loop
 * above, and that is what makes it complete: `recoverCodeBlocks` returns early
 * for a `<code>` that already declares `language-*`, which is the *common*
 * case — a page that marks its code up correctly — and a marker written only on
 * the recovery branch would leave exactly those pages bare. Reading the final
 * class state covers both branches with one rule.
 *
 * Read with Turndown's own regex from the node Turndown reads, so the marker is
 * a copy of the value that would have been used rather than a second opinion
 * about it. `LANG_TOKEN` gates the write: a junk class writes no marker and the
 * fence comes out bare, which is what happens today.
 */
function markCodeLanguages(doc: Document): void {
  // A page's own attributes are untrusted input, and this one is read back
  // after Readability with no record of who wrote it. Clearing the document
  // first is what makes "the marker holds a value this pass produced" true
  // rather than merely usual: a page-authored marker otherwise reaches
  // `restoreCodeLanguagesIn` and, with backticks in it, opens a fence markdown
  // cannot close — which drops the block out of `code`, hands it to the
  // translator, and swallows the prose after it (ADR 0003).
  for (const stale of Array.from(doc.querySelectorAll(`[${CODE_LANG_ATTR}]`))) {
    stale.removeAttribute(CODE_LANG_ATTR);
  }
  for (const code of Array.from(doc.querySelectorAll("pre > code"))) {
    const declared = (code.getAttribute("class") ?? "").match(/language-(\S+)/);
    const language = declared?.[1];
    if (language === undefined || !LANG_TOKEN.test(language)) continue;
    code.setAttribute(CODE_LANG_ATTR, language);
  }
}

/**
 * Put the language back as the class Turndown reads.
 *
 * Runs **after** Readability, like `foldFiguresIn` and through the same scratch
 * document. Restoring the class rather than adding a Turndown rule for the
 * marker is the cheaper half of the contract by some distance: Turndown's
 * `fencedCodeBlock` already widens a fence when the code itself contains
 * backticks, and a rule of our own would have to carry a copy of that
 * arithmetic and keep it in step with the library forever.
 *
 * The marker is always removed, so the raw-body fallback — where the class was
 * never stripped and is found still in place below — does not carry a stray
 * attribute into the markdown either.
 */
export function restoreCodeLanguagesIn(html: string, doc: Document): string {
  const scratch = doc.implementation.createHTMLDocument("");
  scratch.body.innerHTML = html;
  for (const code of Array.from(
    scratch.querySelectorAll(`code[${CODE_LANG_ATTR}]`),
  )) {
    const language = code.getAttribute(CODE_LANG_ATTR);
    code.removeAttribute(CODE_LANG_ATTR);
    // Validated again rather than trusted from across the extraction boundary.
    // The write side already gates on LANG_TOKEN, so this can only fire for a
    // value that was never ours — and what it costs to be wrong is not a
    // missing language but a fence whose info string breaks the block.
    if (language === null || !LANG_TOKEN.test(language)) continue;
    const classes = (code.getAttribute("class") ?? "").trim();
    // Already there on the raw-body path, where nothing stripped it.
    if (/(^|\s)language-\S/.test(classes)) continue;
    code.setAttribute(
      "class",
      classes === ""
        ? `language-${language}`
        : `${classes} language-${language}`,
    );
  }
  return scratch.body.innerHTML;
}

function recoverCodeBlocks(doc: Document): void {
  unwrapChromaTables(doc);
  for (const pre of Array.from(doc.querySelectorAll("pre"))) {
    for (const gutter of Array.from(pre.querySelectorAll(GUTTERS))) {
      gutter.remove();
    }
    let code = pre.querySelector("code");
    if (code === null) {
      // Turndown's fenced-code rule needs a <code>, and Sphinx/docutils — so
      // Python's own docs and most of its ecosystem — emit `<pre>` with only
      // spans inside. Without one the whole block converts to prose: the
      // indentation goes, and Turndown escapes its way through the source.
      code = doc.createElement("code");
      while (pre.firstChild !== null) code.appendChild(pre.firstChild);
      pre.appendChild(code);
    }
    // Turndown already reads this one; leave it exactly as the page wrote it.
    if (classListOf(code).some((name) => /^language-./i.test(name))) continue;
    // Otherwise widen out from the element Turndown reads, one container at
    // a time, and stop at the first container that names a language.
    const language =
      languageFromClasses(code) ??
      languageFromAttrs(code) ??
      languageFromClasses(pre) ??
      languageFromAttrs(pre) ??
      // Containers get the narrow patterns only — see CONTAINER_LANG_PATTERNS.
      languageFromClasses(pre.parentElement, CONTAINER_LANG_PATTERNS) ??
      languageFromClasses(
        pre.parentElement?.parentElement ?? null,
        CONTAINER_LANG_PATTERNS,
      );
    if (language === null) continue;
    const classes = (code.getAttribute("class") ?? "").trim();
    code.setAttribute(
      "class",
      `${classes === "" ? "" : `${classes} `}language-${language.toLowerCase()}`,
    );
  }
  markCodeLanguages(doc);
}

/**
 * Flatten every `title` attribute onto one line.
 *
 * Turndown copies a link's title straight into `[text](href "title")`. arXiv
 * writes the whole section path into one — `title="In 2.1 Kolmogorov-Arnold
 * Representation theorem ‣ 2 ..."` — and when that path contains a formula the
 * attribute contains the MathML's *rendered* newlines. The emitted title then
 * never closes on its line, so the link never terminates, and the lines it
 * swallows arrive as prose. One of them is routinely a lone `=`, which markdown
 * reads as a setext heading: the paragraph above it becomes an `<h1>`.
 *
 * That is the "prose rendered as a giant headline" failure, and `headingStyle:
 * "atx"` cannot prevent it — the `=` comes from the title text, not from a
 * heading rule. Collapsing the whitespace fixes the link; dropping the quote
 * stops a title from closing itself early and spilling the rest as link text.
 */
function normalizeLinkTitles(doc: Document): void {
  for (const element of Array.from(doc.querySelectorAll("[title]"))) {
    const title = element.getAttribute("title");
    if (title === null) continue;
    const flattened = title.replace(/\s+/g, " ").replace(/"/g, "").trim();
    if (flattened === "") element.removeAttribute("title");
    else if (flattened !== title) element.setAttribute("title", flattened);
  }
}

/**
 * Drop a list item's own rendered marker.
 *
 * LaTeXML numbers `<ol>` items itself, writing the label into the item as
 * `<span class="ltx_tag_item">(1)</span>` — the `<ol>` supplies a marker too,
 * so Turndown emits both: `1.  (1)`, with the item's actual text pushed into a
 * paragraph below. The list reads as a numbered list of bare numbers. 43 items
 * in one paper look like this.
 *
 * Scoped to `ltx_tag_item` rather than every `ltx_tag`: the equation and
 * section variants carry numbers that nothing else reproduces.
 */
function stripRedundantListMarkers(doc: Document): void {
  for (const tag of Array.from(doc.querySelectorAll("li > .ltx_tag_item"))) {
    tag.remove();
  }
}

/**
 * Replace `<picture>` with the `<img>` it wraps.
 *
 * Turndown has no rule for `<picture>`, and it is not one of the element names
 * Turndown calls a block, so the element is inline: Turndown captures the
 * whitespace flanking its content and re-attaches it *around* whatever a rule
 * returns. A page that pretty-prints its markup puts a newline and an indent
 * before each `<source>`, so that flanking whitespace is real, and the image
 * lands several spaces into its line — which markdown reads as an indented code
 * block. The site then renders the literal text `![](…)` in a highlighted box
 * and the picture never appears. One clipped article lost all five of its
 * images this way; two more carry the same shape without having surfaced it.
 *
 * A Turndown rule cannot fix this. The flanking whitespace is added outside the
 * rule's return value, so trimming inside the replacement is a no-op — measured,
 * not assumed. Removing the wrapper in the DOM deletes the whitespace text
 * nodes themselves, which is the same move `unwrapChromaTables` makes for the
 * same reason: hand Turndown a shape it already converts correctly.
 *
 * The `<img>` keeps its own `src`, the fallback the page nominated. Choosing
 * among `<source srcset>` candidates would mean picking a resolution on the
 * reader's behalf from media queries this has no viewport to evaluate.
 */
function unwrapPictures(doc: Document): void {
  for (const picture of Array.from(doc.querySelectorAll("picture"))) {
    const img = picture.querySelector("img");
    // No <img> means the page relied entirely on <source srcset>, which
    // Turndown drops regardless. Leave it for Readability to discard.
    if (img === null) continue;
    picture.replaceWith(img);
  }
}

/**
 * Remove an `<svg>` that paints text, so a chart cannot arrive as glyph soup.
 *
 * Turndown has no rule for `<svg>` and does not call it a block, so it keeps
 * walking and emits every text node inside — in document order, with no
 * separators, because SVG lays its labels out by coordinate rather than by
 * flow. A scatter plot's axis ticks, series names and value labels come out as
 * one run: `0123Speedup on an NVIDIA H100 (×)Original implementationChromBPNet
 * (6M)2.1-kb DNA sequence…1.6×1.8×1.4×`. The site renders that as a body
 * paragraph and the processor sends it to the translator, which dutifully
 * translates it.
 *
 * Deleting is the whole fix available here, and it is a real improvement
 * rather than a concession: the chart is *already* lost — markdown has no
 * element for it — so the only question is whether its labels are published as
 * prose. Capturing the picture instead is not the alternative it looks like.
 * The chart that prompted this fills its marks from `var(--chart-*)` tokens
 * defined on an ancestor, so an `<svg>` lifted out of the page renders blank;
 * making it an asset would mean inlining computed styles, which is a different
 * change with its own ADR.
 *
 * Three things keep this off text that is not debris. It reads `<text>`, the
 * only SVG element that paints glyphs, so `<title>` and `<desc>` — which are
 * accessibility labels — are never a reason to delete anything. It never
 * touches an `<svg>` inside a link, whose text is the link's label. And it
 * requires `SOUP_LABELS` of them, so a single painted label is left alone and
 * converts exactly as it does today; only a chart's worth of them is soup.
 *
 * Must run after `normalizeMath`, which replaces MathJax's rendered SVG with
 * its TeX. MathJax paints with `<path>`, so the scoping above spares it
 * anyway; the ordering is what makes that a guarantee instead of a
 * coincidence.
 */
/**
 * How many painted labels make an `<svg>` a chart rather than a caption.
 *
 * Measured, not guessed: the seven charts on the article that prompted this
 * carry 17 to 31 `<text>` elements each. A label — a button, a badge, a
 * diagram's single annotation — carries one. Four is far above anything a
 * label plausibly reaches and far below the smallest real chart, so the rule
 * does not depend on where in that gap it sits.
 *
 * Counting `<text>` rather than `<text>, <tspan>` keeps it that way: a label
 * split across three `<tspan>`s is still one label.
 */
const SOUP_LABELS = 4;

function dropChartSvgs(doc: Document): void {
  for (const svg of Array.from(doc.querySelectorAll("svg"))) {
    // An `<a>`'s SVG text is the link's only label. Deleting it leaves `[](…)`,
    // a link with no text — strictly worse than the soup this pass removes.
    if (svg.closest("a") !== null) continue;
    const labels = Array.from(svg.querySelectorAll("text")).filter(
      (node) => (node.textContent ?? "").trim() !== "",
    ).length;
    if (labels < SOUP_LABELS) continue;
    svg.remove();
  }
}

/**
 * Inline elements a caption may carry into a paragraph.
 *
 * An allow-list, not a list of blocks to reject, because the two failures are
 * not symmetric. An inline element missing from this list costs a figure,
 * which then converts exactly as it does today. A *block* element missing from
 * a reject-list costs the promise this pass exists to make: Turndown puts
 * blank lines around anything it calls a block, and the single block becomes
 * several, which is the alignment contract in ADR 0003. Turndown's block set
 * is long — section, article, aside, dl, hr and more — and a reject-list would
 * have to stay in sync with the library to stay correct.
 */
const CAPTION_INLINE: ReadonlySet<string> = new Set([
  "A",
  "ABBR",
  "B",
  "BDI",
  "BDO",
  "BR",
  "CITE",
  "CODE",
  "DEL",
  "DFN",
  "EM",
  "I",
  "IMG",
  "INS",
  "KBD",
  "MARK",
  "Q",
  "RP",
  "RT",
  "RUBY",
  "S",
  "SAMP",
  "SMALL",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "TIME",
  "U",
  "VAR",
  "WBR",
]);

/** Children that carry content; whitespace between tags does not. */
function meaningfulChildren(element: Element): Node[] {
  return Array.from(element.childNodes).filter((node) => {
    if (node.nodeName === "#comment") return false;
    if (node.nodeName === "#text") {
      return (node.textContent ?? "").trim() !== "";
    }
    return true;
  });
}

/** True when everything inside `root` is content a paragraph can hold. */
function isFoldableContent(root: Element): boolean {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (!CAPTION_INLINE.has(element.nodeName)) return false;
    // A recovered display formula emits its own blank lines (mathTurndownRule),
    // and a <p> is not one of the BLOCK_HOSTILE contexts that demote it to
    // inline — so it would split the block from inside an allowed <span>.
    if (element.getAttribute(MATH_ATTR) === "display") return false;
  }
  return true;
}

/** True when any ancestor of `node` is a link. */
function insideLink(node: Element): boolean {
  let current: Node | null = node.parentNode;
  while (current !== null) {
    if (current.nodeName === "A") return true;
    current = current.parentNode;
  }
  return false;
}

/**
 * The link wrapping `image` inside `figure`, if the figure holds one.
 *
 * A captioned image linking to its full-size version is the common lightbox
 * shape; rebuilding the paragraph from the image alone would silently drop it.
 */
function linkWrapping(image: Element, figure: Element): Element | null {
  let current: Node | null = image.parentNode;
  while (current !== null && current !== figure) {
    if (current.nodeName === "A") return current as Element;
    current = current.parentNode;
  }
  return null;
}

/**
 * Elements that may be dropped from between a link and its image.
 *
 * The test a wrapper has to pass is that removing it leaves the markdown
 * unchanged. `<div>`, `<p>` and `<span>` carry no meaning of their own around
 * a lone image, so `<a><div><img></div></a>` and `<a><img></a>` convert
 * identically. `<p>` is on the list because **Readability rewrites a wrapper
 * `<div>` into one**: by the time this runs, Substack's shape is
 * `<a><p><img></p></a>`, and leaving `<p>` off meant the fold quietly stopped
 * happening for the one page shape the wrapper handling exists for. `<em>`,
 * `<del>`, `<code>` and their kind do not: dropping `<del>` turns
 * `[~~![](x)~~](full)` into `[![](x)](full)`, which says the page struck the
 * image through when it did not.
 *
 * An allow-list, so an element nobody has considered leaves the figure
 * unfolded rather than being silently discarded.
 */
const DISPOSABLE_WRAPPERS: ReadonlySet<string> = new Set(["DIV", "P", "SPAN"]);

/**
 * True when `link` holds `image` through a chain of disposable wrappers and
 * nothing else — no sibling at any depth, and nothing between them that means
 * something.
 *
 * Structural rather than a text test, because what has to be protected here is
 * not all textual: an `<hr>` or an `<svg>` beside the image carries no text but
 * is still content, and `<em>` carries no text of its own at all.
 */
function isWrapperChain(link: Element, image: Element): boolean {
  let current: Element = link;
  while (current !== image) {
    const children = meaningfulChildren(current);
    const [only] = children;
    if (children.length !== 1 || only === undefined) return false;
    // "#text" and "#comment" cannot wrap anything, and the walk has to reach
    // the image for the chain to be one.
    if (only.nodeName.startsWith("#")) return false;
    if (only !== image && !DISPOSABLE_WRAPPERS.has(only.nodeName)) return false;
    current = only as Element;
  }
  return true;
}

/**
 * Make `image` the link's only child, dropping the layout elements between.
 *
 * A wrapper is usually a `<div>`, which Turndown calls a block and therefore
 * surrounds with blank lines — *inside* the paragraph being built, splitting
 * the block this pass promises is one. Removing it hands Turndown the shape it
 * already converts correctly, exactly the move `unwrapPictures` makes and for
 * the same reason.
 *
 * Discarding the link's children wholesale is safe only because `isWrapperChain`
 * has established there is nothing among them to lose: one meaningful child at
 * every step from the link down to the image.
 */
function unwrapWrappers(link: Element, image: Element): void {
  if (link.firstChild === image && link.childNodes.length === 1) return;
  while (link.firstChild !== null) link.removeChild(link.firstChild);
  link.appendChild(image);
}

/**
 * The picture a figure holds — its image, or the link wrapping it — or `null`
 * when that link carries anything besides the image.
 *
 * The site reads a link as a picture only when an image is its sole content
 * (`isPicture` in `apps/site/src/lib/render.ts`). A wrapper holding overlay
 * text converts to `[![](x)Zoom](full)`, which the renderer declines to make a
 * figure of — so folding it would produce a block that buys nothing and quietly
 * disagrees with the contract in ADR 0011. The two definitions have to move
 * together; this is the clipper's half of that.
 */
function pictureOf(image: Element, figure: Element): Element | null {
  const link = linkWrapping(image, figure);
  if (link === null) return image;
  // Wrapper elements between the link and its image are fine — Substack ships
  // `<a><div><img></div></a>`, the shape `inlineLinkRule` exists to flatten
  // (see markdown.ts), and it flattens to `[![](x)](full)`, exactly what the
  // site reads as a picture. `unwrapWrappers` below drops them so Turndown
  // never sees the block element.
  //
  // The chain must be checked structurally rather than by asking whether the
  // link holds any text. `<a><div><img></div><hr></a>` has no text at all, so
  // a text check calls it "nothing but the image" and the unwrap then deletes
  // the `<hr>`. Requiring one meaningful child at every step is what makes
  // that unwrap lossless by construction — and it rejects overlay text on the
  // same rule, since `<span>Zoom</span>` is a second child.
  if (!isWrapperChain(link, image)) return null;
  return link;
}

/**
 * True when every line break in the caption survives the fold.
 *
 * Turndown writes a `<br>` as `"  \n"`, so two in a row make a blank line —
 * and a blank line ends the block this pass promises is one. A break at the
 * very start does the same, because the separator inserted before the caption
 * is itself a break. A single break between lines, or one at the end, keeps
 * the block whole and is worth allowing: captions marked up over two lines
 * are common, and rejecting them would cost figures for nothing.
 *
 * Flattened across nesting, because `<em>A<br><br>B</em>` produces the same
 * blank line as `A<br><br>B` does.
 */
function breaksAreSafe(source: Element): boolean {
  const sequence: ("break" | "content")[] = [];
  const collect = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeName === "BR") {
        sequence.push("break");
      } else if (child.nodeName === "#text") {
        if ((child.textContent ?? "").trim() !== "") sequence.push("content");
      } else if (child.nodeName === "IMG") {
        sequence.push("content");
      } else {
        collect(child);
      }
    }
  };
  collect(source);
  if (sequence[0] === "break") return false;
  return !sequence.some(
    (kind, index) => kind === "break" && sequence[index - 1] === "break",
  );
}

/**
 * The element whose children hold the caption's inline content, or `null` when
 * the caption carries anything a paragraph cannot absorb.
 */
function captionSource(caption: Element): Element | null {
  const children = meaningfulChildren(caption);
  const [only] = children;
  // A caption marked up as a single paragraph is the common shape and unwraps
  // cleanly — but only when that paragraph is the caption's *whole* content.
  // `Lead<p>Rest</p>Tail` is not that shape, and unwrapping it would publish
  // `Rest` and silently drop the rest of the sentence.
  const source =
    children.length === 1 && only?.nodeName === "P"
      ? (only as Element)
      : caption;
  if (!isFoldableContent(source) || !breaksAreSafe(source)) return null;
  return source;
}

/**
 * Fold a `<figure>`'s caption into the same paragraph as its image.
 *
 * Turndown has no figure rule, so `<figure>`/`<figcaption>` convert as two
 * plain blocks: a markdown image, a blank line, then an ordinary paragraph.
 * Nothing downstream can then tell the caption from the article's next
 * sentence — on an academic post a credit line reads as the author's own
 * prose, and 12 of the vault's 32 articles carry figures.
 *
 * Emitting a real `<figure>` was tried and reverted (ADR 0011): markdown
 * cannot express the association, so the rule emitted raw HTML, and raw HTML
 * is opaque to every service this pipeline provides. What markdown *can*
 * express is co-location — one paragraph holding both — which is what this
 * builds. The block stays a single block, so alignment and translation are
 * untouched, and the association cannot desync from the content because it is
 * the content's shape.
 *
 * A `<br>` rather than a bare newline: Turndown collapses whitespace in text
 * nodes, so a newline would leave the caption running on from the image, while
 * a hard break keeps the two legible as separate lines in the raw markdown.
 *
 * Runs after Readability — see `foldFiguresIn`, the exported entry point.
 *
 * Every bail-out below leaves the figure converting exactly as it does today.
 * That is the cheap direction: a figure that keeps reading as loose prose is
 * the defect this fixes, while a fold that guesses wrong drops content off the
 * page or breaks the one-block promise the site and `zh.md` both rely on.
 */
/**
 * Fold every figure in already-extracted article HTML.
 *
 * Runs **after** Readability, unlike everything else in this file, and that is
 * the whole point. Readability decides what to keep by reading attributes —
 * `hidden`, `aria-hidden`, inline `display: none`, and the class and id names
 * it scores against — and folding replaces the elements carrying them. Done
 * first, `<figure hidden>` became a plain `<p>` and Readability then published
 * an image the page had deliberately hidden; a `hidden` wrapper inside the
 * figure's link did the same. Verified end to end, both ways round.
 *
 * Guarding those attributes instead would mean re-deriving Readability's
 * selection rules here, which this file already knows better than to attempt:
 * `unhideGuessedHeaderTables` exists only because one of those rules is a
 * regex over class names. Running afterwards means no fold can change what was
 * selected, whatever attributes it drops.
 *
 * Safe this late because the shapes it needs survive extraction: Readability
 * keeps `<figure>` and `<figcaption>`, and `<picture>` was already unwrapped
 * before it.
 *
 * Takes a `Document` only to borrow its implementation for a scratch document;
 * the HTML passed in is what gets folded.
 */
export function foldFiguresIn(html: string, doc: Document): string {
  const scratch = doc.implementation.createHTMLDocument("");
  scratch.body.innerHTML = html;
  foldFigureCaptions(scratch);
  return scratch.body.innerHTML;
}

function foldFigureCaptions(doc: Document): void {
  for (const figure of Array.from(doc.querySelectorAll("figure"))) {
    // A link around the whole figure would swallow the caption:
    // `inlineLinkRule` flattens a link's content onto one line, so the
    // paragraph would open with a link rather than an image, the caption would
    // become clickable, and the site would not read it as a figure at all.
    if (insideLink(figure)) continue;
    const images = figure.querySelectorAll("img");
    // Exactly one, or which picture the caption describes is a guess.
    if (images.length !== 1) continue;
    const image = images[0];
    if (image == null) continue;
    const caption = figure.querySelector("figcaption");
    if (caption === null || (caption.textContent ?? "").trim() === "") continue;
    const source = captionSource(caption);
    if (source === null) continue;
    const picture = pictureOf(image, figure);
    if (picture === null) continue;
    // The figure must hold nothing beyond the picture and its caption.
    // Replacing it with a paragraph built from those two would drop anything
    // else it carries — a note after the caption, a stray sentence — and
    // losing content off the page is far worse than a caption that still
    // reads as prose.
    const children = meaningfulChildren(figure);
    if (
      children.length !== 2 ||
      !children.includes(picture) ||
      !children.includes(caption)
    ) {
      continue;
    }
    // Only now that nothing can still bail: this edits the link in place.
    if (picture !== image) unwrapWrappers(picture, image);
    const paragraph = doc.createElement("p");
    paragraph.appendChild(picture);
    paragraph.appendChild(doc.createElement("br"));
    while (source.firstChild !== null) {
      paragraph.appendChild(source.firstChild);
    }
    figure.replaceWith(paragraph);
  }
}

/**
 * Unwrap a `<div>` that exists only to lay a figure out, so Readability cannot
 * mistake the page's CSS for a verdict on the content.
 *
 * `_cleanConditionally` scores an element by its class name before it looks at
 * what the element holds, and Readability's `negative` regex contains
 * **`media`**. A CSS-module class like
 * `MediaGalleryView-module-scss-module__6QZEyW__media-gallery` matches it, so
 * `weight` is -25, so `weight + contentScore < 0` returns true and the subtree
 * is deleted — before any of the checks written to protect images
 * (`img > 1 && p / img < 0.5`, the list-of-images exception) is reached. One
 * clipped article lost all three of its images and a `<figcaption>` this way,
 * and published as if the page had never had a picture in it.
 *
 * The same shape as `unhideGuessedHeaderTables` below: Readability judging
 * content by a regex over class names, and a class name colliding with it by
 * accident. The remedy is the same too — hand it a DOM it judges correctly
 * rather than re-deriving its rules here, which this file knows better than to
 * attempt.
 *
 * Unwrapping rather than only stripping the class, because the wrapper costs a
 * second thing. Readability rewrites a phrasing-only `<div>` into a `<p>`, so a
 * declassified `<figure><div><img></div><figcaption>` arrives as
 * `<figure><p><img></p><figcaption>` — and `foldFigureCaptions` reads the
 * figure's children as `[p, figcaption]`, does not find the picture among them,
 * and declines to fold. Measured on that article: stripping the class restores
 * 3 images and 0 of 3 captions; unwrapping restores 3 and 3.
 *
 * Dropping the element is markdown-neutral. Turndown calls `<div>` a block and
 * surrounds it with blank lines whether or not it is there, which is the same
 * ground `unwrapPictures` stands on.
 *
 * **Scoped to figure markup**, and that guard is the point rather than a
 * detail. This runs *before* Readability and removes the very attributes
 * Readability selects on — the hazard ADR 0011 recorded when figure folding had
 * to be moved after extraction, because folding first republished images a page
 * had marked hidden. Requiring a `<figure>` in reach means the pass can only
 * act on markup the page itself has declared to be a figure: a
 * `<div class="sidebar"><img></div>` is untouched and Readability's rejection
 * of it still stands. The unscoped variant produced byte-identical output on
 * the article that prompted this, so the guard costs nothing there and bounds
 * the blast radius everywhere else.
 */
function unwrapMediaWrappers(doc: Document): void {
  for (const div of Array.from(doc.querySelectorAll("div"))) {
    // An ancestor unwrapped earlier in this loop takes its descendants with it.
    const parent = div.parentNode;
    if (parent === null) continue;
    // Never a wrapper that carries anything beyond layout. Unwrapping discards
    // the element's attributes, and Readability reaches several verdicts from
    // them before it scores anything — hidden, furniture, byline. Rather than
    // mirror each, refuse anything whose attributes could mean something.
    if (readabilityHides(div) || carriesMoreThanLayout(div)) continue;
    if (
      div.closest("figure") === null &&
      div.querySelector("figure") === null
    ) {
      continue;
    }
    if (!holdsOnlyMedia(div)) continue;
    while (div.firstChild !== null) parent.insertBefore(div.firstChild, div);
    parent.removeChild(div);
  }
}

/**
 * Readability's `unlikelyCandidates` / `okMaybeItsACandidate` pair and its
 * `byline` regex, copied from `Readability.js:140` and `:150`.
 *
 * These are a *different* judgement from the one this pass exists to correct.
 * `_getClassWeight` gives an element a score and its regex contains `media`;
 * these delete a region outright, before scoring, and deliberately do not.
 * Keeping the two apart is what lets a gallery be rescued without a sidebar
 * being rescued alongside it.
 */
const UNLIKELY_CANDIDATES =
  /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i;
const MAYBE_A_CANDIDATE = /and|article|body|column|content|main|shadow/i;
const BYLINE = /byline|author|dateline|writtenby|p-author/i;

/**
 * Readability's `negative` regex (`Readability.js:146`) with the single token
 * `media` removed — the one collision this pass exists to correct.
 *
 * `_getClassWeight` docks 25 points for any of these, and `_cleanConditionally`
 * deletes an element outright once `weight + contentScore < 0`. That is how a
 * gallery is lost, so every *other* token here deletes furniture the same way
 * and is doing its job: `promo`, `widget`, `contact`, `share`, `tags` and the
 * rest name things a reader did not ask for.
 *
 * `hidden` is the one that would hurt most. `class="hidden"` is how Tailwind
 * and Bootstrap spell `display: none`, and Readability catches it *only* here —
 * `_isProbablyVisible` reads the inline style attribute, not a stylesheet — so
 * discarding this class is enough to publish content the page never rendered.
 * `readabilityHides` cannot cover it: there is no stylesheet in scope to ask.
 *
 * Splitting one token out of a copied regex is worth the awkwardness. The
 * alternative — matching `negative` and then re-testing to see whether `media`
 * was the reason — has to decide what a class matching both `media` and `promo`
 * means, and the answer is "leave it alone", which is what this already says.
 */
const NEGATIVE_EXCEPT_MEDIA =
  /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i;

/**
 * Attributes a wrapper may carry and still be nothing but layout.
 *
 * `data-*` joins them because Readability reads none of it on a `<div>`, and
 * real wrappers do carry it: across the 34-article corpus the only attributes
 * ever seen on an unwrap candidate are `class`, `data-*`, and none at all.
 */
const LAYOUT_ATTRS: ReadonlySet<string> = new Set(["class", "style"]);

/**
 * True when the wrapper carries anything beyond layout — in which case leave it
 * exactly as it is.
 *
 * This is written as an allow-list, and that is the whole point of it. The
 * alternative — enumerating the verdicts Readability reaches before scoring and
 * mirroring each — was tried and failed three times running: first the
 * visibility checks were mirrored but not `_removeUnlikelyCandidates`, so a
 * `<div class="sidebar">` published its picture as the article's; then that was
 * mirrored but not `_isValidByline`, so a `<div rel="author">` around a
 * portrait cost the article its byline *and* published the portrait as content.
 * Every one of those was an attribute this pass discards on the way past.
 *
 * So the question asked here is not "which of Readability's rules apply?" but
 * "is there anything here that could mean something?" — `rel`, `itemprop`,
 * `role`, `hidden`, `aria-*`, `id` and anything not yet invented all fail it
 * together, and a rule nobody has read yet cannot be missed. What remains is
 * `class`, and there the rule is narrower than "it only costs weight": exactly
 * one token, `media`, is treated as a false positive. Every other reason
 * Readability has to reject a class still stands — the rest of the
 * negative-weight regex, the unlikely-candidate pair, the byline signals.
 *
 * Only the element's own attributes matter. Unwrapping a wrapper *inside* a
 * rejected region is harmless: the region keeps its own, so Readability still
 * removes the whole subtree.
 */
function carriesMoreThanLayout(element: Element): boolean {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name;
    if (!LAYOUT_ATTRS.has(name) && !name.startsWith("data-")) return true;
  }
  // `id` is refused above, so the class is the whole of what Readability would
  // have matched on.
  const names = element.className;
  // Every negative-weight verdict but the diagnosed one still stands. Note the
  // asymmetry with the line below: `okMaybeItsACandidate` rescues an unlikely
  // candidate, and Readability has no equivalent rescue here, so neither does
  // this — a positive token cancels the *score*, not the reason for caution.
  if (NEGATIVE_EXCEPT_MEDIA.test(names)) return true;
  if (UNLIKELY_CANDIDATES.test(names) && !MAYBE_A_CANDIDATE.test(names)) {
    return true;
  }
  return BYLINE.test(names);
}

/**
 * Mirrors Readability's `_isProbablyVisible`, which is what decides whether an
 * element's subtree is dropped before scoring even begins.
 *
 * Stricter than the original in one place — Readability's `fallback-image`
 * escape hatch is a substring test over the whole `className`, and this is a
 * class-name test — because the two failures are not symmetric. Reporting
 * "hidden" for something Readability would keep only means the wrapper stays,
 * which is exactly today's behaviour. The reverse republishes a picture the
 * page hid.
 */
function readabilityHides(element: Element): boolean {
  if (element.hasAttribute("hidden")) return true;
  if (
    element.getAttribute("aria-hidden") === "true" &&
    !classListOf(element).includes("fallback-image")
  ) {
    return true;
  }
  const style = (element as HTMLElement).style;
  return style?.display === "none" || style?.visibility === "hidden";
}

/**
 * Elements a layout wrapper may hold and still be nothing but layout.
 *
 * An allow-list for the same reason `CAPTION_INLINE` is one: an element nobody
 * has considered leaves the wrapper in place, which is what happens today.
 * A reject-list would have to name every element that means something.
 */
const MEDIA_ONLY: ReadonlySet<string> = new Set([
  "FIGURE",
  "FIGCAPTION",
  "IMG",
  "PICTURE",
  "SOURCE",
]);

/**
 * True when `div` holds at least one image and nothing but media around it.
 *
 * The image requirement is what keeps this from unwrapping arbitrary layout:
 * the pass exists to save pictures, and a wrapper with no picture in it has
 * nothing to save. Text is disqualifying wherever it appears outside a
 * `<figcaption>` — a wrapper that carries a sentence is carrying content, and
 * the class name Readability objected to may well be about that sentence.
 */
function holdsOnlyMedia(div: Element, seen: Set<Element> = new Set()): boolean {
  // Defensive against a malformed tree; a cycle would otherwise not terminate.
  if (seen.has(div)) return false;
  seen.add(div);
  if (div.getElementsByTagName("img").length === 0) return false;
  for (const node of meaningfulChildren(div)) {
    if (node.nodeName.startsWith("#")) return false;
    const element = node as Element;
    if (MEDIA_ONLY.has(element.nodeName)) continue;
    // A link is media only when it is a picture link and nothing else — the
    // same reading `pictureOf` takes, and for the same reason: overlay text
    // beside the image is content, and unwrapping would strand it.
    if (element.nodeName === "A") {
      const images = element.getElementsByTagName("img");
      const image = images.length === 1 ? images[0] : undefined;
      if (image === undefined) return false;
      if (!isWrapperChain(element, image)) return false;
      continue;
    }
    if (element.nodeName === "DIV" && holdsOnlyMedia(element, seen)) continue;
    return false;
  }
  return true;
}

/**
 * Unwrap the layout `<div>`s around a code block, so Readability cannot read
 * the page's CSS as a verdict on the content.
 *
 * The same accident as `unwrapMediaWrappers`, arriving through a different
 * class name. `_cleanConditionally` deletes an element outright once
 * `weight + contentScore < 0`, and `contentScore` is a literal `0` there, so a
 * single negative-weight token deletes the subtree before any check that looks
 * at what the element holds. `_getClassWeight`'s regex is a *substring* test,
 * and Tailwind's compound utilities collide with it by accident:
 * `overflow-hidden` and `outline-hidden` contain `hidden`, `code-block-scroll`
 * and `overflow-y-scroll` contain `scroll`. One clipped article lost all 15 of
 * its code blocks that way and published as prose with the examples simply
 * missing from between the paragraphs — a page that reads as if its author had
 * described every example without ever showing one.
 *
 * Unwrapping rather than stripping the offending class tokens, on
 * `unwrapMediaWrappers`' ground rather than on any advantage of its own:
 * removing a layout `<div>` is markdown-neutral, since Turndown calls it a
 * block and surrounds it with blank lines whether or not it is there.
 *
 * An earlier version of this comment claimed a second, decisive reason — that a
 * wrapper left in place is deleted by `_cleanConditionally`'s
 * `contentLength < 25` clause, so short blocks need the unwrap. That is wrong
 * for the pinned Readability: the clause also requires `linkDensity > 0`, and a
 * code block has no links, so it never fires. It was read from the source and
 * written up as measured, which it was not. Stripping only the colliding tokens
 * is a real alternative and keeps every judgement Readability makes; what it
 * does not reach is a wrapper whose collision is not a compound suffix, which
 * is the tabbed sample below. Worth revisiting if these guards keep growing.
 *
 * Runs after `recoverCodeBlocks`, which reads a language from the very
 * containers this removes (`CONTAINER_LANG_PATTERNS`). The other order trades
 * this defect for a fence that has lost its highlighting.
 */
function unwrapCodeWrappers(doc: Document): void {
  for (const pre of Array.from(doc.querySelectorAll("pre"))) {
    // Widen out from the code block one container at a time, stopping at the
    // first that carries something besides it — the same shape as the language
    // walk in `recoverCodeBlocks`, and for the same reason: the depth varies by
    // site. The three shapes on the article that prompted this nest two, three
    // and five deep, so a fixed walk recovers 8 of its 15 blocks.
    const wrappers: Element[] = [];
    let candidate = pre.parentElement;
    while (
      candidate !== null &&
      candidate.nodeName === "DIV" &&
      isCodeLayoutWrapper(candidate) &&
      holdsOnlyCode(candidate)
    ) {
      wrappers.push(candidate);
      candidate = candidate.parentElement;
    }
    // Collected before anything moves: unwrapping re-parents the node the walk
    // is standing on, so widening and rewriting cannot be the same loop.
    for (const wrapper of wrappers) {
      const parent = wrapper.parentNode;
      if (parent === null) continue;
      while (wrapper.firstChild !== null) {
        parent.insertBefore(wrapper.firstChild, wrapper);
      }
      parent.removeChild(wrapper);
    }
  }
}

/**
 * Roles Readability deletes outright, from `UNLIKELY_ROLES` (`Readability.js`).
 *
 * Unlike its class regexes this one is not a heuristic to be second-guessed: a
 * `<div role="dialog">` is a dialog, and a code sample inside one is not the
 * article's.
 */
const UNLIKELY_ROLES: ReadonlySet<string> = new Set([
  "menu",
  "menubar",
  "complementary",
  "navigation",
  "alert",
  "alertdialog",
  "dialog",
]);

/**
 * Attributes a code wrapper may carry and still be nothing but layout.
 *
 * Wider than `LAYOUT_ATTRS` by `id`, `role` and `tabindex`, and that widening
 * is the one place this pass deliberately parts company with
 * `carriesMoreThanLayout`. A scrollable code panel is a focusable widget, so
 * the markup that carries code on a docs site really does carry those three:
 * the tabbed sample on the article that prompted this sits in
 * `<div id="…" role="tabpanel" tabindex="-1" class="…outline-hidden…">`, and
 * refusing it leaves that block deleted by the very class this pass exists to
 * neutralise. Each is admitted only with its own reading below — `role` against
 * `UNLIKELY_ROLES`, `id` against the same regexes as the class — rather than
 * waved through.
 *
 * Everything else is still refused, `rel`, `itemprop`, `aria-*`, `hidden` and
 * anything not yet invented together, because unwrapping discards attributes
 * and Readability reaches several verdicts from them before it scores anything.
 */
const CODE_WRAPPER_ATTRS: ReadonlySet<string> = new Set([
  "class",
  "style",
  "id",
  "role",
  "tabindex",
]);

/**
 * The only two ARIA attributes Readability reads (`Readability.js:1074`,
 * `:2701`), so the only two that can mean something to discard.
 *
 * `aria-modal` matters solely alongside `role="dialog"`, which `UNLIKELY_ROLES`
 * already refuses; it is listed anyway so the set is the source's set rather
 * than a subset that happens to be sufficient today.
 */
const READABILITY_ARIA: ReadonlySet<string> = new Set([
  "aria-hidden",
  "aria-modal",
]);

/**
 * Readability's `negative` regex with `hidden` and `scroll` removed — the two
 * tokens Tailwind's compound utilities collide with, and *only* those two.
 *
 * The sibling of `NEGATIVE_EXCEPT_MEDIA`, written the same way for the same
 * reason: every other token here names furniture a reader did not ask for.
 * Declining the regex wholesale was tried and was wrong — `promo`, `widget`,
 * `contact`, `shopping`, `tags`, `meta`, `outbrain` and `share` each handed
 * back a code block Readability had been deleting, those being exactly the
 * tokens that carry negative weight *without* also being unlikely candidates,
 * so nothing else in the guard caught them.
 *
 * The two exceptions each have their own reason.
 *
 * `hidden` goes because it is *both* the collision and the one token here that
 * is not a furniture signal at all — it is a visibility signal, and
 * `HIDDEN_WORDS` reads it on Readability's own substring terms, with the layout
 * collisions named individually in `LAYOUT_NOT_HIDDEN` and variant conditions
 * evaluated where they can be. Nothing Readability excluded is given up.
 *
 * `scroll` goes because it carries no furniture meaning for the only elements
 * this pass can reach. A wrapper holding exactly one `<pre>` and nothing else
 * is a code block's scroll box, which is what the class is describing.
 */
const NEGATIVE_EXCEPT_LAYOUT =
  /-ad-|banner|combx|comment|com-|contact|footer|gdpr|masthead|meta|outbrain|promo|related|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i;

/**
 * Utility classes that contain a visibility word without hiding the element —
 * the collisions this pass exists to correct, named one at a time.
 *
 * An allow-list, and the direction matters. Missing an entry here costs a code
 * block, which then converts exactly as it does today; missing a *hiding* form
 * publishes markup the reader was never shown. That asymmetry is the same one
 * `readabilityHides` is written on, so the list stays short and explicit rather
 * than clever. `not-sr-only` and `backface-hidden` are on it because they
 * contain a hiding word while doing the opposite, or nothing.
 */
const LAYOUT_NOT_HIDDEN: ReadonlySet<string> = new Set([
  "overflow-hidden",
  "overflow-x-hidden",
  "overflow-y-hidden",
  "outline-hidden",
  "backface-hidden",
  "not-sr-only",
]);

/**
 * Words that mean "not rendered", matched as substrings the way Readability's
 * own regex does.
 *
 * A substring test, deliberately, and this is the second correction to it. The
 * first draft dropped the negative regex wholesale and published furniture. The
 * second matched whole tokens only, which fixed `overflow-hidden` but let
 * `u-hidden`, `js-hidden`, `hidden-sm` and `always-hidden` through — every
 * framework's own spelling of `display: none`, each one excluded by Readability
 * before this pass ran. Worse, the comment here argued they were fine as
 * "conditionally hidden, the same category as `md:hidden`" *after* `md:hidden`
 * had already been moved to the refusing side, so the category had been settled
 * the other way and half of it was left behind.
 *
 * Matching the way Readability does and naming the exceptions is what keeps the
 * two halves consistent: a class hides its element unless this file can say
 * exactly why it does not.
 *
 * Readability catches `class="hidden"` here alone — `_isProbablyVisible` reads
 * the inline style attribute, and there is no stylesheet in scope to ask — so
 * this test is the only thing standing between the unwrap and republishing an
 * inactive tab panel. That is the ADR 0011 failure, one pass earlier.
 */
const HIDDEN_WORDS = /hidden|invisible|sr-only|screen-reader|^d-none$|^hide$/i;

/**
 * True when one class token hides `element` outright.
 *
 * A Tailwind utility can carry variant prefixes — `md:hidden`,
 * `data-[state=inactive]:hidden` — and the question is whether the condition
 * holds *here*. Only one kind can be answered from a detached DOM:
 *
 * - A `data-[…]` variant names an attribute that can simply be looked up, so it
 *   is: a tab panel that is really inactive carries `data-state="inactive"`,
 *   and an exit animation that is not running leaves no `data-ending-style` at
 *   all. Reading it is what keeps a live tabbed code sample.
 * - Every other variant — `md:`, `dark:`, `print:`, `hover:` — names a state
 *   there is no viewport, theme or pointer here to evaluate. **Unanswerable
 *   counts as hidden.** An earlier draft reasoned that such an element is
 *   rendered in the complementary state and published it, which is backwards:
 *   at the reader's own breakpoint `md:hidden` really is `display: none`, and
 *   Readability was excluding it before this pass ran. Refusing costs the block
 *   nothing it was not already losing; admitting publishes markup the page did
 *   not render.
 *
 * A doubly-prefixed token (`md:data-[x]:hidden`) is unanswerable for the same
 * reason and is refused with them.
 */
function hidesElement(token: string, element: Element): boolean {
  const cut = token.lastIndexOf(":");
  const base = token.slice(cut + 1).toLowerCase();
  if (LAYOUT_NOT_HIDDEN.has(base)) return false;
  if (!HIDDEN_WORDS.test(base)) return false;
  if (cut === -1) return true;
  // The attribute name is deliberately narrow. `data-[state~=inactive]` and its
  // kind are CSS attribute *operators*, which this does not model, and letting
  // one through as an unknown name would answer "not hidden" for a condition
  // that was never read.
  const condition = token
    .slice(0, cut)
    .match(/^data-\[([a-z0-9_-]+)(?:=(.*))?\]$/i);
  // Not a condition this can evaluate, so it is not one this may dismiss.
  if (condition === null) return true;
  const actual = element.getAttribute(`data-${condition[1]}`);
  if (actual === null) return false;
  const wanted = condition[2];
  if (wanted === undefined) return true;
  const value = attributeValue(wanted);
  return value === null ? true : actual === value;
}

/**
 * The plain attribute value a `data-[…=…]` variant is asking about, or `null`
 * when the form is one this does not model.
 *
 * Tailwind accepts the value quoted or bare — `data-[state='inactive']` and
 * `data-[state=inactive]` generate the same selector — and a page written the
 * first way was comparing `'inactive'` against the DOM's `inactive`, finding
 * them different, and concluding the panel was *not* hidden. Quotes are the
 * common case in HTML, where the class attribute's own `"` forces the inner
 * ones to be `'` or entities.
 *
 * Anything left holding whitespace or a stray quote is a selector flag or a
 * form nobody has modelled here — `data-[state=inactive i]` asks for a
 * case-insensitive match — and returns `null` so the caller can fall back to
 * treating it as hidden.
 */
function attributeValue(raw: string): string | null {
  const quoted = raw.match(/^(['"])(.*)\1$/);
  const value = quoted?.[2] ?? raw;
  return /^[^\s'"]*$/.test(value) ? value : null;
}

function hiddenByClass(element: Element): boolean {
  return classListOf(element).some((name) => hidesElement(name, element));
}

/**
 * True when the wrapper is layout Readability should not have judged.
 *
 * Note what is *not* consulted: `NEGATIVE_EXCEPT_MEDIA`, the negative-weight
 * regex. That is the divergence from `carriesMoreThanLayout`, and it is the
 * point of this pass rather than an oversight in it. The figure case had one
 * token to except; here the collision arrives through `hidden` *and* `scroll`,
 * and excepting both wholesale would discard `class="hidden"` — how Tailwind
 * spells `display: none`, and the token `NEGATIVE_EXCEPT_MEDIA` names as the
 * costliest to lose.
 *
 * What licenses dropping it is that Readability does not treat a `<pre>` as
 * doubtful in the first place: `pre` is in `DEFAULT_TAGS_TO_SCORE` and
 * `_initializeNode` gives it **+3**. The negative regex is a *scoring* signal,
 * which `_cleanConditionally` promotes to an outright deletion only because its
 * `contentScore` is hardcoded to 0 — and that promotion is the accident. So the
 * genuine rejection passes are all still applied below, and only the score is
 * declined, for a subtree Readability itself scores positively.
 *
 * One thing that regex carried is not a score, though, and is re-established
 * separately: `class="hidden"` is the only way Readability sees a page hiding
 * something with a stylesheet. See `HIDDEN_WORDS`.
 */
function isCodeLayoutWrapper(div: Element): boolean {
  for (const attribute of Array.from(div.attributes)) {
    const name = attribute.name;
    if (CODE_WRAPPER_ATTRS.has(name) || name.startsWith("data-")) continue;
    // ARIA is a labelling vocabulary, and Readability reads exactly two of it
    // — enumerated rather than assumed, the way `UNLIKELY_ROLES` is. Refusing
    // the rest cost a real code sample and was invisible to every offline
    // test: the served HTML has no `aria-*` on that tab panel, and React adds
    // `aria-labelledby` on hydration, so only a clip from a live browser could
    // show it. The panel was then left standing and deleted for its own
    // `outline-hidden`.
    if (name.startsWith("aria-") && !READABILITY_ARIA.has(name)) continue;
    return false;
  }
  // `style` is admitted above, so the inline `display: none` it can carry has
  // to be read here; `hidden` and `aria-hidden` are already refused as
  // attributes, which is why this cannot be dropped as redundant.
  // `hiddenByClass` is the half of the negative-weight regex that is not a
  // score, re-established on its own terms; see its comment.
  if (readabilityHides(div) || hiddenByClass(div)) return false;
  const role = (div.getAttribute("role") ?? "").trim().toLowerCase();
  if (role !== "" && UNLIKELY_ROLES.has(role)) return false;
  // Readability matches an element's class and id together, so this does too.
  const names = `${div.className} ${div.id}`;
  if (NEGATIVE_EXCEPT_LAYOUT.test(names)) return false;
  if (UNLIKELY_CANDIDATES.test(names) && !MAYBE_A_CANDIDATE.test(names)) {
    return false;
  }
  return !BYLINE.test(names);
}

/**
 * True when `div` holds one code block and nothing but chrome around it.
 *
 * An allow-list of element names, for the reason `MEDIA_ONLY` is one: an
 * element nobody has considered stops the walk, which leaves the wrapper
 * exactly as it converts today. A reject-list would have to name everything
 * that means something.
 *
 * `<button>` is on it because these wrappers carry a copy-to-clipboard control
 * and Readability deletes every `<button>` from the article anyway
 * (`_clean(articleContent, "button")`), so keeping one is not a way to preserve
 * anything. Bare text is not: a wrapper carrying a sentence is carrying
 * content, and the class Readability objected to may well be about that
 * sentence.
 *
 * `<div>` and `<span>` are admitted only as *containers*, never waved through:
 * the recursion asks the same question of what they hold, so an empty
 * `<span role="status" class="sr-only">` — the live region a copy button
 * announces into, and the element that first stopped this pass — passes, while
 * `<span>Note: …</span>` is refused on the bare-text rule like any other prose.
 *
 * Structural rather than a text test, on `holdsOnlyMedia`'s reasoning — an
 * `<hr>` or an `<svg>` beside the code carries no text and is still content.
 * The single-`<pre>` requirement is what keeps this off arbitrary layout, and
 * it also declines a wrapper holding two code blocks: a side-by-side comparison
 * is a shape, and this pass has no reading of it.
 */
const CODE_CHROME_WRAPPERS: ReadonlySet<string> = new Set(["DIV", "SPAN"]);

function holdsOnlyCode(div: Element, seen: Set<Element> = new Set()): boolean {
  if (div.getElementsByTagName("pre").length !== 1) return false;
  return isCodeChrome(div, seen);
}

function isCodeChrome(element: Element, seen: Set<Element>): boolean {
  // Defensive against a malformed tree; a cycle would otherwise not terminate.
  if (seen.has(element)) return false;
  seen.add(element);
  for (const node of meaningfulChildren(element)) {
    // "#text" is a sentence beside the code; "#comment" is already filtered.
    if (node.nodeName.startsWith("#")) return false;
    const child = node as Element;
    if (child.nodeName === "PRE" || child.nodeName === "BUTTON") continue;
    if (CODE_CHROME_WRAPPERS.has(child.nodeName) && isCodeChrome(child, seen)) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Drop the one LaTeXML class name that makes Readability delete a data table.
 *
 * `_removeUnlikelyCandidates` tests an element's class and id against a
 * boilerplate regex before any scoring happens, and that regex contains
 * `header`. LaTeXML marks a table whose header row it inferred with
 * `ltx_guessed_headers` — which contains that substring — so the whole table
 * is deleted as site furniture. On one clipped paper three data tables went
 * this way while their `<figcaption>`s survived, leaving captions promising
 * tables that are not there and nine cross-references pointing at nothing.
 *
 * Scoped to this single class, because it is the only collision in the corpus
 * that is wrong. `ltx_pagination` also matches, and there the regex is right:
 * those are page-break markers and Readability should drop them.
 *
 * The class carries no meaning downstream — Readability strips classes from
 * its output anyway — so removing it costs nothing and is not a rewrite of
 * the table's structure, unlike the passes below.
 */
function unhideGuessedHeaderTables(doc: Document): void {
  for (const node of Array.from(doc.querySelectorAll(".ltx_guessed_headers"))) {
    node.classList.remove("ltx_guessed_headers");
  }
}

/**
 * Give a headerless table a header row taken from its own first row.
 *
 * GFM has no way to write a table without one, so the Turndown plugin
 * synthesizes an empty one — `|     |     |` above the divider — whenever the
 * first row is all `<td>`. The result is a blank leading row *and* a first row
 * of real headings still rendered as data. arXiv never uses `<thead>`, so all
 * 51 tables in one paper and 7 in another arrived this way.
 *
 * Promoting the row is the better of the two available lies: the cells a page
 * lays out first are the ones it means as headings, which is what a browser
 * shows for the same markup. Tables that already declare a header, in `<thead>`
 * or with `<th>` in the first row, are left alone.
 */
function promoteTableHeaders(doc: Document): void {
  for (const table of Array.from(doc.querySelectorAll("table"))) {
    if (table.querySelector("thead") !== null) continue;
    const row = table.querySelector("tr");
    if (row === null || row.querySelector("th") !== null) continue;
    const cells = Array.from(row.children).filter(
      (cell) => cell.tagName === "TD",
    );
    if (cells.length === 0 || cells.length !== row.children.length) continue;
    for (const cell of cells) {
      const heading = doc.createElement("th");
      for (const attribute of Array.from(cell.attributes)) {
        heading.setAttribute(attribute.name, attribute.value);
      }
      while (cell.firstChild !== null) heading.appendChild(cell.firstChild);
      cell.replaceWith(heading);
    }
    const head = doc.createElement("thead");
    // Take the row's position, not the table's: a caption or colgroup may come
    // first, and <thead> has to follow them to stay in a valid table.
    row.replaceWith(head);
    head.appendChild(row);
  }
}

/**
 * Rewrite a *cloned* document in place. Never call this on the live page —
 * it removes and replaces nodes the user is looking at.
 *
 * Deliberately reports nothing about how much math it found. Whether the
 * article *has* math is a question about the HTML that survives Readability,
 * not about the page this saw, and answering it from here would let a formula
 * in a discarded sidebar set the flag (see markdown.ts).
 */
export function prepareForClipping(doc: Document): void {
  normalizeLinkTitles(doc);
  unwrapEquationTables(doc);
  normalizeMath(doc);
  recoverCodeBlocks(doc);
  // After recoverCodeBlocks, which reads a language from the very containers
  // this removes; the other order trades a dropped block for a bare fence.
  unwrapCodeWrappers(doc);
  stripRedundantListMarkers(doc);
  unwrapPictures(doc);
  // After normalizeMath, so a MathJax formula has already become its TeX
  // marker rather than an <svg> this could delete.
  dropChartSvgs(doc);
  unhideGuessedHeaderTables(doc);
  unwrapMediaWrappers(doc);
  // Last: `unwrapEquationTables` and `recoverCodeBlocks` delete whole tables
  // (LaTeXML equations, Chroma line-number gutters). Promoting headers first
  // would rewrite the very cells they select on — `td.lntd` becomes a `<th>`
  // and the code block stays a table.
  promoteTableHeaders(doc);
}

/**
 * Contexts where a top-level block cannot live. Display math written as its
 * own `$$` block would either be mangled (a table cell turns the newlines
 * into `<br>`, which KaTeX then typesets literally) or escape the protection
 * that makes math safe: nested inside a list or blockquote the enclosing
 * block is a `list`, not a `math`, so it is not verbatim and the formula goes
 * to the translator. Inline math is protected wherever it appears, so nested
 * display math degrades to inline rather than to either of those.
 */
const BLOCK_HOSTILE = "td, th, li, blockquote, h1, h2, h3, h4, h5, h6";

/**
 * The other half of the marker contract: how a recovered formula becomes
 * markdown. It has to be a Turndown *rule* rather than plain text, because
 * Turndown escapes `\` and `_` in text nodes and would turn `\sqrt{d_k}`
 * into `\\sqrt{d\_k}`. Rule output is emitted as written.
 */
export const mathTurndownRule: TurndownService.Rule = {
  filter: (node) => node.getAttribute?.(MATH_ATTR) != null,
  replacement: (_content, node) => {
    const tex = (node.textContent ?? "").trim();
    if (tex === "") return "";
    const element = node as Element;
    const display =
      element.getAttribute(MATH_ATTR) === "display" &&
      element.closest?.(BLOCK_HOSTILE) == null;
    // The blank lines make display math its own top-level block; without them
    // it would be inline math inside the surrounding paragraph.
    return display ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
  },
};
