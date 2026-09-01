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
  turndown.addRule("tiroMath", mathTurndownRule);
  if (hasMath) {
    const base = turndown.escape.bind(turndown);
    turndown.escape = (text: string) => escapeLiteralDollars(base(text));
  }
  return { markdown: turndown.turndown(html), hasMath };
}
