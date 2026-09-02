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
 * True when `link` holds `image` through a chain of single-child wrappers and
 * nothing else — no sibling, at any depth, textual or not.
 *
 * Structural rather than a text test, because the content that has to be
 * protected here is not all textual: an `<hr>` or an `<svg>` beside the image
 * carries no text but is still content, and dropping it would be exactly the
 * silent loss this pass has to avoid.
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
 * Every bail-out below leaves the figure converting exactly as it does today.
 * That is the cheap direction: a figure that keeps reading as loose prose is
 * the defect this fixes, while a fold that guesses wrong drops content off the
 * page or breaks the one-block promise the site and `zh.md` both rely on.
 */
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
  stripRedundantListMarkers(doc);
  unwrapPictures(doc);
  // After unwrapPictures, so a <picture> inside a figure is already the
  // <img> this needs to find.
  foldFigureCaptions(doc);
  unhideGuessedHeaderTables(doc);
  // Last: the two passes above delete whole tables (LaTeXML equations, Chroma
  // line-number gutters). Promoting headers first would rewrite the very cells
  // they select on — `td.lntd` becomes a `<th>` and the code block stays a table.
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
