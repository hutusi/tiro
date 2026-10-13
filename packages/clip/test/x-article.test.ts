import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { clipPage } from "../src/clip-page.ts";

/**
 * An X Article as Chrome renders it, in the shape measured on three Articles in
 * October 2026 (ADR 0043). The text is invented; the nesting, the `data-*`
 * labels, Draft's class names and the `<div>` around each link are X's. Only
 * a class says that `<div>` is inline, as on X, where a stylesheet decides.
 */
const URL = "https://x.com/someone/article/2073100352921215386";

const HEADLINE = "A Field Guide to Testing: Finding Your Unknowns";

/** Draft's wrapper around a block's line of text. */
const LINE_WRAPPER =
  'class="public-DraftStyleDefault-block public-DraftStyleDefault-ltr" data-offset-key="k"';

function line(text: string): string {
  return `<span data-offset-key="k"><span data-text="true">${text}</span></span>`;
}

function link(href: string, text: string): string {
  return `<div class="r-inline"><a href="${href}" role="link" target="_blank" rel="noopener noreferrer nofollow"><span>${line(text)}</span></a></div>`;
}

function block(tag: string, style: string, ...parts: string[]): string {
  return `<${tag} class="${style}" data-block="true" data-editor="e" data-offset-key="k"><div ${LINE_WRAPPER}>${parts.join("")}</div></${tag}>`;
}

function paragraph(...parts: string[]): string {
  return block("div", "longform-unstyled", ...parts);
}

/** X wraps each heading block in an inline `<div>` of its own. */
function heading(level: "one" | "two", text: string): string {
  const tag = level === "one" ? "h1" : "h2";
  return `<div class="r-inline">${block(tag, `longform-header-${level}`, line(text))}</div>`;
}

function item(...parts: string[]): string {
  return block(
    "li",
    "longform-unordered-list-item public-DraftStyleDefault-unorderedListItem public-DraftStyleDefault-depth0 public-DraftStyleDefault-listLTR",
    ...parts,
  );
}

const PROSE =
  "Working with a strong model keeps teaching me an old lesson, which is that the map is not the territory, and that the work happens in the territory.";

const blocks = [
  paragraph(line(PROSE)),
  paragraph(line(PROSE)),
  paragraph(
    line("I've made some "),
    link(
      "https://example.com/unknowns/",
      "example artifacts for finding unknowns here,",
    ),
    line(
      " but be sure to come back to build the intuition for when to use them.",
    ),
  ),
  heading("two", "Knowing your unknowns"),
  paragraph(line(PROSE)),
  paragraph(
    line("See "),
    link("https://example.com/guide/", "the guide"),
    line("."),
  ),
  `<ul class="public-DraftStyleDefault-ul">${item(
    line("Known knowns: what is in my prompt."),
  )}${item(
    line("References: "),
    link("https://example.com/refs/", "a list of them"),
    line(" for later."),
  )}</ul>`,
  block(
    "blockquote",
    "longform-blockquote",
    line("A quoted line, kept as a quote."),
  ),
  heading("one", "Post implementation"),
  paragraph(line(PROSE)),
  paragraph(line(PROSE)),
];

function articlePage(titles: string[] = [title(HEADLINE)]): string {
  return `
<header role="banner"><nav><a href="/home">Home</a><a href="/explore">Explore</a><a href="/notifications">Notifications</a></nav></header>
<main role="main"><div data-testid="primaryColumn">
  <div><h2 role="heading">Article</h2></div>
  <div data-testid="twitterArticleReadView">
    <div><div>${titles.join("")}</div></div>
    <div data-testid="twitterArticleRichTextView"><div><div class="DraftEditor-root"><div class="DraftEditor-editorContainer"><div class="public-DraftEditor-content" contenteditable="false" data-testid="longformRichTextComponent"><div data-contents="true">${blocks.join("")}</div></div></div></div></div></div>
  </div>
  <div role="group"><span>469</span><span>4.1K</span><span>21K</span></div>
</div></main>`;
}

function title(text: string, attributes = ""): string {
  return `<div data-testid="twitter-article-title"${attributes}><span>${text}</span></div>`;
}

function clipped(body: string, tabTitle = "(5) X") {
  const window = new Window({ url: URL });
  window.document.head.innerHTML = `<title>${tabTitle}</title><style>.r-inline { display: inline }</style>`;
  window.document.body.innerHTML = body;
  const payload = clipPage(window.document as unknown as Document, URL);
  expect(payload.readabilityFailed).toBe(false);
  return payload;
}

describe("an X Article is titled with the headline X labels", () => {
  test("not the tab's title", () => {
    expect(clipped(articlePage([title(HEADLINE)])).title).toBe(HEADLINE);
  });

  test("on a /status/ URL too, where the tab names the author", () => {
    const tab = `Someone on X: "${HEADLINE}" / X`;
    expect(clipped(articlePage([title(HEADLINE)]), tab).title).toBe(HEADLINE);
  });

  test("and the body does not open by repeating it", () => {
    const { markdown } = clipped(articlePage([title(HEADLINE)]));
    expect(markdown).not.toContain(HEADLINE);
    expect(markdown.startsWith("Working with a strong model")).toBe(true);
  });

  // A page listing several Articles has no one headline, so none is taken.
  test("only when the page shows exactly one", () => {
    const page = articlePage([title(HEADLINE), title("Another Article")]);
    expect(clipped(page).title).toBe("(5) X");
  });

  // A post quoting an Article, previewed in a card: the card's title names the
  // quoted Article, not the post.
  test("not from a card outside the view showing the Article", () => {
    const card = `<main role="main"><article><div>${PROSE} ${PROSE}</div><div data-testid="card.wrapper">${title(HEADLINE)}</div></article></main>`;
    expect(clipped(card, 'Someone on X: "Read this" / X').title).not.toBe(
      HEADLINE,
    );
  });

  test("passing over a copy the page hides", () => {
    const page = articlePage([
      title("A Hidden Copy", ' aria-hidden="true"'),
      title(HEADLINE),
    ]);
    expect(clipped(page).title).toBe(HEADLINE);
  });
});
