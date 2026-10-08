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

import {
  languageFromFilename,
  languageFromLabel,
  normalizeUrl,
} from "@tiro/shared";
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
    // The id travels with the content: a paper's equation references
    // (`#S4.E1`) point at the table, and dropping it here would leave them
    // pointing at nothing once the table is gone (ADR 0024).
    if (table.id !== "") holder.id = table.id;
    table.replaceWith(holder);
  }
}

function normalizeMath(doc: Document): void {
  // Same reasoning as `markCodeLanguages`: the marker is a private contract
  // between this file and a Turndown rule, and a page that writes one itself is
  // untrusted input the rule has no way to tell apart. `<span
  // data-tiro-math="display">` splits the paragraph it sits in into three
  // blocks and sets `has_math`, which turns every price on the page into a
  // formula — the failure `escapeLiteralDollars` exists to prevent.
  for (const stale of Array.from(doc.querySelectorAll(`[${MATH_ATTR}]`))) {
    stale.removeAttribute(MATH_ATTR);
  }
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

/**
 * How far above a `<pre>` its own chrome can sit. Three levels covers a header
 * bar nested inside a rounded wrapper inside a scroll container, and stops
 * short of the article.
 */
const CHROME_MAX_DEPTH = 3;

/** Attributes a code block's chrome writes its filename into. */
const TITLE_ATTRS = [
  "data-rehype-pretty-code-title",
  "data-code-title",
  "data-title",
];

/** Elements that hold a code block's filename as text. */
const TITLE_SELECTOR = [
  "[data-rehype-pretty-code-title]",
  "[data-code-title]",
  "[data-title]",
  "[class*='codeBlockTitle']",
  "[class*='code-block-title']",
  "[class*='code-title']",
  "[class*='filename']",
  "figcaption",
].join(",");

function resolveLabel(text: string): string | null {
  return languageFromLabel(text) ?? languageFromFilename(text);
}

function textOf(element: Element): string {
  return (element.textContent ?? "").trim();
}

/**
 * The outermost ancestor holding this `<pre>` and nothing but its own chrome.
 *
 * `holdsOnlyCode` is the same structural test the figure fold uses: one `<pre>`
 * and no prose beside it. That is the right guard for a tab strip found by
 * proximity, because a tab strip near a code block is as likely to be the
 * page's own — Cloudflare puts a *human*-language switcher in exactly that
 * markup — and nothing about the widget itself says which.
 */
function chromeContainer(pre: Element): Element | null {
  let container: Element | null = null;
  let node = pre.parentElement;
  for (let depth = 0; depth < CHROME_MAX_DEPTH && node !== null; depth += 1) {
    if (!holdsOnlyCode(node)) break;
    container = node;
    node = node.parentElement;
  }
  return container;
}

/** The element holding both the tab strip and this block's panel. */
function tabGroup(panel: Element): Element | null {
  let node = panel.parentElement;
  for (let depth = 0; depth < CHROME_MAX_DEPTH && node !== null; depth += 1) {
    if (node.querySelector('[role="tab"]') !== null) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * The tab that names this block, in a multi-language tab group.
 *
 * Which tab is *this* block's is the whole difficulty. A page that renders one
 * panel at a time has a single selected tab and no ambiguity; a page that
 * renders every panel has one `<pre>` per language, and taking the selected tab
 * would label all of them `Python`. So a panel is matched to its own tab —
 * through `aria-labelledby`, or by position when the counts agree — and the
 * selected-tab reading is kept for the case where there is nothing to confuse
 * it with.
 */
function tabLabelFor(pre: Element): string | null {
  const panel = pre.closest('[role="tabpanel"]');
  const group = panel === null ? chromeContainer(pre) : tabGroup(panel);
  if (group === null) return null;
  const tabs = Array.from(group.querySelectorAll('[role="tab"]'));
  if (tabs.length === 0) return null;
  if (panel !== null) {
    const labelledBy = panel.getAttribute("aria-labelledby");
    if (labelledBy !== null && labelledBy !== "") {
      const tab = tabs.find((one) => one.getAttribute("id") === labelledBy);
      return tab === undefined ? null : textOf(tab);
    }
    const panels = Array.from(group.querySelectorAll('[role="tabpanel"]'));
    if (panels.length === tabs.length) {
      const tab = tabs[panels.indexOf(panel)];
      return tab === undefined ? null : textOf(tab);
    }
    // Panels rendered, but not one per tab and not identified: no reading of
    // this shape is safe.
    if (panels.length > 1) return null;
  }
  const selected =
    tabs.find((one) => one.getAttribute("aria-selected") === "true") ??
    tabs.find((one) => one.hasAttribute("data-active")) ??
    (tabs.length === 1 ? tabs[0] : undefined);
  return selected === undefined ? null : textOf(selected);
}

/**
 * A filename written into the block's chrome, as an attribute or as text.
 *
 * Found by walking up and looking only at each level's **previous element
 * sibling**, because that is where a code block's title sits — immediately
 * before the code, at whatever nesting the page uses. An earlier version
 * searched the whole nearest ancestor holding one `<pre>`, which sounds
 * equivalent and is not: a section containing a figure captioned `example.py`
 * and, further down, an unrelated SQL block gave that block ```` ```python ````,
 * written into the vault where nothing revisits it. Sharing an ancestor is not
 * an association; adjacency is.
 */
function titleLabelFor(pre: Element): string | null {
  // The `<pre>` itself gets the attributes only. Its text is the code, and a
  // one-line block reading `python` would otherwise name itself.
  for (const attr of TITLE_ATTRS) {
    const value = pre.getAttribute(attr);
    if (value !== null && value.trim() !== "") return value;
  }
  let node: Element | null = pre;
  for (let depth = 0; depth < CHROME_MAX_DEPTH && node !== null; depth += 1) {
    const previous = node.previousElementSibling;
    // The sibling must *be* the title. Searching inside it would readmit the
    // unrelated `<figure>` above, whose caption names a different file.
    if (previous?.matches(TITLE_SELECTOR) === true) {
      for (const attr of TITLE_ATTRS) {
        const value = previous.getAttribute(attr);
        if (value !== null && value.trim() !== "") return value;
      }
      const text = textOf(previous);
      if (text !== "") return text;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * The language a page states in a code block's chrome rather than its markup.
 *
 * The last resort in `recoverCodeBlocks`' chain, and the only one that reads
 * text meant for a human. Pages that pre-highlight with Shiki emit
 * `<pre class="shiki shiki-themes …">` and no language at all, so on a growing
 * share of docs sites and engineering blogs the tab reading `Python` is the
 * only place the language survives.
 *
 * Everything found here goes through `@tiro/shared`'s allowlists, which is what
 * keeps `Copy` and `Output` — words that sit in exactly these positions — out
 * of the vault as fence languages.
 */
function languageFromChrome(pre: Element): string | null {
  const tab = tabLabelFor(pre);
  const fromTab = tab === null ? null : resolveLabel(tab);
  if (fromTab !== null) return fromTab;
  const title = titleLabelFor(pre);
  return title === null ? null : resolveLabel(title);
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
      ) ??
      // Last: text the page wrote for a human, not markup. See above.
      languageFromChrome(pre);
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
 * The alt text LaTeXML writes on every figure image, which describes nothing:
 * "Refer to caption" on a captioned one, "[Uncaptioned image]" on the rest.
 */
const LATEXML_PLACEHOLDER_ALTS: ReadonlySet<string> = new Set([
  "Refer to caption",
  "[Uncaptioned image]",
]);

/**
 * Clear the alt text LaTeXML fills in when a paper gives none.
 *
 * Every image on an arXiv paper read "Refer to caption" — all 19 of KAN's —
 * which is a screen reader's whole account of the figure and the text that
 * stands in when the image fails to load. It says less
 * than an empty alt: the caption it points at is folded beside the image anyway
 * (ADR 0011), and "[Uncaptioned image]" points at nothing at all, landing in
 * the markdown as `![\[Uncaptioned image\]](…)`.
 *
 * Emptied rather than replaced with the caption, which would repeat the line
 * printed directly under it. Only on LaTeXML's own `ltx_graphics` and only on
 * an exact match, so an author who wrote either phrase keeps it.
 */
function clearLatexmlPlaceholderAlts(doc: Document): void {
  for (const image of Array.from(doc.querySelectorAll("img.ltx_graphics"))) {
    const alt = image.getAttribute("alt");
    if (alt !== null && LATEXML_PLACEHOLDER_ALTS.has(alt.trim())) {
      image.setAttribute("alt", "");
    }
  }
}

/** Punctuation that closes onto the word before it, never after a space. */
const CLOSING_PUNCTUATION = /^[,.;:!?)\]]/;

/**
 * Remove a Distill citation that holds nothing, with the space before it.
 *
 * Distill writes `Inception Labs <d-cite key="…"></d-cite>,` and fills the
 * element in from script, inside a shadow root no clone serializes, so a clip
 * sees it empty either way. Turndown writes an empty element as nothing and
 * keeps the space the author put before it, and a heavily cited post read
 * `(Inception Labs , Gemini Diffusion )` all the way down.
 *
 * The citation itself cannot be recovered from the element, so it goes; what
 * this repairs is only the gap it leaves. The space before goes only when
 * punctuation follows, since a citation the author used as a word —
 * `Then <d-cite></d-cite> continues` — still needs one space between the words
 * either side. Adjacent text is merged after each removal, so a run of
 * citations closes up as one.
 */
function dropEmptyCitations(doc: Document): void {
  for (const cite of Array.from(doc.querySelectorAll("d-cite"))) {
    if ((cite.textContent ?? "").trim() !== "") continue;
    const parent = cite.parentNode;
    const before = cite.previousSibling;
    const after = cite.nextSibling;
    cite.remove();
    if (
      before?.nodeType === 3 &&
      after?.nodeType === 3 &&
      CLOSING_PUNCTUATION.test(after.textContent ?? "")
    ) {
      before.textContent = (before.textContent ?? "").trimEnd();
    }
    parent?.normalize();
  }
}

/**
 * Re-tag every `<font>` as a `<span>`, before Readability reads the page.
 *
 * Not about the tag's own output — Turndown discards `color`, `size` and `face`
 * anyway — but about where Readability puts its paragraph breaks. A page that
 * separates paragraphs with `<br><br>`, as paulgraham.com does, has them built
 * by `_replaceBrs`, which moves siblings into the paragraph it creates only
 * while they are *phrasing content* and stops at the first that is not. Its
 * `PHRASING_ELEMS` list has no `FONT` in it, and an `<a>` counts as phrasing
 * only when every child does. So a footnote marker written
 *
 *     [<a name="f1n"><font color=#000000>1</font></a>] You can also make…
 *
 * ends the paragraph half-way through itself: `[` stays behind and the anchor
 * starts a new one. Every note on that essay arrived as a stray `\[` paragraph
 * followed by `1\] You can also…`, and its closing Thanks block fused to the
 * last note.
 *
 * The notes are only where it shows. This takes that essay from 58 top-level
 * blocks to 43 and another from 54 to 44 — ten paragraphs that ended
 * mid-sentence with no visible symptom, and that the translator was handed in
 * halves.
 *
 * **One element in place of one element, rather than unwrapping.** Dropping the
 * `<font>` and keeping its children fixes the same symptom and was tried first;
 * a corpus sweep caught what it cost. Readability scores candidates by what
 * their subtree contains, so removing 22 elements from a page changes which
 * container it picks — on one PBS NOVA page it then chose a larger one that
 * begins with the site's navigation, and the article lost nine of its eleven
 * images. Re-tagging leaves the tree exactly as it was; `<span>` is on the
 * phrasing list, which is the whole of what needed to change. The attributes
 * are not carried over: nothing downstream reads them, and neither element
 * takes a class or id, so `_getClassWeight` sees the same page either way.
 *
 * `<big>`, `<tt>` and `<nobr>` share the flaw and are left out until a page
 * needs them. `<s>`, `<strike>` and `<u>` must be left alone whatever happens:
 * Turndown's GFM plugin renders the first two as `~~…~~`, so re-tagging them
 * would drop a strikethrough silently — this bug traded for a worse one.
 */
function retagFontsAsSpans(doc: Document): void {
  for (const font of Array.from(doc.querySelectorAll("font"))) {
    const span = doc.createElement("span");
    // Materialized: `childNodes` is live, and appendChild is moving its
    // entries out from under the iteration.
    for (const child of Array.from(font.childNodes)) span.appendChild(child);
    font.replaceWith(span);
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
 * What a video becomes when nothing better can be said: its link text, and its
 * poster's alt text. The page's own label wins when it gives one.
 */
const VIDEO_LABEL = "Video";

/**
 * Brackets the text the clipper gives an element so that Readability keeps it
 * — `keepVideosThroughReadability`'s for a video — so text that came from it
 * can be told from text an author wrote. A private-use character: no page's
 * metadata carries one by accident, and it is not whitespace, so the paragraph
 * still reads as holding text.
 */
const KEEP_MARK = "\uE000";
const VIDEO_PLACEHOLDER = `${KEEP_MARK}${VIDEO_LABEL}${KEEP_MARK}`;

/**
 * What a figure the page draws with script becomes in the clip: the text of the
 * link back to the page, which is the one place the figure still works.
 */
const FIGURE_LABEL = "Interactive figure";

/**
 * Marks a `<figure>` that `keepScriptFiguresThroughReadability` emptied, so the
 * pass after Readability can find it again. Found by this marker and never by
 * tag: Readability renames a sibling it appends to the article to `<div>`.
 */
const FIGURE_ATTR = "data-tiro-figure";

/** A video address a reader can follow: http(s), resolved against the page.
 * `blob:` is what a streaming player hands its `<video>`, and it means nothing
 * outside the tab that made it; `data:` would put the file in the markdown. */
function followableUrl(value: string | null, base: string): string | null {
  if (value === null || value.trim() === "") return null;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * The file a `<video>` plays: its own `src`, else one of its `<source>`s —
 * MP4 first, since it is the one format every browser opens from a bare link.
 */
function videoSource(video: Element, base: string): string | null {
  const own = followableUrl(video.getAttribute("src"), base);
  if (own !== null) return own;
  const sources = Array.from(video.querySelectorAll("source"))
    .map((source) => ({
      url: followableUrl(source.getAttribute("src"), base),
      mp4: /^video\/mp4\b/i.test(source.getAttribute("type") ?? ""),
    }))
    .filter((source) => source.url !== null);
  return (sources.find((source) => source.mp4) ?? sources[0])?.url ?? null;
}

/**
 * Give every `<video>` text of its own, so Readability keeps the paragraph it
 * sits in.
 *
 * `_prepArticle` deletes a `<p>` that has no text and holds no `img`, `embed`,
 * `object` or `iframe` — and `<video>` is not on that list. The page the audit
 * named wraps its video in exactly such a paragraph, so the video was gone
 * before `videosAsPostersIn` could see it, and a test with the video loose in
 * the article passed regardless. A lone `<div><video></div>` goes the same
 * way, one step later: Readability turns a `<div>` with no block children into
 * a `<p>`, and then deletes that.
 *
 * Text is the one signal that rule reads which can be added without changing
 * any element or attribute. A video whose page left fallback text already
 * survived — that is how "your browser does not support video" reached the
 * vault — so this makes every video the shape that already works. Unwrapping
 * the paragraph instead, as `unwrapMediaWrappers` does for a figure's `<div>`,
 * would discard the very attributes Readability reads to decide what is
 * hidden; here a hidden paragraph, or a hidden video, is still dropped with
 * everything in it. The text never reaches the markdown: `videosAsPostersIn`
 * replaces the whole element, and `excerptWithoutPlaceholders` keeps it out of the
 * one thing Readability reads from the text directly.
 *
 * The page's own fallback is replaced rather than kept beside the placeholder.
 * It is never content — `videosAsPostersIn` discards it — and leaving it would
 * leave text in the body that nothing downstream could tell from the author's,
 * which is exactly how it used to become an article's excerpt. `<source>` and
 * `<track>` stay; they are what the video plays.
 */
function keepVideosThroughReadability(doc: Document): void {
  for (const video of Array.from(doc.querySelectorAll("video"))) {
    for (const child of Array.from(video.childNodes)) {
      if (child.nodeName === "SOURCE" || child.nodeName === "TRACK") continue;
      video.removeChild(child);
    }
    video.appendChild(doc.createTextNode(VIDEO_PLACEHOLDER));
  }
}

/**
 * Readability's excerpt, unless it was read out of a placeholder the clipper
 * added.
 *
 * With no description in the page's metadata, Readability uses the text of the
 * article's first `<p>`. When that paragraph holds a video, its text is the
 * video's: the label `keepVideosThroughReadability` adds, or the page's own
 * "your browser does not support video" — so an article opening on its demo was
 * summarised as `Video`, in the popup, the frontmatter and the site's feed,
 * even when the video itself was then dropped from the body. A script-drawn
 * figure is the same case: an interactive article opens on one, and a `<div>`
 * wrapped round it becomes the `<p>` holding its label.
 *
 * Recognised by `KEEP_MARK`, which only a placeholder carries. Comparing
 * the excerpt with the first paragraph's text was tried first and cannot tell
 * where an excerpt came from: a page whose `<meta name="description">` is
 * "Video" — or whatever its fallback said — matched, and lost its authored
 * description to a later paragraph. Readability takes metadata from the
 * page's `<head>` and JSON-LD, which never hold the mark, so an excerpt that
 * carries it was read out of the body, and anything else passes through.
 *
 * Rebuilt from the first paragraph that still says something once every
 * placeholder is gone — the one Readability would have taken had the video's
 * paragraph been deleted, as it was before videos were kept.
 */
export function excerptWithoutPlaceholders(
  excerpt: string,
  content: string,
  doc: Document,
): string {
  if (!excerpt.includes(KEEP_MARK)) return excerpt;
  const scratch = doc.implementation.createHTMLDocument("");
  scratch.body.innerHTML = content;
  for (const placeholder of Array.from(
    scratch.querySelectorAll(`video, [${FIGURE_ATTR}]`),
  )) {
    placeholder.remove();
  }
  for (const paragraph of Array.from(scratch.querySelectorAll("p"))) {
    const text = (paragraph.textContent ?? "").trim();
    if (text !== "") return text;
  }
  return "";
}

/**
 * Give every `<video>` in already-extracted article HTML a shape markdown can
 * carry: its poster frame, linking to the file it plays.
 *
 * Readability keeps a `<video>`; Turndown has no rule for one and writes out
 * its text, which is either nothing — the demo that was the payoff of a DIY
 * post vanished, poster frame and all — or the fallback a page leaves for
 * browsers without video, so "Your browser does not support the video tag."
 * landed in the article as the author's prose. Markdown has no video, and raw
 * HTML is opaque to everything after the clip (the reason ADR 0011 reverted a
 * raw `<figure>`), so the element is rewritten into what markdown does have:
 * `<a href=video><img src=poster></a>`, which converts to `[![](poster)](video)`.
 *
 * That shape is one every later stage already understands, which is why it was
 * chosen over anything new. The figure fold treats it as a linked image and
 * folds a `<figcaption>` beside it; the processor downloads the poster as it
 * would any image, while the link stays on the publisher's copy of the video —
 * a file too large to belong in the vault; the site renders the pair as a
 * figure that opens the video when clicked.
 *
 * A video with no poster becomes a plain link, and one whose only source is
 * `blob:` keeps its poster unlinked. One with neither has nothing to show a
 * reader and is dropped — its fallback text with it, which is never content.
 *
 * Runs after Readability for the reason `foldFiguresIn` does, and before it,
 * because the fold has to see the image this builds. Readability only gets
 * that far with the video because `keepVideosThroughReadability` gave it
 * text. Resolved against the page's address rather than trusted to be
 * absolute: on the raw-body fallback Readability never resolved anything.
 */
export function videosAsPostersIn(
  html: string,
  doc: Document,
  pageUrl?: string,
): string {
  const scratch = doc.implementation.createHTMLDocument("");
  scratch.body.innerHTML = html;
  // The document's own base where it has one, since that is what the page's
  // relative addresses were written against; the page's URL where it does not,
  // for a document built somewhere that never learned where it came from.
  const base = /^https?:/i.test(doc.baseURI) ? doc.baseURI : (pageUrl ?? "");
  for (const video of Array.from(scratch.querySelectorAll("video"))) {
    const source = videoSource(video, base);
    const poster = followableUrl(video.getAttribute("poster"), base);
    const label =
      (
        video.getAttribute("aria-label") ??
        video.getAttribute("title") ??
        ""
      ).trim() || VIDEO_LABEL;
    let replacement: Element | null = null;
    if (poster !== null) {
      const image = scratch.createElement("img");
      image.setAttribute("src", poster);
      image.setAttribute("alt", label);
      replacement = image;
    }
    if (source !== null) {
      const link = scratch.createElement("a");
      link.setAttribute("href", source);
      if (replacement === null) link.textContent = label;
      else link.appendChild(replacement);
      replacement = link;
    }
    if (replacement === null) {
      video.remove();
      continue;
    }
    // A link may point at the video. The marker moves to what replaces it and
    // `placeAnchorsIn` decides as it would for any element: a text link gets
    // its anchor, and a poster is refused the way every picture is, since an
    // anchor in front of one would cost the caption fold.
    const anchor = video.getAttribute(ANCHOR_ATTR);
    if (anchor !== null) replacement.setAttribute(ANCHOR_ATTR, anchor);
    video.replaceWith(replacement);
  }
  return scratch.body.innerHTML;
}

/**
 * Readability's `_fixLazyImages` tests, copied from `Readability.js` (0.6.0,
 * ~2389). An attribute whose value looks like an image address becomes an
 * image — and on a `<figure>` with no image inside, a new `<img>` appended to
 * it. A figure, or anything in it, carrying one is an image the page has yet to
 * load, not a figure it draws.
 */
const LAZY_SRCSET = /\.(jpg|jpeg|png|webp)\s+\d/;
const LAZY_SRC = /^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/;

/**
 * What a drawn figure's slot holds before its script runs — the empty
 * containers it fills, and the scripts and styles that fill them — and the
 * canvas it draws into once it has.
 *
 * An allow-list, the direction every pass in this file takes: the open web puts
 * quotes, code, noscript images and charts in `<figure>`, and an element nobody
 * has considered leaves the figure converting exactly as it does today.
 */
const FIGURE_SLOT: ReadonlySet<string> = new Set([
  "DIV",
  "SPAN",
  "CANVAS",
  "SCRIPT",
  "STYLE",
]);

/**
 * What a drawn figure lays over and under its canvas: labels, narration, and
 * the controls that step it. Allowed only beside a canvas, which is what shows
 * them to be chrome — a button does nothing in markdown, and a label points at
 * a picture the clip does not have.
 */
const FIGURE_CHROME: ReadonlySet<string> = new Set([
  "BUTTON",
  "INPUT",
  "LABEL",
  "SELECT",
  "OPTION",
  "OPTGROUP",
  "OUTPUT",
  "METER",
  "PROGRESS",
  "BR",
  "B",
  "STRONG",
  "I",
  "EM",
  "SMALL",
  "KBD",
  "SUB",
  "SUP",
]);

/** The page's own description of a figure: `aria-label`, else `title` — the
 * order `videosAsPostersIn` reads a video's. */
function figureLabel(figure: Element): string {
  return (
    figure.getAttribute("aria-label") ??
    figure.getAttribute("title") ??
    ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** A figure's caption: a `<figcaption>` that is its direct child. */
function directCaption(figure: Element): Element | null {
  for (const child of Array.from(figure.children)) {
    if (child.tagName.toUpperCase() === "FIGCAPTION") return child;
  }
  return null;
}

function looksLikeLazyImage(element: Element): boolean {
  for (const attr of Array.from(element.attributes)) {
    if (LAZY_SRCSET.test(attr.value) || LAZY_SRC.test(attr.value)) return true;
    // A picture painted as a background is an image too, and one this would
    // otherwise replace with a description of nothing.
    if (attr.name === "style" && /url\(/i.test(attr.value)) return true;
  }
  return false;
}

/** Text outside the caption, scripts and styles — what the figure says in
 * markup rather than in pixels. */
function slotText(node: Node, caption: Element | null): string {
  let text = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === child.TEXT_NODE) {
      text += child.textContent ?? "";
      continue;
    }
    if (child.nodeType !== child.ELEMENT_NODE || child === caption) continue;
    const tag = (child as Element).tagName.toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE") continue;
    text += slotText(child, caption);
  }
  return text;
}

/**
 * True when `figure` is one the page draws with script: a `<figure>` holding
 * nothing but empty containers, or a `<canvas>` and the chrome around it, and
 * at most a caption.
 *
 * Such a figure is lost whole today. Before its script runs it is an empty
 * `<div>`, which Readability turns into a `<p>` and deletes; after, it is a
 * canvas Turndown has no rule for, beside overlay labels and narration that
 * reach the article as stray paragraphs. Only its caption survives, as prose
 * describing a picture that is not there.
 *
 * Deliberately narrow, because the cost of a wrong answer is a real figure
 * replaced by a link: a lone `<figure><figcaption>` pull-quote has no slot, a
 * chart drawn as `<svg>` has an element this does not allow, and a figure with
 * text of its own outside the caption is saying something. Bare canvases with
 * no `<figure>` around them, `[role=figure]`, and a caption reached through
 * `aria-labelledby` are left for when a page needs them.
 */
function isScriptDrawnFigure(figure: Element): boolean {
  if (insideLink(figure)) return false;
  if (looksLikeLazyImage(figure)) return false;
  const caption = directCaption(figure);
  // A second caption, or one nested deeper, is a figure this cannot describe
  // as one block.
  if (
    figure.querySelectorAll("figcaption").length !== (caption === null ? 0 : 1)
  ) {
    return false;
  }
  const slot = Array.from(figure.querySelectorAll("*")).filter(
    (element) => caption === null || !caption.contains(element),
  );
  if (slot.length === 0) return false;
  const drawn = slot.some(
    (element) => element.tagName.toUpperCase() === "CANVAS",
  );
  for (const element of slot) {
    if (looksLikeLazyImage(element)) return false;
    if (
      element.hasAttribute(MATH_ATTR) ||
      element.hasAttribute(CODE_LANG_ATTR)
    ) {
      return false;
    }
    // A leader line drawn over the canvas. An `<svg>` with no canvas beside it
    // is a chart or a diagram of its own, which is not this pass's to replace.
    const svg = element.closest("svg");
    if (svg !== null && figure.contains(svg)) {
      if (drawn) continue;
      return false;
    }
    const tag = element.tagName.toUpperCase();
    // A script that loads from elsewhere is a third-party embed filling its
    // own slot — a podcast player, a gist, a tweet — not a figure the page
    // draws. The corpus has one: Buzzsprout's player, an empty <div> beside a
    // <script src> and a caption telling the reader where to click.
    if (tag === "SCRIPT" && element.hasAttribute("src")) return false;
    if (FIGURE_SLOT.has(tag)) continue;
    if (drawn && FIGURE_CHROME.has(tag)) continue;
    return false;
  }
  // Text beside a canvas is its labels and narration. Text with no canvas is
  // the figure saying something in markup, and that is content.
  if (!drawn && slotText(figure, caption).trim() !== "") return false;
  // A figure that shows nothing is not one to describe. Readability drops what
  // it hides, but only once this pass has emptied the slot it would have read.
  const shown = Array.from(figure.children).filter(
    (child) => child !== caption,
  );
  if (shown.every((child) => readabilityHides(child))) return false;
  const captioned = (caption?.textContent ?? "").trim() !== "";
  return figureLabel(figure) !== "" || captioned || drawn;
}

/**
 * Give every figure a page draws with script text of its own, so Readability
 * keeps it until `scriptFiguresIn` can say what it was.
 *
 * Its slot — the empty shell, or the canvas and its overlays — is replaced by a
 * `<span>` holding the figure's label between `KEEP_MARK`s. A `<span>` rather
 * than the bare text `keepVideosThroughReadability` uses, because a figure
 * Readability renames to `<div>` then faces `_cleanConditionally`, which counts
 * only text inside SPAN, P, DIV and their kind: bare text measures zero, and a
 * figure with no image and no text density is deleted.
 *
 * Only children change. The figure keeps every attribute, so Readability's
 * hidden, furniture and byline verdicts on it still stand — the hazard ADR 0011
 * recorded for any pass that runs before extraction.
 */
function keepScriptFiguresThroughReadability(doc: Document): void {
  // Page-authored markers go first, as in every marker pass in this file.
  for (const stale of Array.from(doc.querySelectorAll(`[${FIGURE_ATTR}]`))) {
    stale.removeAttribute(FIGURE_ATTR);
  }
  for (const figure of Array.from(doc.querySelectorAll("figure"))) {
    if (!isScriptDrawnFigure(figure)) continue;
    const caption = directCaption(figure);
    for (const child of Array.from(figure.childNodes)) {
      if (child !== caption) figure.removeChild(child);
    }
    const keep = doc.createElement("span");
    keep.textContent = `${KEEP_MARK}${figureLabel(figure) || FIGURE_LABEL}${KEEP_MARK}`;
    figure.insertBefore(keep, caption);
    figure.setAttribute(FIGURE_ATTR, "");
  }
}

/**
 * Where a figure's link points: the page as the article records it — tracking
 * parameters gone — and the figure itself when it has an id to go to.
 */
function figureHref(pageUrl: string, id: string): string | null {
  let page: string;
  try {
    page = normalizeUrl(pageUrl);
  } catch {
    return null;
  }
  if (!/^https?:/i.test(page)) return null;
  return ANCHOR_ID.test(id) ? `${page}#${id}` : page;
}

/**
 * Turn every figure `keepScriptFiguresThroughReadability` marked into a
 * paragraph markdown can carry: a link back to the page, the page's own
 * description of the figure, and its caption —
 * `[Interactive figure](page): label` then the caption on the next line.
 *
 * Markdown cannot hold the figure, and the site runs no publisher script, so
 * what the reader is owed is that there *was* a figure, what the author said it
 * shows, and the way to it. The paragraph is prose, so it is translated as
 * prose, and it is one block, which is what keeps `zh.md` aligned (ADR 0003).
 *
 * Built here rather than left to `foldFiguresIn`, which needs an image to fold
 * a caption beside and would also miss a figure Readability renamed to a
 * `<div>`. Runs before `placeAnchorsIn`, which places the anchor carried over
 * to the paragraph.
 */
export function scriptFiguresIn(
  html: string,
  doc: Document,
  pageUrl: string,
): string {
  const scratch = doc.implementation.createHTMLDocument("");
  scratch.body.innerHTML = html;
  for (const figure of Array.from(
    scratch.querySelectorAll(`[${FIGURE_ATTR}]`),
  )) {
    const label = figureLabel(figure);
    const caption = directCaption(figure);
    const captionText = (caption?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const source =
      caption !== null && captionText !== "" ? captionSource(caption) : null;
    const paragraph = scratch.createElement("p");
    const href = figureHref(pageUrl, figure.getAttribute("id") ?? "");
    const link = scratch.createElement(href === null ? "span" : "a");
    if (href !== null) link.setAttribute("href", href);
    link.textContent = FIGURE_LABEL;
    paragraph.appendChild(link);
    // A table row is one line of markdown, and a break would end it.
    const separator = (): Node =>
      figure.closest("td, th") === null
        ? scratch.createElement("br")
        : scratch.createTextNode(" ");
    let captionUsed = captionText === "";
    if (label !== "") {
      paragraph.appendChild(scratch.createTextNode(`: ${label}`));
      // A caption that only repeats the label is said once.
      if (captionText === label) captionUsed = true;
      else if (source !== null) {
        paragraph.appendChild(separator());
        while (source.firstChild !== null) {
          paragraph.appendChild(source.firstChild);
        }
        captionUsed = true;
      }
    } else if (source !== null) {
      paragraph.appendChild(scratch.createTextNode(": "));
      while (source.firstChild !== null) {
        paragraph.appendChild(source.firstChild);
      }
      captionUsed = true;
    }
    // The figure's anchor, and its caption's, go where the text now is.
    const anchors = [figure, caption]
      .map((element) => element?.getAttribute(ANCHOR_ATTR) ?? "")
      .filter((value) => value !== "");
    if (anchors.length > 0) {
      paragraph.setAttribute(ANCHOR_ATTR, anchors.join(" "));
    }
    figure.replaceWith(paragraph);
    // A caption a paragraph cannot absorb is kept as its own block rather than
    // dropped: losing content off the page is worse than a loose caption.
    if (!captionUsed && caption !== null) paragraph.after(caption);
  }
  return scratch.body.innerHTML;
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
 * Clear the class tokens that make Readability delete a code block, and change
 * nothing else about the page.
 *
 * `_cleanConditionally` deletes an element outright once
 * `weight + contentScore < 0`, its `contentScore` is a literal `0` there, and
 * `_getClassWeight`'s regex is a *substring* test — so one accidental collision
 * takes the whole subtree before anything looks at what it holds. Tailwind's
 * compound utilities collide by chance: `overflow-hidden` and `outline-hidden`
 * contain `hidden`, `code-block-scroll` contains `scroll`. A clipped
 * platform.claude.com article lost all 15 of its code blocks that way.
 *
 * This replaced a pass that *unwrapped* those wrappers, and the difference is
 * the point. Unwrapping discards the element, so it discards every attribute
 * and class Readability judges on — which meant re-deriving its rules here: an
 * attribute allow-list, a copy of `UNLIKELY_ROLES`, a copy of the negative
 * regex minus two tokens, a byline check. Seven defects were found in that
 * apparatus across five review rounds, each one a rule mirrored slightly wrong
 * or not at all, and the last was invisible to every offline test: React adds
 * `aria-labelledby` on hydration, the allow-list refused it, and only a clip
 * taken in a real browser could show the block being lost.
 *
 * Removing two proven-false class tokens needs no such permission. Readability
 * still reads the element and every other class on it, and still applies
 * `_removeUnlikelyCandidates`, `_isValidByline`, `UNLIKELY_ROLES` and
 * `_isProbablyVisible` — none of which this file now has to know about. The
 * warning written above `carriesMoreThanLayout`, that enumerating Readability's
 * verdicts "was tried and failed three times running", applies to this pass
 * too; this is what not enumerating them looks like.
 *
 * Leaving the wrapper in place is safe for the block. `_cleanConditionally`'s
 * remaining clauses need links, images, list items, inputs or embeds to fire;
 * its "suspiciously short" clause also requires `linkDensity > 0`, which code
 * never has; and `PRE` is in `DIV_TO_P_ELEMS`, so `_getTextDensity` counts a
 * code block as text and the "no useful content" clause cannot fire either. A
 * one-line `npm i` inside a wrapper survives, which is tested.
 *
 * Runs after `recoverCodeBlocks`, which reads a language from these same
 * containers (`CONTAINER_LANG_PATTERNS`).
 */
function declassifyCodeWrappers(doc: Document): void {
  for (const pre of Array.from(doc.querySelectorAll("pre"))) {
    // Widen out one container at a time, stopping at the first that carries
    // something besides the code: the class on *that* one is about more than
    // this block, so it is not ours to read.
    let wrapper = pre.parentElement;
    while (wrapper !== null && holdsOnlyCode(wrapper)) {
      dropLayoutCollisions(wrapper);
      wrapper = wrapper.parentElement;
    }
  }
}

/**
 * Readability's `negative` regex, copied verbatim from `Readability.js:146`.
 *
 * Verbatim, with nothing carved out of it, because the exceptions now live in
 * `isLayoutCollision` as a question about a single token rather than as edits
 * to a shared pattern. `NEGATIVE_EXCEPT_MEDIA` above shows the cost of the
 * other approach: a reader has to diff two long regexes to see what was excused.
 */
const READABILITY_NEGATIVE =
  /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i;

function dropLayoutCollisions(element: Element): void {
  const classes = classListOf(element);
  const kept = classes.filter((name) => !isLayoutCollision(name, element));
  if (kept.length === classes.length) return;
  if (kept.length === 0) element.removeAttribute("class");
  else element.setAttribute("class", kept.join(" "));
}

/**
 * True when a class token costs its element weight for no reason but the
 * accident this pass exists to correct.
 *
 * Three questions, and a token must pass all of them. Does Readability dock it
 * at all? Does it actually hide the element — in which case Readability is
 * right and the block should stay deleted? And with the two colliding words
 * taken out, is it *still* furniture: `promo-hidden` is a promo box whatever
 * else it says, and `sidebar-scroll` is a sidebar.
 *
 * That last question is what keeps this from being an exception list that has
 * to anticipate class names. `overflow-hidden` minus `hidden` is `overflow-`,
 * which Readability does not object to, so the objection was entirely the
 * collision — and a name nobody has seen yet is judged by the same rule.
 */
function isLayoutCollision(token: string, element: Element): boolean {
  if (!READABILITY_NEGATIVE.test(token)) return false;
  if (hidesElement(token, element)) return false;
  return !READABILITY_NEGATIVE.test(token.replace(/hidden|scroll/gi, ""));
}

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
  // First, and order-independent: it changes no structure, only a tag name the
  // passes below have no opinion about.
  retagFontsAsSpans(doc);
  // Early: it only moves whole blocks, and every pass below should see the
  // article as the one body it is.
  joinSplitArticleBodies(doc);
  normalizeLinkTitles(doc);
  unwrapEquationTables(doc);
  normalizeMath(doc);
  recoverCodeBlocks(doc);
  // After recoverCodeBlocks, which reads a language from these same containers;
  // the other order trades a dropped block for a bare fence.
  declassifyCodeWrappers(doc);
  stripRedundantListMarkers(doc);
  unwrapPictures(doc);
  clearLatexmlPlaceholderAlts(doc);
  dropEmptyCitations(doc);
  keepVideosThroughReadability(doc);
  // After unwrapPictures and the math and code recovery, so an image, a formula
  // or a fence is already there to rule a figure out; before dropChartSvgs,
  // which would empty a chart's figure into one this mistakes for a shell; and
  // before markInDocumentAnchors, so a link to the figure marks what survives.
  keepScriptFiguresThroughReadability(doc);
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
  // Before the anchor marking below, which is the whole point of the ordering:
  // the link this restores is both a reference that pass has to count and the
  // target it has to mark.
  restoreFootnoteRefs(doc);
  // Last: a separate pass over the finished DOM, for the reason
  // `markCodeLanguages` gives — everything above may move or replace the very
  // elements a link points at, and the marker has to land on what survives.
  markInDocumentAnchors(doc);
}

/** Readability's own words for a class that holds an article (its
 * `REGEXPS.positive`) and for one that does not (`REGEXPS.negative`). */
const BODY_CLASS =
  /article|body|content|entry|hentry|h-entry|main|page|post|text|blog|story/i;
const NOT_BODY_CLASS =
  /-ad-|hidden|banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i;

/** A stretch of body has paragraphs of its own; a footnote, a callout or a
 * pull quote has one. */
const MIN_PART_PARAGRAPHS = 2;
/** What may sit between two stretches: an ad slot's label, not prose. */
const MAX_GAP_TEXT = 100;
/** Anything a reader would miss if the stretches closed up over it. */
const GAP_CONTENT = new Set([
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "FIGURE",
  "IMG",
  "PICTURE",
  "VIDEO",
  "AUDIO",
  "IFRAME",
  "TABLE",
  "PRE",
  "BLOCKQUOTE",
  "UL",
  "OL",
  // A thematic break is the page saying the stretches are apart: Dario
  // Amodei's essay rules one off before its acknowledgments.
  "HR",
]);

/**
 * An article the page split into several bodies, joined back into one.
 *
 * Ars Technica puts each stretch of an article in its own
 * `div.post-content.post-content-double`, each in its own grid row with an ad
 * slot between, all inside one `<article>`. They are cousins, not siblings, so
 * Readability's joining of a top candidate's siblings never reaches them: it
 * scored the three bodies apart and kept the last — five of fourteen
 * paragraphs, opening mid-argument.
 *
 * Joined, into the first and in page order, only when every one of these holds
 * — because the same shape, a class repeated inside one article, is also how
 * pages mark things that must stay apart:
 *
 * - **One `<article>`**, so an index page's teasers never run together.
 * - **The same class, one Readability scores as the body**, so a thread of
 *   `comment-content` blocks is never merged.
 * - **Each a real stretch**: at least two paragraphs of its own. Substack's
 *   `footnote-content` blocks, callouts and pull quotes have one or two.
 * - **Nothing between them a reader would miss**: no heading, figure, table,
 *   list, quote or code, and no more text than an ad slot's label. That is
 *   what tells Ars's ad-split body from an org-mode export or a wiki, whose
 *   same-class section bodies each follow their own heading and would be
 *   pulled away from it. All or nothing: one gap with content keeps the
 *   whole group apart.
 */
export function joinSplitArticleBodies(doc: Document): void {
  for (const article of Array.from(doc.querySelectorAll("article"))) {
    const groups = new Map<string, Element[]>();
    for (const el of Array.from(article.querySelectorAll("[class]"))) {
      const cls = (el.getAttribute("class") ?? "").trim();
      if (!BODY_CLASS.test(cls) || NOT_BODY_CLASS.test(cls)) continue;
      // A nested <article> is its own article, joined on its own turn.
      if (el.parentElement?.closest("article") !== article) continue;
      const paragraphs = Array.from(el.children).filter(
        (c) => c.tagName === "P",
      ).length;
      if (paragraphs < MIN_PART_PARAGRAPHS) continue;
      const key = cls.split(/\s+/).sort().join(" ");
      groups.set(key, [...(groups.get(key) ?? []), el]);
    }
    for (const parts of groups.values()) {
      const outermost = parts.filter(
        (part) =>
          !parts.some((other) => other !== part && other.contains(part)),
      );
      if (outermost.length < 2 || !onlyChromeBetween(doc, article, outermost)) {
        continue;
      }
      const [first, ...rest] = outermost;
      if (first === undefined) continue;
      for (const part of rest) {
        while (part.firstChild !== null) first.appendChild(part.firstChild);
        part.remove();
      }
    }
  }
}

/** A class or id token that names an ad slot: `ad`, `ads`, `ad-wrapper`,
 * `ad--mid-content`, `cns-ads-stage`, `advertisement`, `adsbygoogle`. Matched
 * per token, never as a substring, so `load-more`, `shadow` and `header` do
 * not. */
const AD_TOKEN =
  /^(?:ads?|advert\w*|adsbygoogle|sponsored)$|^ads?[-_]|[-_]ads?(?:[-_]|$)/i;

function isAdSlot(el: Element): boolean {
  const tokens = [
    ...(el.getAttribute("class") ?? "").split(/\s+/),
    ...(el.id === "" ? [] : [el.id]),
  ];
  return tokens.some((token) => token !== "" && AD_TOKEN.test(token));
}

/**
 * Whether what lies between consecutive `parts` (in document order) is
 * chrome — wrappers, and ad slots with whatever they hold — rather than
 * content.
 *
 * An ad slot is skipped whole: Ars's are empty in the page as served, which
 * is all the processor ever sees, but a reader's browser has filled them by
 * the time they clip, with an iframe, an image and an "Advertisement" label —
 * and taken for content, those kept every desktop clip at its last stretch.
 */
function onlyChromeBetween(
  doc: Document,
  article: Element,
  parts: readonly Element[],
): boolean {
  const gapText = parts.map(() => 0);
  const adSlots: Element[] = [];
  // SHOW_ELEMENT | SHOW_TEXT, as numbers: the constants live on the window.
  const walker = doc.createTreeWalker(article, 0x1 | 0x4);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (parts.some((part) => part.contains(node))) continue;
    if (adSlots.some((slot) => slot.contains(node))) continue;
    if (
      node.nodeType === 1 &&
      !parts.some((part) => node.contains(part)) &&
      isAdSlot(node as Element)
    ) {
      adSlots.push(node as Element);
      continue;
    }
    // How many parts come before this node; 1..n-1 is a gap between two.
    const before = parts.filter(
      (part) =>
        (part.compareDocumentPosition(node) &
          0x4) /* DOCUMENT_POSITION_FOLLOWING */ !==
        0,
    ).length;
    if (before < 1 || before >= parts.length) continue;
    if (node.nodeType === 1) {
      if (GAP_CONTENT.has((node as Element).tagName)) return false;
      continue;
    }
    gapText[before] =
      (gapText[before] ?? 0) + (node.textContent ?? "").trim().length;
    if ((gapText[before] ?? 0) > MAX_GAP_TEXT) return false;
  }
  return true;
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

export const ANCHOR_ATTR = "data-tiro-anchor";

/**
 * An id this is willing to carry into the vault, and the reason the whole
 * feature can ignore percent-encoding: every string matching this is its own
 * `decodeURIComponent`, so the fragment a link wrote and the id an element
 * carries are the same bytes either way. Anchored, because a page chooses these
 * and the value ends up inside an HTML attribute in a public article.
 */
const ANCHOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Elements that hold a block's text directly — where an anchor can sit and
 * still be inline. */
const TEXT_HOST: ReadonlySet<string> = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "TD",
  "TH",
  "FIGCAPTION",
  "DT",
  "DD",
  "CAPTION",
]);

/**
 * A link that says it is a footnote's way back to its reference.
 *
 * Four spellings, one per generator family that ships one:
 * `data-footnote-backref` (GFM, and so GitHub, Hugo and remark-gfm),
 * `class="footnote-backref"` (markdown-it), `class="footnote-back"
 * role="doc-backlink"` (Pandoc), and `rev="footnote"`, the HTML4 convention
 * hand-written pages still use.
 */
const FOOTNOTE_BACKREF = [
  "a[data-footnote-backref]",
  'a[rev="footnote"]',
  'a[role="doc-backlink"]',
  'a[class~="footnote-backref"]',
  'a[class~="footnote-back"]',
  'a[class~="footnote-return"]',
].join(",");

/** A region that says the notes inside it are footnotes. */
const FOOTNOTE_SECTION =
  '[data-footnotes], [role="doc-endnotes"], .footnotes, #footnotes';

/**
 * What a backref says when the markup says nothing about it.
 *
 * Return marks and nothing else, because telling one from a sentence is the
 * whole job: a note may link anywhere the article goes — "jump to the example
 * control" — and being inside a footnotes region says nothing about which of
 * its links is the way back.
 */
const BACKREF_MARK = /^[\u21a9\u21b0\u21b1\u2191\u23ce\u2b90\u2303^«‹]$/;

function looksLikeBackref(link: Element): boolean {
  const text = (link.textContent ?? "")
    // markdown-it and Pandoc write `↩︎` — the same arrow, with U+FE0E asking
    // for its text presentation rather than the emoji one.
    .replace(/[\ufe0e\ufe0f]/g, "")
    .trim();
  return BACKREF_MARK.test(text);
}

/**
 * Give a footnote reference back the `<a>` the page replaced it with.
 *
 * Sites increasingly enhance their footnotes into popovers or sidenotes, and
 * the usual way to do it is to swap the reference for a button: vale.rocks'
 * `footnotes.js` runs `reference.parentNode.replaceChild(button, reference)`
 * over every `sup a[data-footnote-ref]`, leaving
 * `<sup><button id="footnote-ref-1">1</button></sup>` with no `href` on it at
 * all. Readability then deletes it, because it deletes every `<button>`
 * (`_clean(articleContent, "button")`), and the whole reference goes with it —
 * the essay reads "should never be used" where the page says "should never¹ be
 * used", and the note's `↩` survives, being an ordinary link, pointing at an id
 * nothing carries any more. Both halves of the footnote are published and
 * neither can reach the other.
 *
 * **The lost href is recovered by reciprocity, not by knowing the site.** The
 * backref still says which id was the reference (`href="#footnote-ref-1"`) and
 * the `<li>` holding it says which id is the note (`id="footnote-1"`); that
 * pairing is the entire thing the enhancement destroyed. Every footnote
 * generator worth naming — GFM, markdown-it, Pandoc, Hugo, Eleventy — renders
 * notes as `<ol><li id=…>`, so reading the pairing off that shape covers all of
 * them without enumerating any of them.
 *
 * **One element in place of one element**, the rule `retagFontsAsSpans`
 * records: Readability scores candidates by what their subtree holds, so a
 * repair that changes the element count can change which container it picks.
 * `<button>` → `<a>` leaves the tree exactly as large as it was. It does move
 * link density, which `_cleanConditionally` reads — a footnote marker is one
 * character against a paragraph, so the shift is far below anything that
 * decides a verdict, and the corpus sweep is what would show otherwise.
 *
 * Restricted to `<button>` because that is the defect. `<button>` is the one
 * tag on Readability's unconditional delete list that pages put inline in
 * prose; a target that survives extraction is not broken, and an `<a>` target
 * never was. The other guards each close a way of being wrong: an empty
 * reference produces no markdown, so repairing it buys nothing (`producesLink`
 * draws the same line); a reference holding a link would become an `<a>` inside
 * an `<a>`, which markdown cannot express and which is why `anchorReplacement`
 * emits a span.
 *
 * **Reciprocity alone is not enough to know a footnote, which cost a review
 * round.** A numbered tutorial whose steps carry ids, linking at a `Run
 * example` button, satisfies it exactly — and the repair then published that
 * button's label as a paragraph of its own, chrome Readability had correctly
 * deleted, with the step and the button linking circularly at each other. So
 * the page has to say so. The markup declaring the link a backref
 * (`FOOTNOTE_BACKREF`) is enough on its own, and covers all four generator
 * families. A footnotes region (`FOOTNOTE_SECTION`) is **not**, which cost a
 * second review round: a note may link anywhere the article goes, and one
 * saying "jump to the example control" turned that control's button into the
 * note's reverse link — on a page whose real footnote was marked correctly and
 * repaired correctly beside it. Being in the region says nothing about *which*
 * of a note's links is the way back, so that path additionally requires the
 * link to read as one (`looksLikeBackref`), which is how a hand-written
 * `<section class="footnotes">` with a bare `↩` still works.
 *
 * Before `markInDocumentAnchors`, necessarily: that pass has to see this link
 * to count `#footnote-1` as referenced at all, and to mark the reference as the
 * target `#footnote-ref-1` needs. So this is the one place a *reference* is
 * created rather than found, widening that pass's bound by one link — ADR 0024
 * decision 14, which also corrects that ADR's claim that Readability is not at
 * fault for a lost target.
 */
function restoreFootnoteRefs(doc: Document): void {
  for (const backref of Array.from(doc.querySelectorAll("li[id] a[href]"))) {
    const href = backref.getAttribute("href") ?? "";
    // The same reading `referencedFragments` makes, for the same reasons: a
    // bare "#" addresses the top of the page, and `ANCHOR_ID` is what this file
    // is willing to write into a public article.
    if (!href.startsWith("#") || href.length < 2) continue;
    // The page must say this *link* is a backref — see the comment above. The
    // markup saying so is enough on its own; the region saying so is not.
    const declares = backref.matches(FOOTNOTE_BACKREF);
    const marks =
      backref.closest(FOOTNOTE_SECTION) !== null && looksLikeBackref(backref);
    if (!declares && !marks) continue;
    let refId: string;
    try {
      refId = decodeURIComponent(href.slice(1));
    } catch {
      continue;
    }
    // `closest`, not the matched ancestor: a note nested in an inner list must
    // pair with the item that actually carries an id.
    const noteId = backref.closest("li[id]")?.getAttribute("id") ?? "";
    if (!ANCHOR_ID.test(refId) || !ANCHOR_ID.test(noteId)) continue;
    // `getElementById`, never `querySelector`, for the reason `anchorTarget`
    // gives: `fn:1` is an id a page may choose and is not a valid selector.
    const reference = doc.getElementById(refId);
    if (reference === null) continue;
    if (reference.tagName.toUpperCase() !== "BUTTON") continue;
    // `producesLink`, not a text test: this file already has one definition of
    // "will this still be a link once Turndown is done", and an image-only
    // reference is exactly the shape the two disagree about.
    if (!producesLink(reference)) continue;
    if (reference.querySelector("a") !== null) continue;
    const link = doc.createElement("a");
    link.setAttribute("id", refId);
    link.setAttribute("href", `#${noteId}`);
    // Materialized: `childNodes` is live, and appendChild is moving its entries
    // out from under the iteration.
    for (const child of Array.from(reference.childNodes)) {
      link.appendChild(child);
    }
    reference.replaceWith(link);
  }
}

/**
 * Mark the elements an in-document link points at, so the anchor can be written
 * once Readability is out of the way.
 *
 * The third user of the contract ADR 0009 states: compute before Readability,
 * carry it across on a `data-*`, act after. Here the "compute before" half is
 * not a preference but a requirement in both directions — Readability keeps
 * `id`, `name` and hash hrefs, so the information survives on its own, but
 * `_prepArticle` *deletes* a `<p>` with no text in it, which is exactly the
 * hand-written `<p><a name="x"></a></p>` idiom. Inserting the anchor before
 * Readability would hand it to that deletion, and would change the child counts
 * `_isElementWithoutContent` and `_hasSingleTagInsideElement` judge by.
 *
 * Bounded to ids something actually links to. One arXiv paper carries 2257 ids
 * and 258 references; anchoring every id would put two thousand spans of pure
 * noise in the vault to no end.
 */
function markInDocumentAnchors(doc: Document): void {
  // Page-authored markers go first. Every marker pass in this file does this,
  // and it matters more here than for the others: this one's *value* is written
  // into an attribute that reaches a public page.
  for (const stale of Array.from(doc.querySelectorAll(`[${ANCHOR_ATTR}]`))) {
    stale.removeAttribute(ANCHOR_ATTR);
  }
  for (const id of referencedFragments(doc)) {
    const found = anchorTarget(doc, id);
    if (found === null) continue;
    // Appended, not assigned. Two empty named anchors in one paragraph —
    // `<p><a name="a"></a><a name="b"></a></p><h2>` — both hoist onto the same
    // heading, and overwriting meant the first link kept a target that was
    // never emitted. The separator is a space because `ANCHOR_ID` cannot
    // contain one, so the split is unambiguous.
    const host = hoistTarget(found) ?? found;
    const marked = host.getAttribute(ANCHOR_ATTR);
    host.setAttribute(ANCHOR_ATTR, marked === null ? id : `${marked} ${id}`);
  }
}

/**
 * Will this link still be a link once Turndown is done with it?
 *
 * Static site generators end every heading with a self-referential permalink —
 * an empty `<a>`, or one holding only an `<svg>` icon — and `inlineLinkRule`
 * drops a link whose content flattens to nothing, exactly as it should. Counting
 * one as a reference would anchor every heading on such a site for a referrer
 * that no longer exists in the markdown. Mirrors the rule's own test, with the
 * one case where empty text still produces output: an image.
 */
function producesLink(link: Element): boolean {
  return (
    (link.textContent ?? "").trim() !== "" ||
    link.querySelector("img, picture") !== null
  );
}

function referencedFragments(doc: Document | DocumentFragment): Set<string> {
  const referenced = new Set<string>();
  for (const link of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = link.getAttribute("href") ?? "";
    // A bare "#" addresses the top of the page, not an id.
    if (!href.startsWith("#") || href.length < 2) continue;
    if (!producesLink(link)) continue;
    let id: string;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      continue;
    }
    if (ANCHOR_ID.test(id)) referenced.add(id);
  }
  return referenced;
}

function anchorTarget(doc: Document, id: string): Element | null {
  // `getElementById`, never `querySelector("#" + id)`: `bib.bib4` and `fn:1`
  // are ids a page is entitled to choose and neither is a valid CSS selector,
  // so building a selector out of one either throws or matches the wrong thing.
  const byId = doc.getElementById(id);
  if (byId !== null) return byId;
  for (const named of Array.from(doc.querySelectorAll("[name]"))) {
    if (named.getAttribute("name") === id) return named;
  }
  return null;
}

/**
 * `<p><a name="x"></a></p>` — the hand-written anchor, and the one shape whose
 * target does not survive at all: Readability removes a paragraph with no text
 * in it. Marking the element *after* it keeps the link working, and is what the
 * page meant by putting the anchor there.
 */
function hoistTarget(target: Element): Element | null {
  if (!CAPTION_INLINE.has(target.tagName.toUpperCase())) return null;
  if ((target.textContent ?? "").trim() !== "") return null;
  const parent = target.parentElement;
  if (parent === null) return null;
  // `isEmptyParagraph`, not a text test — `CAPTION_INLINE` includes `IMG`, so
  // an id on the image in `<p><img></p>` is a target whose paragraph holds no
  // text, and hoisting moved it to the next block: the link jumped past the
  // photo it named.
  if (!isEmptyParagraph(parent)) return null;
  // Past every sibling that is itself an empty paragraph. Hand-written pages
  // stack the idiom — `<p><a name="a"></a></p><p><a name="b"></a></p><h2>` —
  // and hoisting onto the next empty paragraph would hand the marker to an
  // element Readability deletes for the same reason it deletes this one. Both
  // ids end up on the heading, which `markInDocumentAnchors` now appends
  // rather than overwrites.
  let next = parent.nextElementSibling;
  while (next !== null && isEmptyParagraph(next)) {
    next = next.nextElementSibling;
  }
  return next;
}

/**
 * A paragraph Readability will delete — which is the only reason to hoist past
 * one, so this mirrors its rule rather than inventing one. `_prepArticle` drops
 * a `<p>` with no inner text *and* no `img`, `embed`, `object` or `iframe`;
 * testing text alone called an image-only paragraph empty and moved a target
 * past the very figure it named, so `#photo` landed on the heading below it.
 */
function isEmptyParagraph(element: Element): boolean {
  return (
    element.tagName.toUpperCase() === "P" &&
    (element.textContent ?? "").trim() === "" &&
    element.querySelector("img, embed, object, iframe") === null
  );
}

/**
 * Turn the markers into anchors, on the HTML Readability returned.
 *
 * Runs before `foldFiguresIn` on purpose: a `<figure id>` resolves to its
 * `<figcaption>`, and the fold then carries the anchor into the caption half of
 * the paragraph it builds, where the picture is still `children[0]`.
 */
export function placeAnchorsIn(html: string, doc: Document): string {
  const scratch = doc.implementation.createHTMLDocument("");
  scratch.body.innerHTML = html;
  // Asked again, of what Readability kept. The marking pass could only see the
  // whole page, and Readability routinely drops the table of contents whose
  // links are the reason a heading was marked at all — leaving an anchor for a
  // link that is no longer in the article. Intersecting here is what makes the
  // bound mean what it says: an anchor exists because something in this body
  // points at it.
  const referenced = referencedFragments(scratch);
  for (const target of Array.from(
    scratch.querySelectorAll(`[${ANCHOR_ATTR}]`),
  )) {
    const marked = target.getAttribute(ANCHOR_ATTR) ?? "";
    target.removeAttribute(ANCHOR_ATTR);
    // Validated again rather than trusted from across the extraction boundary,
    // for the reason `restoreCodeLanguagesIn` gives.
    const ids = marked
      .split(" ")
      .filter((id) => id !== "" && referenced.has(id) && ANCHOR_ID.test(id));
    if (ids.length === 0) continue;
    // Refused outright inside a fence. Turndown's fenced-code rule wants the
    // `<code>` to be the `<pre>`'s first child; one inserted sibling collapses
    // the whole block to inline code and takes its language with it.
    if (target.closest("pre") !== null) continue;
    const placement = placementFor(target);
    if (placement === null) continue;
    for (const id of ids) {
      const anchor = scratch.createElement("span");
      anchor.setAttribute(ANCHOR_ATTR, id);
      placement.host.insertBefore(anchor, placement.before);
    }
  }
  return scratch.body.innerHTML;
}

function placementFor(
  target: Element,
): { host: Element; before: Node | null } | null {
  const tag = target.tagName.toUpperCase();
  // An inline target keeps its place. Walking up to the block would put a
  // footnote marker's anchor at the top of the whole essay.
  if (CAPTION_INLINE.has(tag)) {
    // Except in front of media. `foldFigureCaptions` needs the picture to be
    // its container's only meaningful child, and an inserted span is one — so
    // an id on the image of a captioned figure would silently cost the fold,
    // turning the caption into a paragraph of its own. Refusing leaves the link
    // dead, which is where it started; it is the same trade `anchorPoint` makes
    // for an image-leading host, and it does not depend on enumerating which
    // shapes fold.
    if (isPictureLike(target) || target.querySelector("img") !== null) {
      return null;
    }
    const parent = target.parentElement;
    return parent === null ? null : { host: parent, before: target };
  }
  const host = TEXT_HOST.has(tag)
    ? descendToHost(target)
    : firstTextHost(target);
  if (host === null) return null;
  const before = anchorPoint(host);
  return before === undefined ? null : { host, before };
}

/** `<li><p>…</p></li>` is one block with two hosts; the inner one is where the
 * text is, and an anchor above it would land outside the list item's line. */
function descendToHost(host: Element): Element {
  let current = host;
  for (;;) {
    const child = current.firstElementChild;
    if (child === null || !TEXT_HOST.has(child.tagName.toUpperCase())) {
      return current;
    }
    current = child;
  }
}

/** A container target — `<section id="S1">`, `<figure id="F1">` — anchors at
 * the first thing inside it that holds text. */
function firstTextHost(container: Element): Element | null {
  for (const element of Array.from(container.querySelectorAll("*"))) {
    if (TEXT_HOST.has(element.tagName.toUpperCase())) {
      return descendToHost(element);
    }
  }
  return null;
}

/**
 * Where inside a host the anchor may go, or `undefined` for "nowhere safe".
 *
 * Skipping past breaks, checkbox inputs and a leading picture is not tidiness:
 * an anchor before a task list's `<input>` breaks the checkbox, and one before
 * a figure's image stops `rehypeFigureCaptions` recognising the paragraph,
 * because both read their subject at the start. The picture test is drawn
 * exactly where `pictureOf` here and `isPicture` in the site's renderer draw
 * it — ADR 0011 already requires those two to move together, and this is a
 * third reader of the same definition.
 */
function anchorPoint(host: Element): Node | null | undefined {
  for (const node of Array.from(host.childNodes)) {
    if (node.nodeType === node.TEXT_NODE) {
      if ((node.textContent ?? "").trim() === "") continue;
      return node;
    }
    if (node.nodeType !== node.ELEMENT_NODE) continue;
    const element = node as Element;
    const tag = element.tagName.toUpperCase();
    if (tag === "BR" || tag === "INPUT") continue;
    if (isPictureLike(element)) continue;
    return node;
  }
  return undefined;
}

function isPictureLike(element: Element): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === "IMG") return true;
  if (tag !== "A") return false;
  const children = Array.from(element.children);
  return (
    children.length === 1 &&
    children[0]?.tagName.toUpperCase() === "IMG" &&
    (element.textContent ?? "").trim() === ""
  );
}

/**
 * The other half of the anchor contract: how a marked span becomes markdown.
 *
 * A `<span>` rather than an `<a>`, for three reasons in descending weight: an
 * `<a>` nested inside another `<a>` is a shape that really occurs and markdown
 * cannot express it; `<a>` would inherit the prose link styling on an element
 * that shows nothing; and `marker()` above already builds a
 * `<span data-tiro-*>` for math, so this is the established shape.
 *
 * Reached through Turndown's `blankReplacement` rather than as a rule, which is
 * not a preference: `rules.forNode` short-circuits to the blank rule *before*
 * it consults any rule, and an empty span is blank by definition — no text, no
 * void child. The math marker never hit this because its span holds the TeX.
 * `blankReplacement` is the one hook that runs for a node with nothing in it.
 */
export function anchorReplacement(node: Node): string | null {
  const element = node as Element;
  const id = element.getAttribute?.(ANCHOR_ATTR);
  if (id == null || !ANCHOR_ID.test(id)) return null;
  // Refused when what follows is a block. The anchor would then sit alone on
  // its line, which CommonMark reads as an HTML block, and the reader would
  // grow an empty row that `zh.md` has to match. One dead link is cheaper.
  if (!hasInlineFollower(element)) return "";
  return `<span id="${id}"></span>`;
}

function hasInlineFollower(element: Element): boolean {
  let next = element.nextSibling;
  while (next !== null) {
    if (next.nodeType === next.TEXT_NODE) {
      if ((next.textContent ?? "").trim() !== "") return true;
      next = next.nextSibling;
      continue;
    }
    if (next.nodeType !== next.ELEMENT_NODE) {
      next = next.nextSibling;
      continue;
    }
    return CAPTION_INLINE.has((next as Element).tagName.toUpperCase());
  }
  return false;
}

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

/**
 * Frontmatter read out of a LaTeXML document.
 *
 * Keyed on `.ltx_*` classes rather than on arxiv.org, like every other repair
 * in this file. LaTeXML is the renderer, arXiv is only its largest user, and a
 * host check would exclude ar5iv and every mirror for no gain.
 */
export interface LatexmlMetadata {
  title?: string;
  author?: string;
  excerpt?: string;
}

/** Collapse LaTeXML's generous whitespace — it indents markup for readability,
 * so `textContent` arrives full of newlines and runs of spaces. */
function collapseText(node: Element | null): string {
  return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * True when the document is a real LaTeXML rendering rather than a stub.
 *
 * arXiv serves HTTP 200 with a valid `.ltx_document` for papers it could not
 * really convert — a `\includepdf` submission renders as the single sentence
 * "See pages 1-last of 0_adam_main.pdf" (arxiv.org/html/1412.6980 is the case
 * this was written against). Those pages carry no document title, no abstract,
 * no author and no sections, so requiring a title *or* a section separates them
 * without assuming every paper has an abstract.
 */
export function hasLatexmlFullText(doc: Document): boolean {
  if (doc.querySelector(".ltx_document") === null) return false;
  return (
    doc.querySelector(".ltx_title_document") !== null ||
    doc.querySelector(".ltx_section") !== null
  );
}

/**
 * Read title, authors and abstract from a LaTeXML document, or `null` if it is
 * not one.
 *
 * Worth doing because these pages carry *no* metadata of their own — no
 * `<meta>`, no `rel="canonical"`, nothing — so Readability's byline heuristic
 * falls back to scraping the rendered author block, and LaTeXML renders
 * acknowledgements and affiliations inside it. That is where
 * `author: "Stephen Chung\nThanks: DualverseAI; University of Cambridge"` and
 * an excerpt of `††thanks:` markers in the vault came from.
 *
 * Reads a clone of the author block rather than stripping the notes in place:
 * this runs before Readability, and removing nodes here would change what it
 * selects on. The leaked notes in the *body* are a separate defect.
 */
export function readLatexmlMetadata(doc: Document): LatexmlMetadata | null {
  if (doc.querySelector(".ltx_document") === null) return null;
  const metadata: LatexmlMetadata = {};

  const title = collapseText(doc.querySelector(".ltx_title_document"));
  if (title !== "") metadata.title = title;

  const author = readLatexmlAuthors(doc);
  if (author !== "") metadata.author = author;

  const excerpt = readLatexmlAbstract(doc);
  if (excerpt !== "") metadata.excerpt = excerpt;

  return metadata;
}

/** Author notes: the `†thanks:` footnote LaTeXML anchors to a name, and the
 * affiliation list it hangs beside it. Both are prose about an author rather
 * than a name, and both land inside `.ltx_authors`. */
const LATEXML_AUTHOR_NOTES =
  ".ltx_note, .ltx_author_notes, .ltx_contact, .ltx_role_thanks";

function readLatexmlAuthors(doc: Document): string {
  const authors = doc.querySelector(".ltx_authors");
  if (authors === null) return "";
  const clone = authors.cloneNode(true) as Element;
  for (const note of Array.from(clone.querySelectorAll(LATEXML_AUTHOR_NOTES))) {
    note.remove();
  }
  const names = Array.from(clone.querySelectorAll(".ltx_personname"))
    .map((name) => collapseText(name))
    .filter((name) => name !== "");
  // Fall back to the block's own text when the markup names no person: some
  // papers set the author line as plain text inside `.ltx_authors`. Better a
  // collapsed line than no author at all.
  return names.length > 0 ? names.join(", ") : collapseText(clone);
}

/**
 * Longest excerpt worth storing.
 *
 * An abstract is the right excerpt for a paper, but a whole one runs past 1,500
 * characters where the rest of the vault's excerpts have a median of 171 — and
 * the only thing that reads an excerpt is a `<meta name="description">` and an
 * RSS fallback, both of which truncate anyway. Cut on a word boundary so the
 * result is a sentence fragment rather than a broken word.
 */
const EXCERPT_MAX = 400;

export function truncateExcerpt(text: string): string {
  if (text.length <= EXCERPT_MAX) return text;
  const cut = text.slice(0, EXCERPT_MAX);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary === -1 ? cut : cut.slice(0, boundary)).trimEnd()}…`;
}

function readLatexmlAbstract(doc: Document): string {
  const abstract = doc.querySelector(".ltx_abstract");
  if (abstract === null) return "";
  const clone = abstract.cloneNode(true) as Element;
  // "Abstract" is a heading LaTeXML renders inside the block; keeping it would
  // put the word at the front of every arXiv excerpt on the site.
  for (const heading of Array.from(
    clone.querySelectorAll(".ltx_title_abstract"),
  )) {
    heading.remove();
  }
  return truncateExcerpt(collapseText(clone));
}
