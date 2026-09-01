import { gfm } from "@joplin/turndown-plugin-gfm";
import TurndownService from "turndown";
import { MATH_ATTR, mathTurndownRule } from "./dom-prepare.ts";

export interface MarkdownResult {
  markdown: string;
  /**
   * The converted HTML carried recovered math, so literal dollars in its prose
   * were escaped. This is what frontmatter `has_math` records — see
   * `escapeLiteralDollars` for what the flag actually promises.
   */
  hasMath: boolean;
}

/**
 * Escape every literal `$` so it cannot be read as a math delimiter.
 *
 * This is the whole reason `has_math` can mean something enforceable. Turndown
 * applies this to text nodes only — code spans and fenced blocks take the
 * `isCode` path and are never escaped — and rule output bypasses escaping
 * entirely, so a formula recovered by `mathTurndownRule` keeps its bare
 * delimiters while the prose around it does not. Whether a `$` is a price or a
 * formula is decided here, at the one point in the pipeline that still has the
 * page's DOM to answer it, rather than guessed later from the markdown.
 */
export function escapeLiteralDollars(text: string): string {
  return text.replace(/\$/g, () => "\\$");
}

/** True when the HTML still contains formulas recovered by dom-prepare. */
export function containsMathMarker(html: string): boolean {
  return html.includes(`${MATH_ATTR}=`);
}

/**
 * Keep a link's text on one line.
 *
 * Turndown builds a link as `[` + content + `](href)`, and content is whatever
 * its child rules produced — so an `<a>` wrapping a block element gets that
 * element's surrounding blank lines *inside* the brackets. Substack wraps every
 * captioned image in `<a><div><img></a>`, which comes out as `[`, the image, and
 * `](url)` on three separate lines. Markdown cannot read that as a link: the
 * brackets render literally and the URL becomes a bare autolink, which is then
 * also the longest unbreakable token on the page.
 *
 * Ten links across three clipped articles arrive this way. Flattening the
 * content is enough — every one of them is an image or a short phrase, and a
 * link's text is inline by definition however the page marked it up.
 *
 * Mirrors Turndown's own `inlineLink` rule, including its escaping: `<>()` in
 * the destination, `"` in the title, angle brackets when the href has a space.
 */
export const inlineLinkRule: TurndownService.Rule = {
  filter: (node, options) =>
    options.linkStyle === "inlined" &&
    node.nodeName === "A" &&
    // Turndown tests the href for truthiness, not existence, so `href=""` falls
    // through to plain text. Matching that matters: an empty destination would
    // otherwise become `[text]()`, a link to the page the reader is already on.
    (node.getAttribute("href") ?? "") !== "",
  replacement: (content, node) => {
    const flat = content.replace(/\s+/g, " ").trim();
    // An empty anchor would produce `[](href)`, which renders as nothing at all.
    if (flat === "") return "";
    const element = node as Element;
    const raw = (element.getAttribute("href") ?? "").replace(
      /([<>()])/g,
      "\\$1",
    );
    const href = raw.includes(" ") ? `<${raw}>` : raw;
    const title = (element.getAttribute("title") ?? "").replace(/"/g, '\\"');
    return `[${flat}](${href}${title === "" ? "" : ` "${title}"`})`;
  },
};

/** Escape a string for use inside a double-quoted HTML attribute. */
function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Squash every run of whitespace, so the result cannot contain a blank line. */
function oneLine(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

/**
 * Whether an ancestor is a link.
 *
 * `inlineLinkRule` flattens a link's content onto one line, so a figure inside
 * an `<a>` would come out as `[<figure>…</figure>](href)` — raw HTML as the
 * text of a markdown link, which parses as a paragraph rather than an html
 * block. Walking `parentNode` rather than calling `closest`, which Turndown's
 * DOM does not implement.
 */
function insideLink(node: Node): boolean {
  let current = node.parentNode;
  while (current !== null && current !== undefined) {
    if (current.nodeName === "A") return true;
    current = current.parentNode;
  }
  return false;
}

/**
 * Keep a captioned image and its caption together as one `<figure>`.
 *
 * Turndown has no figure rule, so `<figure>`/`<figcaption>` are converted as
 * plain blocks: the image becomes a markdown image and the caption becomes an
 * ordinary paragraph directly beneath it, indistinguishable from body prose.
 * The reader cannot tell where the caption ends and the article resumes, and
 * on an academic post the credit line reads as the author's next sentence.
 * Twelve of the vault's 32 articles carry figures, one of them 32 of them.
 *
 * Emitted as raw HTML rather than markdown because markdown has no way to
 * express the association. Three constraints shape the exact string:
 *
 * - No blank line anywhere inside. A blank line ends a CommonMark type-6 HTML
 *   block, which would split one figure into several `html` blocks and break
 *   the 1:1 alignment `zh.md` depends on.
 * - Markdown is not parsed inside such a block, so the image is `<img>` rather
 *   than `![]()` and the caption keeps its own inline HTML.
 * - Only the attributes the site's sanitize schema allows are emitted, rebuilt
 *   from the DOM rather than copied from `outerHTML`, so a page's `class`,
 *   `style` and `srcset` cannot ride along.
 *
 * A figure with no caption stays a plain markdown image: there is nothing to
 * associate, and markdown keeps it translatable and repairable. The same
 * fallback covers a figure holding anything other than exactly one image,
 * where the pairing would be a guess.
 */
export const figureRule: TurndownService.Rule = {
  filter: "figure",
  replacement: (content, node) => {
    const element = node as Element;
    const images = element.querySelectorAll("img");
    if (images.length !== 1 || insideLink(node)) return content;
    const image = images[0];
    const src = image?.getAttribute("src") ?? "";
    // Optional chaining rather than a null check: Turndown's DOM returns
    // `undefined` for a missing node where a browser returns `null`.
    const text = oneLine(element.querySelector("figcaption")?.innerHTML ?? "");
    if (src === "" || text === "") return content;
    const alt = image?.getAttribute("alt") ?? "";
    return `\n\n<figure><img src="${attr(src)}" alt="${attr(
      alt,
    )}"><figcaption>${text}</figcaption></figure>\n\n`;
  },
};

/**
 * Convert prepared article HTML to the markdown that lands in the vault.
 *
 * Takes the *selected* HTML, not the whole prepared page: Readability may have
 * dropped a sidebar formula, and a flag describing math the article no longer
 * contains would enable single-dollar parsing for nothing — turning the
 * article's prices into formulas on the site.
 */
export function htmlToMarkdown(html: string): MarkdownResult {
  const hasMath = containsMathMarker(html);
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.use(gfm);
  turndown.addRule("tiroInlineLink", inlineLinkRule);
  turndown.addRule("tiroMath", mathTurndownRule);
  turndown.addRule("tiroFigure", figureRule);
  if (hasMath) {
    const base = turndown.escape.bind(turndown);
    turndown.escape = (text: string) => escapeLiteralDollars(base(text));
  }
  return { markdown: turndown.turndown(html), hasMath };
}
