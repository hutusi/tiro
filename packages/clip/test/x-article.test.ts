import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { clipPage } from "../src/clip-page.ts";
import { prepareForClipping } from "../src/dom-prepare.ts";

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

function articlePage(
  titles: string[] = [title(HEADLINE)],
  text: string[] = blocks,
): string {
  return `
<header role="banner"><nav><a href="/home">Home</a><a href="/explore">Explore</a><a href="/notifications">Notifications</a></nav></header>
<main role="main"><div data-testid="primaryColumn">
  <div><h2 role="heading">Article</h2></div>
  <div data-testid="twitterArticleReadView">
    <div><div>${titles.join("")}</div></div>
    <div data-testid="twitterArticleRichTextView"><div><div class="DraftEditor-root"><div class="DraftEditor-editorContainer"><div class="public-DraftEditor-content" contenteditable="false" data-testid="longformRichTextComponent"><div data-contents="true">${text.join("")}</div></div></div></div></div></div>
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

describe("an X Article's text keeps its links", () => {
  const { markdown } = clipped(articlePage());

  test("a link stays in its sentence", () => {
    expect(markdown).toContain(
      "I've made some [example artifacts for finding unknowns here,](https://example.com/unknowns/) but be sure to come back to build the intuition for when to use them.",
    );
  });

  // Mostly link: a paragraph Readability builds from a <div> is deleted whole
  // past a fifth of link text, and this one is well past it.
  test("a short paragraph that is mostly link survives", () => {
    expect(markdown).toContain("See [the guide](https://example.com/guide/).");
  });

  test("a list item keeps its link", () => {
    expect(markdown).toContain(
      "References: [a list of them](https://example.com/refs/) for later.",
    );
  });

  // Draft's `longform-header-two` reads as page furniture to Readability,
  // which took every heading out of the vault's X clips. An <h1> comes out as
  // `##` because Readability demotes it, as it does on every page.
  test("headings, list items and quotes keep what they are", () => {
    expect(markdown).toMatch(/^## Knowing your unknowns$/m);
    expect(markdown).toMatch(/^## Post implementation$/m);
    expect(markdown).toMatch(/^-\s+Known knowns: what is in my prompt\.$/m);
    expect(markdown).toMatch(/^> A quoted line, kept as a quote\.$/m);
  });
});

describe("a block the page hides stays hidden", () => {
  // On a detached copy a class is often all that says hidden. Each case here
  // is one the clip left out before the X pass existed, and must still.
  // (A part hidden only by a class is not among them: Readability publishes
  // it on any page, once its <div> has become a paragraph.)
  const hidden = [
    block("h2", "longform-header-two hidden", line("A hidden heading")),
    block(
      "div",
      "longform-unstyled hidden",
      line("A hidden paragraph, which a reader of the page never sees at all."),
    ),
    paragraph(
      line("Visible words "),
      `<div style="display: none">${line("and hidden ones")}</div>`,
      line(" in one paragraph."),
    ),
    `<div class="hidden">${block("h2", "longform-header-two", line("A heading in a hidden wrapper"))}</div>`,
  ];
  const { markdown } = clipped(
    articlePage(
      [title(HEADLINE)],
      [...blocks.slice(0, 3), ...hidden, ...blocks.slice(3)],
    ),
  );

  test("a heading hidden by its class", () => {
    expect(markdown).not.toContain("A hidden heading");
  });

  test("a paragraph hidden by its class", () => {
    expect(markdown).not.toContain("A hidden paragraph");
  });

  test("a part of a block the page hides", () => {
    expect(markdown).toContain("Visible words");
    expect(markdown).not.toContain("and hidden ones");
  });

  test("a block inside a hidden wrapper", () => {
    expect(markdown).not.toContain("A heading in a hidden wrapper");
  });

  test("the visible blocks around them are still read", () => {
    expect(markdown).toMatch(/^## Knowing your unknowns$/m);
    expect(markdown).toContain("See [the guide](https://example.com/guide/).");
  });
});

describe("only an X Article's text blocks are re-tagged", () => {
  function prepared(body: string): Document {
    const window = new Window({ url: URL });
    window.document.body.innerHTML = body;
    const doc = window.document as unknown as Document;
    prepareForClipping(doc);
    return doc;
  }

  const inArticle = (html: string) =>
    `<div data-testid="twitterArticleRichTextView">${html}</div>`;

  test("a block is a paragraph, and its wrappers are spans", () => {
    const doc = prepared(inArticle(paragraph(line("a "), link("/b", "b"))));
    const block = doc.querySelector("[data-block]");
    expect(block?.tagName).toBe("P");
    expect(block?.querySelector("div")).toBeNull();
    expect(block?.querySelector("span.r-inline > a")?.textContent).toBe("b");
    expect(block?.textContent).toBe("a b");
  });

  test("a block keeps its tag otherwise, and loses Draft's style name", () => {
    const doc = prepared(inArticle(heading("two", "Heading")));
    const block = doc.querySelector("[data-block]");
    expect(block?.tagName).toBe("H2");
    expect(block?.hasAttribute("class")).toBe(false);
  });

  test("keeps every class that is not a Draft style name", () => {
    const doc = prepared(
      inArticle(
        block("h2", "longform-header-two r-1qd0xha extra", line("Heading")),
      ),
    );
    expect(doc.querySelector("[data-block]")?.getAttribute("class")).toBe(
      "r-1qd0xha extra",
    );
  });

  test("leaves Draft blocks outside an Article's text", () => {
    const body = paragraph(line("a"));
    expect(prepared(body).body.innerHTML).toBe(body);
  });

  // A media block, and a text block holding something no line of text holds.
  test("leaves a block that holds more than a line of text", () => {
    const media = `<section data-block="true"><div><a href="/m"><div>image</div></a></div></section>`;
    const odd = `<div class="longform-unstyled" data-block="true"><div><ol><li>a list</li></ol></div></div>`;
    const body = inArticle(media + odd);
    expect(prepared(body).body.innerHTML).toBe(body);
  });
});
