import { describe, expect, test } from "bun:test";
import { Readability } from "@mozilla/readability";
import { splitBlocks } from "@tiro/shared";
import { Window } from "happy-dom";
import {
  foldFiguresIn,
  MATH_ATTR,
  prepareForClipping,
} from "../src/dom-prepare.ts";
import { htmlToMarkdown } from "../src/markdown.ts";

/**
 * A scoped window rather than happy-dom's global registrator: bun runs every
 * test file in one process, and installing `document` globally would leak into
 * suites that deliberately have no DOM.
 */
function docFrom(html: string): Document {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
}

function prepare(html: string) {
  const doc = docFrom(html);
  prepareForClipping(doc);
  return { html: doc.body.innerHTML, doc };
}

/** The markdown the Turndown rule would emit for each recovered formula. */
function formulas(doc: Document): string[] {
  return Array.from(doc.querySelectorAll(`[${MATH_ATTR}]`)).map((node) => {
    const tex = (node.textContent ?? "").trim();
    return node.getAttribute(MATH_ATTR) === "display"
      ? `$$${tex}$$`
      : `$${tex}$`;
  });
}

describe("math recovery", () => {
  test("takes KaTeX's TeX annotation and drops its visual duplicate", () => {
    const { doc, html } = prepare(
      '<p>Given <span class="katex"><span class="katex-mathml">' +
        "<math><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow>" +
        '<annotation encoding="application/x-tex">x^2</annotation>' +
        "</semantics></math></span>" +
        '<span class="katex-html" aria-hidden="true">x2</span></span> holds.</p>',
    );
    expect(htmlToMarkdown(html).hasMath).toBe(true);
    expect(formulas(doc)).toEqual(["$x^2$"]);
    // The rendered half is gone, so the glyphs cannot be emitted twice.
    expect(html).not.toContain("katex-html");
    expect(html).not.toContain("<math");
  });

  test("recognises a KaTeX display wrapper and removes it whole", () => {
    const { doc, html } = prepare(
      '<div class="katex-display"><span class="katex"><span class="katex-mathml">' +
        '<math display="block"><semantics>' +
        '<annotation encoding="application/x-tex">E = mc^2</annotation>' +
        "</semantics></math></span></span></div>",
    );
    expect(formulas(doc)).toEqual(["$$E = mc^2$$"]);
    // An empty wrapper left behind would become a stray markdown block.
    expect(html).not.toContain("katex-display");
  });

  test("reads arXiv's alttext when there is no annotation", () => {
    const { doc } = prepare(
      '<p><math alttext="\\frac{a}{b}" display="block"><mi>a</mi></math></p>',
    );
    expect(formulas(doc)).toEqual(["$$\\frac{a}{b}$$"]);
  });

  test("converts MathJax v2 scripts and deletes the rendered copy", () => {
    const { doc, html } = prepare(
      '<p><span class="MathJax_Preview">x2</span>' +
        '<span class="MathJax" id="MathJax-Element-1-Frame">x²</span>' +
        '<script type="math/tex">x^2</script>' +
        '<script type="math/tex; mode=display">\\sum_{i=1}^{n} i</script></p>',
    );
    expect(formulas(doc)).toEqual(["$x^2$", "$$\\sum_{i=1}^{n} i$$"]);
    expect(html).not.toContain("MathJax_Preview");
    expect(html).not.toContain("math/tex");
  });

  test("drops math whose TeX source the page never shipped", () => {
    // ADR 0003: flattening the glyphs leaves paragraphs ending in a lone `=`,
    // which markdown reads as a setext heading and which cost an arXiv paper
    // its entire translation. Losing one formula is the better trade.
    const { doc, html } = prepare(
      "<p>Before <math><mi>a</mi><mo>=</mo><mi>b</mi></math> after.</p>",
    );
    expect(htmlToMarkdown(html).hasMath).toBe(false);
    expect(formulas(doc)).toEqual([]);
    expect(html).toBe("<p>Before  after.</p>");
  });

  test("keeps inline math on one line", () => {
    // A newline inside `$…$` ends the inline math and leaves stray dollars.
    const { doc } = prepare(
      '<p><span class="katex"><math><semantics>' +
        '<annotation encoding="application/x-tex">a\n  +\n  b</annotation>' +
        "</semantics></math></span></p>",
    );
    expect(formulas(doc)).toEqual(["$a + b$"]);
  });

  test("reports no math for an ordinary page", () => {
    const { html } = prepare("<p>It costs $5 to $10.</p>");
    expect(htmlToMarkdown(html).hasMath).toBe(false);
  });
});

describe("code language recovery", () => {
  function languageOf(html: string): string | null {
    const { doc } = prepare(html);
    const code = doc.querySelector("pre code");
    const classes = (code?.getAttribute("class") ?? "").split(/\s+/);
    return (
      classes.find((name) => name.startsWith("language-"))?.slice(9) ?? null
    );
  }

  test("leaves a language the page already declared", () => {
    expect(
      languageOf('<pre><code class="language-TypeScript">x</code></pre>'),
    ).toBe("TypeScript");
  });

  test("recovers from the conventions highlighters actually use", () => {
    expect(languageOf('<pre><code class="lang-go">x</code></pre>')).toBe("go");
    expect(languageOf('<pre><code data-lang="ruby">x</code></pre>')).toBe(
      "ruby",
    );
    expect(languageOf('<pre data-language="rust"><code>x</code></pre>')).toBe(
      "rust",
    );
    expect(
      languageOf(
        '<div class="highlight highlight-source-js"><pre><code>x</code></pre></div>',
      ),
    ).toBe("js");
    expect(languageOf('<pre class="brush: python;"><code>x</code></pre>')).toBe(
      "python",
    );
    expect(
      languageOf(
        '<pre class="sourceCode c"><code class="sourceCode">x</code></pre>',
      ),
    ).toBe("c");
  });

  test("leaves a fence alone when nothing names a language", () => {
    expect(languageOf('<pre class="chroma"><code>x</code></pre>')).toBe(null);
  });

  test("does not read a natural language off a wrapper", () => {
    // data-lang is also the standard spelling for i18n and tab groups. Reading
    // it from an ancestor writes ```en into the vault permanently and costs
    // every code block on the page its highlighting.
    expect(
      languageOf('<div data-lang="en"><pre><code>hello</code></pre></div>'),
    ).toBe(null);
    expect(
      languageOf(
        '<section data-language="fr"><pre><code>x</code></pre></section>',
      ),
    ).toBe(null);
    // The unambiguous container patterns still work.
    expect(
      languageOf(
        '<div class="highlight highlight-source-js"><pre><code>x</code></pre></div>',
      ),
    ).toBe("js");
  });

  test("skips Pandoc's layout classes when reading a bare language", () => {
    expect(
      languageOf(
        '<pre class="sourceCode numberSource javascript numberLines"><code class="sourceCode">x</code></pre>',
      ),
    ).toBe("javascript");
  });

  test("ignores attribute values that are not language tokens", () => {
    expect(
      languageOf(
        '<pre><code data-lang="a language with spaces">x</code></pre>',
      ),
    ).toBe(null);
  });

  test("removes line-number gutters from the code text", () => {
    const { doc } = prepare(
      '<pre><code><span class="linenos">1\n2</span>const a = 1;</code></pre>',
    );
    expect(doc.querySelector("pre code")?.textContent).toBe("const a = 1;");
  });

  test("removes Chroma's inline line numbers", () => {
    const { doc } = prepare(
      '<pre><code class="language-go"><span class="line">' +
        '<span class="ln">1</span><span class="cl">func main()</span>' +
        "</span></code></pre>",
    );
    expect(doc.querySelector("pre code")?.textContent).toBe("func main()");
  });

  test("unwraps Chroma's line-number table to the code block", () => {
    // Left alone this converts to a markdown table wrapping a code block.
    const { doc, html } = prepare(
      '<div class="highlight"><table class="lntable"><tbody><tr>' +
        '<td class="lntd"><pre class="chroma"><code>1\n2</code></pre></td>' +
        '<td class="lntd"><pre class="chroma"><code class="language-go">a\nb</code></pre></td>' +
        "</tr></tbody></table></div>",
    );
    expect(html).not.toContain("<table");
    expect(doc.querySelector("pre code")?.textContent).toBe("a\nb");
  });

  test("still produces a fence when Chroma's code cell has no code element", () => {
    // Turndown's fenced-code rule requires a <code>; without one the unwrap
    // leaves a paragraph, losing the indentation and the monospace.
    const doc = docFrom(
      '<div class="highlight"><table class="lntable"><tbody><tr>' +
        '<td class="lntd"><pre><code>1</code></pre></td>' +
        '<td class="lntd"><pre class="chroma"><span class="line">func main()</span></pre></td>' +
        "</tr></tbody></table></div>",
    );
    prepareForClipping(doc);
    expect(htmlToMarkdown(doc.body.innerHTML).markdown).toBe(
      "```\nfunc main()\n```",
    );
  });
});

describe("markdown produced end to end", () => {
  /** The same conversion clipper.ts runs, not a re-creation of it. */
  function toMarkdown(html: string): string {
    const doc = docFrom(html);
    prepareForClipping(doc);
    return htmlToMarkdown(doc.body.innerHTML).markdown;
  }

  function katex(tex: string, display = false): string {
    const math =
      `<span class="katex"><span class="katex-mathml"><math><semantics>` +
      `<annotation encoding="application/x-tex">${tex}</annotation>` +
      `</semantics></math></span></span>`;
    return display ? `<div class="katex-display">${math}</div>` : math;
  }

  test("emits LaTeX unescaped", () => {
    // Turndown's text escaping would produce `\\sqrt{d\_k}` here.
    const md = toMarkdown(`<p>Scale by ${katex("\\sqrt{d_k}")}.</p>`);
    expect(md).toBe("Scale by $\\sqrt{d_k}$.");
  });

  test("display math becomes its own top-level block", () => {
    const md = toMarkdown(
      `<p>Before.</p>${katex("E = mc^2", true)}<p>After.</p>`,
    );
    expect(splitBlocks(md).map((b) => b.type)).toEqual([
      "paragraph",
      "math",
      "paragraph",
    ]);
    expect(md).toContain("$$\nE = mc^2\n$$");
  });

  test("display math splits a paragraph it was written inside", () => {
    const md = toMarkdown(`<p>Before ${katex("E = mc^2", true)} after.</p>`);
    expect(splitBlocks(md).map((b) => b.type)).toEqual([
      "paragraph",
      "math",
      "paragraph",
    ]);
  });

  test("a recovered language reaches the fence's info string", () => {
    const md = toMarkdown(
      '<div class="highlight highlight-source-js"><pre><code>const a = 1;</code></pre></div>',
    );
    expect(md).toBe("```js\nconst a = 1;\n```");
  });
});

describe("dollar signs", () => {
  function convert(html: string) {
    const doc = docFrom(html);
    prepareForClipping(doc);
    return htmlToMarkdown(doc.body.innerHTML);
  }

  const katexSpan = (tex: string) =>
    `<span class="katex"><span class="katex-mathml"><math><semantics>` +
    `<annotation encoding="application/x-tex">${tex}</annotation>` +
    `</semantics></math></span></span>`;

  test("escapes literal dollars but not recovered formulas", () => {
    // This asymmetry is what lets has_math promise something enforceable:
    // in a flagged article, every *bare* $…$ is a formula.
    const { markdown, hasMath } = convert(
      `<p>Latency scales as ${katexSpan("O(n^2)")}, and it costs $5 to $10.</p>`,
    );
    expect(hasMath).toBe(true);
    expect(markdown).toBe(
      "Latency scales as $O(n^2)$, and it costs \\$5 to \\$10.",
    );
  });

  test("leaves dollars inside code alone", () => {
    // Turndown takes the isCode path for these, so escaping never reaches
    // them — a shell snippet must not grow backslashes.
    const { markdown } = convert(
      `<p>Use <code>$PATH</code> ${katexSpan("x")}</p>` +
        '<pre><code class="language-sh">echo $HOME</code></pre>',
    );
    expect(markdown).toContain("`$PATH`");
    expect(markdown).toContain("echo $HOME");
    expect(markdown).not.toContain("\\$HOME");
  });

  test("does not escape anything in an article with no math", () => {
    const { markdown, hasMath } = convert("<p>It costs $5 to $10.</p>");
    expect(hasMath).toBe(false);
    expect(markdown).toBe("It costs $5 to $10.");
  });

  test("ignores math Readability dropped with the page furniture", () => {
    // The flag has to describe the article that gets written, not the page
    // that was looked at: a sidebar formula setting it would switch a pricing
    // article to single-dollar parsing for nothing.
    const doc = docFrom(
      `<article><p>It costs $5 to $10.</p></article>` +
        `<aside><p>${katexSpan("x^2")}</p></aside>`,
    );
    prepareForClipping(doc);
    const selected = doc.querySelector("article")?.innerHTML ?? "";
    const { markdown, hasMath } = htmlToMarkdown(selected);
    expect(hasMath).toBe(false);
    expect(markdown).toBe("It costs $5 to $10.");
  });
});

describe("display math in nested contexts", () => {
  const display = (tex: string) =>
    `<div class="katex-display"><span class="katex"><span class="katex-mathml">` +
    `<math display="block"><semantics>` +
    `<annotation encoding="application/x-tex">${tex}</annotation>` +
    `</semantics></math></span></span></div>`;

  function toMarkdown(html: string): string {
    const doc = docFrom(html);
    prepareForClipping(doc);
    return htmlToMarkdown(doc.body.innerHTML).markdown;
  }

  test("stays a block at the top level", () => {
    expect(toMarkdown(`<p>Before.</p>${display("E=mc^2")}<p>After.</p>`)).toBe(
      "Before.\n\n$$\nE=mc^2\n$$\n\nAfter.",
    );
  });

  test("degrades to inline inside a table cell", () => {
    // A block here would have its newlines turned into <br> by the GFM cell
    // rule, and KaTeX would then typeset the literal string "<br>O(n^2)<br>".
    const md = toMarkdown(
      "<table><thead><tr><th>V</th><th>C</th></tr></thead><tbody><tr>" +
        `<td>${display("O(n^2)")}</td><td>slow</td></tr></tbody></table>`,
    );
    expect(md).toContain("| $O(n^2)$ | slow |");
    expect(md).not.toContain("<br>");
  });

  test("degrades to inline inside a list item", () => {
    // The markdown would render fine, but the enclosing block is a `list`,
    // not a `math`, so it is not verbatim and the formula would be sent to
    // the translator. Inline math is protected wherever it appears.
    expect(
      toMarkdown(
        `<ul><li>First ${display("a^2+b^2")}</li><li>Second</li></ul>`,
      ),
    ).toBe("-   First $a^2+b^2$\n-   Second");
  });

  test("does not fragment a heading", () => {
    expect(toMarkdown(`<h2>Energy ${display("E=mc^2")}</h2>`)).toBe(
      "## Energy $E=mc^2$",
    );
  });

  test("keeps both formulas when they share one display wrapper", () => {
    const formula = (tex: string) =>
      `<span class="katex"><span class="katex-mathml"><math><semantics>` +
      `<annotation encoding="application/x-tex">${tex}</annotation>` +
      `</semantics></math></span></span>`;
    const md = toMarkdown(
      `<div class="katex-display">${formula("A")}${formula("B")}</div>`,
    );
    expect(md).toContain("A");
    expect(md).toContain("B");
  });
});

describe("shapes found by clipping real pages", () => {
  function convert(html: string) {
    const doc = docFrom(html);
    prepareForClipping(doc);
    return htmlToMarkdown(doc.body.innerHTML);
  }

  test("unwraps a LaTeXML equation table into display math", () => {
    // arXiv's HTML papers lay every displayed equation out as a table — one
    // cell for the formula, one for its number — and mark the <math> itself
    // `display="inline"`, because the display-ness is in the table. Left
    // alone, all 45 equations in a real paper came out as inline math inside
    // four-column tables of empty cells.
    const { markdown } = convert(
      '<p>Given</p><table class="ltx_equationgroup ltx_eqn_align ltx_eqn_table">' +
        '<tbody><tr class="ltx_equation ltx_eqn_row">' +
        '<td class="ltx_eqn_cell"></td>' +
        '<td class="ltx_eqn_cell"><math display="inline" alttext="E=mc^2"><mi>E</mi></math></td>' +
        '<td class="ltx_eqn_cell ltx_eqn_eqno">(1.1)</td>' +
        "</tr></tbody></table><p>where</p>",
    );
    expect(markdown).toContain("$$\nE=mc^2\n$$");
    expect(markdown).not.toContain("|");
    expect(markdown).not.toContain("(1.1)");
  });

  test("keeps a multi-line link title from swallowing the lines after it", () => {
    // arXiv writes the whole section path into a link's title, and when that
    // path contains a formula the attribute carries the MathML's rendered
    // newlines. The emitted title never closes on its line, so the link never
    // terminates and the swallowed lines arrive as prose — one of them a lone
    // `=`, which markdown reads as a setext heading, turning the paragraph
    // above it into an <h1>. 31 links on one real paper did this.
    const { markdown } = convert(
      '<p>the first case of (<a href="#S4.E1" ' +
        'title="In S1. A new infinite family in\n=\nd\n3\nfor ‣ 4.1 Kakeya">' +
        "1</a>) is a rediscovery.</p>",
    );
    expect(markdown).not.toMatch(/^=$/m);
    expect(markdown.split("\n")).toHaveLength(1);
    expect(splitBlocks(markdown).map((b) => b.type)).toEqual(["paragraph"]);
  });

  test("drops a title that is only whitespace", () => {
    const { markdown } = convert('<p><a href="/x" title="  ">link</a></p>');
    expect(markdown).toBe("[link](/x)");
  });

  test("keeps a link wrapping a block image on one line", () => {
    // Substack wraps every captioned image in <a><div><img></a>. Turndown puts
    // the div's surrounding blank lines inside the brackets, so `[`, the image
    // and `](url)` land on three lines — which markdown cannot read as a link.
    // The brackets then render literally and the URL becomes a bare autolink.
    const { markdown } = convert(
      '<a href="https://cdn.example/full.png">' +
        '<div><img src="./assets/x.jpg" alt="cap"></div></a>',
    );
    expect(markdown).toBe(
      "[![cap](./assets/x.jpg)](https://cdn.example/full.png)",
    );
    expect(splitBlocks(markdown).map((b) => b.type)).toEqual(["paragraph"]);
  });

  test("escapes a link destination the way turndown does", () => {
    const { markdown } = convert(
      '<p><a href="https://ex.com/a(b)c">x</a> ' +
        '<a href="https://ex.com/a b">y</a></p>',
    );
    expect(markdown).toContain("[x](https://ex.com/a\\(b\\)c)");
    expect(markdown).toContain("[y](<https://ex.com/a b>)");
  });

  test("leaves an anchor with an empty href as plain text", () => {
    // Turndown tests the href for truthiness, not existence, so it declines
    // these and the text passes through. Matching that matters: an empty
    // destination becomes `[text]()`, a link to the page already open.
    const { markdown } = convert('<p>a <a href="">text</a> b</p>');
    expect(markdown).toBe("a text b");
  });

  test("drops an anchor with no text rather than emitting an empty link", () => {
    const { markdown } = convert('<p>a<a href="/x"></a>b</p>');
    expect(markdown).toBe("ab");
  });

  test("promotes a headerless table's first row instead of a blank header", () => {
    // GFM cannot write a table without a header, so the plugin synthesizes an
    // empty one whenever the first row is all <td> — a blank leading row, and
    // the row of real headings below it still rendered as data. arXiv never
    // uses <thead>: 51 tables in one paper and 7 in another arrived this way.
    const { markdown } = convert(
      "<table><tbody>" +
        "<tr><td>Paper</td><td>Idea</td></tr>" +
        "<tr><td>Ours</td><td>K-A</td></tr>" +
        "</tbody></table>",
    );
    expect(markdown).not.toMatch(/^\|\s+\|\s+\|$/m);
    expect(markdown.split("\n")[0]).toContain("Paper");
    expect(splitBlocks(markdown).map((b) => b.type)).toEqual(["table"]);
  });

  test("leaves a table that already declares its header", () => {
    const { markdown } = convert(
      "<table><tbody>" +
        "<tr><th>Paper</th><th>Idea</th></tr>" +
        "<tr><td>Ours</td><td>K-A</td></tr>" +
        "</tbody></table>",
    );
    expect(markdown.split("\n")[0]).toContain("Paper");
    expect(markdown).toContain("Ours");
  });

  test("drops a LaTeXML list item's own rendered marker", () => {
    // LaTeXML numbers <ol> items itself and writes the label into the item, so
    // Turndown emits the <ol>'s marker and the label both — `1.  (1)` with the
    // item's text pushed into a paragraph below it. 43 items in one paper read
    // as a numbered list of bare numbers.
    const { markdown } = convert(
      '<ol class="ltx_enumerate">' +
        '<li class="ltx_item"><span class="ltx_tag ltx_tag_item">(1)</span>' +
        '<div class="ltx_para"><p>Residual activation functions.</p></div></li>' +
        "</ol>",
    );
    expect(markdown).not.toContain("(1)");
    expect(markdown).toContain("1.  Residual activation functions.");
    expect(splitBlocks(markdown).map((b) => b.type)).toEqual(["list"]);
  });

  test("fences a <pre> that has no <code> inside", () => {
    // Sphinx and docutils — so Python's own documentation and most of its
    // ecosystem — emit `<pre>` with only spans in it. Turndown's fenced rule
    // needs a <code>, so all 42 blocks on the real page converted to prose
    // with their indentation gone and backslashes escaped through the source.
    const { markdown } = convert(
      '<div class="highlight"><pre><span class="c1"># comment</span>\n' +
        "spam = 1\n          # indented\n</pre></div>",
    );
    expect(markdown).toContain("```");
    expect(markdown).toContain("          # indented");
    expect(markdown).not.toContain("\\#");
  });

  test("drops the LaTeXML class that makes Readability delete a table", () => {
    // `_removeUnlikelyCandidates` matches an element's class against a
    // boilerplate regex containing `header`, and LaTeXML marks a table whose
    // header row it inferred with `ltx_guessed_headers` — so the whole table
    // was deleted before scoring. Three data tables on one clipped paper went
    // this way while their captions survived.
    const { html } = prepare(
      '<table class="ltx_tabular ltx_guessed_headers ltx_align_middle">' +
        "<tr><th>Problem</th></tr><tr><td>Kakeya</td></tr></table>",
    );
    expect(html).not.toContain("ltx_guessed_headers");
    // The classes carrying real meaning are untouched.
    expect(html).toContain("ltx_tabular");
    expect(html).toContain("ltx_align_middle");
  });

  test("leaves ltx_pagination alone, where the regex is right", () => {
    // Those are page-break markers; Readability should drop them.
    const { html } = prepare(
      '<div class="ltx_pagination ltx_role_newpage"></div>',
    );
    expect(html).toContain("ltx_pagination");
  });
});

describe("figure captions (ADR 0011)", () => {
  /** Prepared, then folded — the order clipper.ts runs them in. */
  function clipHtml(html: string): string {
    const { doc, html: prepared } = prepare(html);
    return foldFiguresIn(prepared, doc);
  }

  /** The markdown a prepared figure actually converts to. */
  function markdownFor(html: string): string {
    return htmlToMarkdown(clipHtml(html)).markdown.trim();
  }

  test("folds a caption into its image's paragraph", () => {
    const md = markdownFor(
      '<figure><img src="fig.png" alt="A diagram">' +
        "<figcaption>Figure 2.2: what it shows.</figcaption></figure>",
    );
    // One block: image, hard break, caption. A blank line here would make the
    // caption a separate paragraph again, which is the whole defect.
    expect(md).toBe("![A diagram](fig.png)  \nFigure 2.2: what it shows.");
    expect(splitBlocks(md)).toHaveLength(1);
  });

  test("the folded block is one block and stays one after translation", () => {
    const md = markdownFor(
      '<figure><img src="fig.png" alt="d"><figcaption>A caption.</figcaption>' +
        "</figure>",
    );
    const translated = "![d](fig.png)  \n一段说明。";
    expect(splitBlocks(md)).toHaveLength(1);
    expect(splitBlocks(translated)).toHaveLength(1);
    expect(splitBlocks(md)[0]?.type).toBe(splitBlocks(translated)[0]?.type);
  });

  test("keeps the link wrapping a lightbox image", () => {
    const md = markdownFor(
      '<figure><a href="full.png"><img src="thumb.png" alt="d"></a>' +
        "<figcaption>A caption.</figcaption></figure>",
    );
    expect(md).toBe("[![d](thumb.png)](full.png)  \nA caption.");
  });

  test("keeps inline markup inside the caption", () => {
    const md = markdownFor(
      '<figure><img src="f.png" alt="d"><figcaption>Credit: ' +
        '<a href="https://example.com">M. G.</a> and <em>others</em>.' +
        "</figcaption></figure>",
    );
    expect(md).toBe(
      "![d](f.png)  \nCredit: [M. G.](https://example.com) and _others_.",
    );
  });

  test("unwraps a caption marked up as a single paragraph", () => {
    const md = markdownFor(
      '<figure><img src="f.png" alt="d"><figcaption><p>A caption.</p>' +
        "</figcaption></figure>",
    );
    expect(md).toBe("![d](f.png)  \nA caption.");
  });

  test("leaves a figure with no caption as a plain image", () => {
    const md = markdownFor('<figure><img src="f.png" alt="d"></figure>');
    expect(md).toBe("![d](f.png)");
  });

  test("leaves an empty caption alone", () => {
    const md = markdownFor(
      '<figure><img src="f.png" alt="d"><figcaption>  </figcaption></figure>',
    );
    expect(md).not.toContain("  \n");
  });

  test("leaves a multi-image figure alone — the pairing would be a guess", () => {
    const html = clipHtml(
      '<figure><img src="a.png"><img src="b.png">' +
        "<figcaption>Both of them.</figcaption></figure>",
    );
    expect(html).toContain("<figcaption>");
  });

  test("leaves a caption holding block structure alone", () => {
    // Two paragraphs cannot be folded without a blank line, and a blank line
    // would end the block.
    const html = clipHtml(
      '<figure><img src="f.png"><figcaption><p>One.</p><p>Two.</p>' +
        "</figcaption></figure>",
    );
    expect(html).toContain("<figcaption>");
  });

  test("folds a <picture> inside a figure, which unwrapPictures ran first on", () => {
    const md = markdownFor(
      "<figure><picture><source srcset='big.webp'>" +
        '<img src="f.png" alt="d"></picture>' +
        "<figcaption>A caption.</figcaption></figure>",
    );
    expect(md).toBe("![d](f.png)  \nA caption.");
  });
});

describe("figure captions — what must never be folded", () => {
  /** Prepared, then folded — the order clipper.ts runs them in. */
  function clipHtml(html: string): string {
    const { doc, html: prepared } = prepare(html);
    return foldFiguresIn(prepared, doc);
  }

  function markdownFor(html: string): string {
    return htmlToMarkdown(clipHtml(html)).markdown.trim();
  }
  function katexDisplay(tex: string): string {
    return (
      `<div class="katex-display"><span class="katex"><span class="katex-mathml">` +
      `<math><semantics><annotation encoding="application/x-tex">${tex}</annotation>` +
      `</semantics></math></span></span></div>`
    );
  }

  test("keeps content the figure holds beside its image and caption", () => {
    const md = markdownFor(
      '<figure><img src="f.png" alt="d">' +
        "<figcaption>A caption.</figcaption>" +
        "<p>Essential note.</p></figure>",
    );
    expect(md).toContain("Essential note.");
  });

  test("keeps caption text either side of an inner paragraph", () => {
    const md = markdownFor(
      '<figure><img src="f.png" alt="d">' +
        "<figcaption>Lead<p>Rest</p>Tail</figcaption></figure>",
    );
    expect(md).toContain("Lead");
    expect(md).toContain("Tail");
  });

  test("never promises one block for a caption Turndown would split", () => {
    const md = markdownFor(
      '<figure><img src="f.png" alt="d">' +
        "<figcaption><section>Note</section></figcaption></figure>",
    );
    const imageBlocks = splitBlocks(md).filter((b) => b.text.includes("f.png"));
    // Either folded into one block, or not folded at all — never a promise of
    // one block that Turndown then splits.
    expect(imageBlocks).toHaveLength(1);
    expect(splitBlocks(md).length).toBeLessThanOrEqual(2);
    if (md.includes("  \n")) expect(splitBlocks(md)).toHaveLength(1);
  });

  test("leaves a caption carrying display math alone", () => {
    const md = markdownFor(
      '<figure><img src="f.png" alt="d"><figcaption>Where ' +
        `${katexDisplay("E=mc^2")} holds.</figcaption></figure>`,
    );
    if (md.includes("  \n")) expect(splitBlocks(md)).toHaveLength(1);
  });

  test("folds a caption whose lines are separated by a single break", () => {
    // One break is `  \n`, which keeps the block whole — captions marked up
    // over two lines are common and should still become figures.
    const md = markdownFor(
      '<figure><img src="f.png" alt="d"><figcaption>A<br>B</figcaption></figure>',
    );
    expect(splitBlocks(md)).toHaveLength(1);
    expect(md).toBe("![d](f.png)  \nA  \nB");
  });

  test("leaves a caption with doubled breaks alone", () => {
    // Two breaks in a row are `  \n  \n` — a blank line, and a blank line ends
    // the block this pass promises is one.
    const html = clipHtml(
      '<figure><img src="f.png" alt="d"><figcaption>A<br><br>B</figcaption>' +
        "</figure>",
    );
    expect(html).toContain("<figcaption>");
  });

  test("leaves a caption that opens with a break alone", () => {
    // The separator this inserts is itself a break, so a leading one doubles it.
    const html = clipHtml(
      '<figure><img src="f.png" alt="d"><figcaption><br>A</figcaption></figure>',
    );
    expect(html).toContain("<figcaption>");
  });

  test("a doubled break nested inside inline markup is caught too", () => {
    const html = clipHtml(
      '<figure><img src="f.png" alt="d"><figcaption><em>A<br><br>B</em>' +
        "</figcaption></figure>",
    );
    expect(html).toContain("<figcaption>");
  });

  test("folds Substack's <a><div><img></div></a> wrapper shape", () => {
    // The real page shape inlineLinkRule exists for (see markdown.ts): it
    // flattens to [![](x)](full), which is exactly what the site reads as a
    // picture, so a wrapper element between link and image must not block the
    // fold — only other *content* inside the link may.
    const md = markdownFor(
      '<figure><a href="full.png"><div><img src="f.png" alt="d"></div></a>' +
        "<figcaption>Cap.</figcaption></figure>",
    );
    expect(md).toBe("[![d](f.png)](full.png)  \nCap.");
    expect(splitBlocks(md)).toHaveLength(1);
  });

  test("leaves a link holding a textless sibling alone", () => {
    // <hr> and <svg> carry no text, so a textContent check called this link
    // "nothing but the image" and the unwrap then deleted them.
    const html = clipHtml(
      '<figure><a href="full"><div><img src="x.png" alt="d"></div><hr></a>' +
        "<figcaption>Cap.</figcaption></figure>",
    );
    expect(html).toContain("<figcaption>");
    expect(html).toContain("<hr");
  });

  test("leaves a link holding an svg beside its image alone", () => {
    const html = clipHtml(
      '<figure><a href="full"><img src="x.png" alt="d"><svg></svg></a>' +
        "<figcaption>Cap.</figcaption></figure>",
    );
    expect(html).toContain("<figcaption>");
    expect(html).toContain("<svg");
  });

  test("leaves a link whose wrapper means something alone", () => {
    // <em> and <del> are not layout: dropping them changes the markdown, and
    // for <del> it changes what the page said — the image was struck through.
    for (const tag of ["em", "del", "code", "strong"]) {
      const html = clipHtml(
        `<figure><a href="full"><${tag}><img src="x.png" alt="d"></${tag}></a>` +
          "<figcaption>Cap.</figcaption></figure>",
      );
      expect(html).toContain("<figcaption>");
      expect(html).toContain(`<${tag}`);
    }
  });

  test("a dropped wrapper leaves the picture markdown unchanged", () => {
    // The property that makes a wrapper disposable: removing it produces the
    // markdown the same link would have produced without it.
    const bare = htmlToMarkdown(
      '<a href="full"><img src="x.png" alt="d"></a>',
    ).markdown.trim();
    for (const wrapper of [
      "<div>%</div>",
      "<span>%</span>",
      // What Readability turns a wrapper <div> into, and so the shape the
      // fold actually meets in production.
      "<p>%</p>",
      "<div><span>%</span></div>",
    ]) {
      const inner = wrapper.replace("%", '<img src="x.png" alt="d">');
      const md = markdownFor(
        `<figure><a href="full">${inner}</a>` +
          "<figcaption>Cap.</figcaption></figure>",
      );
      expect(md).toBe(`${bare}  \nCap.`);
      expect(splitBlocks(md)).toHaveLength(1);
    }
  });

  test("leaves a link carrying more than its image alone", () => {
    // `[![](x)Zoom](full)` is not a picture by the site's definition, so the
    // fold would produce a block the renderer declines to make a figure of.
    const html = clipHtml(
      '<figure><a href="full.png"><img src="f.png" alt="d"><span>Zoom</span>' +
        "</a><figcaption>Cap.</figcaption></figure>",
    );
    expect(html).toContain("<figcaption>");
  });

  test("leaves a figure wrapped in a link unfolded", () => {
    const wrapped =
      '<a href="full.png"><figure><img src="f.png" alt="d">' +
      "<figcaption>A caption.</figcaption></figure></a>";
    // Folding here would put the caption inside the link's text, because
    // inlineLinkRule flattens a link's content onto one line — the paragraph
    // would open with a link rather than an image and stop reading as a figure.
    expect(clipHtml(wrapped)).toContain("<figcaption>");

    // That flattening is inlineLinkRule's own behaviour for any link wrapping
    // block content, not something this pass introduces: the identical markdown
    // comes out of the same shape with no <figure> in it at all.
    expect(markdownFor(wrapped)).toBe(
      htmlToMarkdown(
        '<a href="full.png"><img src="f.png" alt="d"><p>A caption.</p></a>',
      ).markdown.trim(),
    );
  });
});

describe("figure folding runs after Readability", () => {
  /** Enough prose either side that Readability keeps the article at all. */
  const filler = `<p>${"Body sentence with enough words to score. ".repeat(20)}</p>`;

  /** The clipper's real order: prepare, extract, then fold. */
  function clip(markup: string): string {
    const window = new Window();
    window.document.body.innerHTML = `<article>${filler}${markup}${filler}</article>`;
    const doc = window.document as unknown as Document;
    prepareForClipping(doc);
    const prepared = doc.body.innerHTML;
    let extracted = "";
    try {
      extracted = new Readability(doc as never).parse()?.content ?? "";
    } catch {
      extracted = "";
    }
    return foldFiguresIn(extracted === "" ? prepared : extracted, doc);
  }

  test("a hidden figure stays out of the clip", () => {
    // Folding before Readability turned <figure hidden> into a plain <p>,
    // stripping the attribute Readability excludes on, and the image the page
    // had hidden was published.
    const html = clip(
      '<figure hidden><img src="hidden.png"><figcaption>Cap.</figcaption>' +
        "</figure>",
    );
    expect(html).not.toContain("hidden.png");
  });

  test("a hidden wrapper inside a figure's link stays out of the clip", () => {
    const html = clip(
      '<figure><a href="full"><div hidden><img src="hidden.png"></div></a>' +
        "<figcaption>Cap.</figcaption></figure>",
    );
    expect(html).not.toContain("hidden.png");
  });

  test("an aria-hidden figure stays out of the clip", () => {
    const html = clip(
      '<figure aria-hidden="true"><img src="hidden.png">' +
        "<figcaption>Cap.</figcaption></figure>",
    );
    expect(html).not.toContain("hidden.png");
  });

  test("a visible figure survives extraction and still folds", () => {
    const html = clip(
      '<figure><img src="shown.png" alt="d"><figcaption>Cap.</figcaption>' +
        "</figure>",
    );
    expect(html).toContain("shown.png");
    expect(html).not.toContain("<figcaption>");
    expect(htmlToMarkdown(html).markdown).toContain("![d](shown.png)  \nCap.");
  });
});

describe("media wrappers Readability would delete", () => {
  /** Enough prose either side that Readability keeps the article at all. */
  const filler = `<p>${"Body sentence with enough words to score. ".repeat(20)}</p>`;

  /** The clipper's real order: prepare, extract, then fold. */
  function clip(markup: string): string {
    const window = new Window();
    window.document.body.innerHTML = `<article>${filler}${markup}${filler}</article>`;
    const doc = window.document as unknown as Document;
    prepareForClipping(doc);
    const prepared = doc.body.innerHTML;
    let extracted = "";
    try {
      extracted = new Readability(doc as never).parse()?.content ?? "";
    } catch {
      extracted = "";
    }
    return foldFiguresIn(extracted === "" ? prepared : extracted, doc);
  }

  /** Prepare and fold, without Readability in the way. */
  function clipFigures(html: string): string {
    const { doc, html: prepared } = prepare(html);
    return foldFiguresIn(prepared, doc);
  }

  /** The shape that lost an article all three of its images. */
  const gallery =
    '<div class="MediaGalleryView-module__media-gallery">' +
    '<figure class="media-item"><div class="media-content">' +
    '<img src="venus.png" alt="Radar image"></div>' +
    "<figcaption>Magellan radar</figcaption></figure></div>";

  test("keeps a gallery whose class name trips the negative regex", () => {
    // _cleanConditionally scores the class before it looks at the content, and
    // Readability's negative regex contains `media`, so weight is -25 and the
    // subtree goes before any image-aware check runs. Asserting after
    // Readability is the point: the image is present either way before it.
    const html = clip(gallery);
    expect(html).toContain("venus.png");
    expect(html).toContain("Magellan radar");
  });

  test("the surviving figure still folds into one block", () => {
    const md = htmlToMarkdown(clip(gallery)).markdown.trim();
    expect(md).toContain("![Radar image](venus.png)  \nMagellan radar");
  });

  test("leaves a wrapper carrying a sentence alone", () => {
    // Text is content, and the class name Readability objected to may well be
    // about the text rather than the picture.
    const { html } = prepare(
      '<figure><div class="media-note"><img src="x.png" alt="d">' +
        "<p>A sentence the page means.</p></div>" +
        "<figcaption>Cap.</figcaption></figure>",
    );
    expect(html).toContain('class="media-note"');
    expect(html).toContain("A sentence the page means.");
  });

  test("leaves a media wrapper with no figure in reach alone", () => {
    // The guard: this pass runs before Readability and removes the attributes
    // Readability selects on, so it may only touch markup the page itself has
    // called a figure. A sidebar thumbnail stays rejectable.
    const { html } = prepare(
      '<div class="media-sidebar"><img src="thumb.png" alt="t"></div>',
    );
    expect(html).toContain('class="media-sidebar"');
  });

  test("counts a link that wraps only its image as media", () => {
    const md = htmlToMarkdown(
      clipFigures(
        '<figure><div class="media-content">' +
          '<a href="full.png"><img src="x.png" alt="d"></a></div>' +
          "<figcaption>Cap.</figcaption></figure>",
      ),
    ).markdown.trim();
    expect(md).toBe("[![d](x.png)](full.png)  \nCap.");
  });

  test("leaves a wrapper whose link carries overlay text alone", () => {
    // Same reading pictureOf takes: text beside the image is content, and
    // unwrapping would strand it.
    const { html } = prepare(
      '<figure><div class="media-content">' +
        '<a href="full.png"><img src="x.png" alt="d"><span>Zoom</span></a>' +
        "</div><figcaption>Cap.</figcaption></figure>",
    );
    expect(html).toContain('class="media-content"');
    expect(html).toContain("Zoom");
  });

  test("leaves a wrapper holding no image alone", () => {
    const { html } = prepare(
      '<figure><div class="media-empty"><span>No picture here.</span></div>' +
        "<figcaption>Cap.</figcaption></figure>",
    );
    expect(html).toContain('class="media-empty"');
  });

  test("unwraps a nested chain without disturbing the figure", () => {
    const { doc } = prepare(
      '<div class="media-wrap"><div class="media-inner">' +
        '<figure><div class="media-content"><img src="x.png" alt="d"></div>' +
        "<figcaption>Cap.</figcaption></figure></div></div>",
    );
    expect(doc.querySelectorAll("div")).toHaveLength(0);
    const figure = doc.querySelector("figure");
    expect(figure?.children).toHaveLength(2);
    expect(figure?.firstElementChild?.nodeName).toBe("IMG");
    expect(figure?.lastElementChild?.nodeName).toBe("FIGCAPTION");
  });

  test("leaves a hidden wrapper alone, however it is hidden", () => {
    // Caught by an existing test, and worth its own: unwrapping drops the very
    // attribute Readability excludes on, so a picture the page hid would be
    // published. This is the ADR 0011 hazard, one pass earlier.
    for (const attr of [
      "hidden",
      'aria-hidden="true"',
      'style="display: none"',
      'style="visibility: hidden"',
    ]) {
      const { html } = prepare(
        `<figure><div class="media-content" ${attr}>` +
          '<img src="hidden.png" alt="d"></div>' +
          "<figcaption>Cap.</figcaption></figure>",
      );
      expect(html).toContain('class="media-content"');
    }
  });

  test("unwrapping a visible wrapper leaves a hidden child hidden", () => {
    const html = clip(
      '<div class="media-gallery"><figure>' +
        '<div hidden><img src="hidden.png"></div>' +
        '<img src="shown.png" alt="d">' +
        "<figcaption>Cap.</figcaption></figure></div>",
    );
    expect(html).not.toContain("hidden.png");
    expect(html).toContain("shown.png");
  });

  test("is idempotent", () => {
    const once = prepare(gallery);
    prepareForClipping(once.doc);
    expect(once.doc.body.innerHTML).toBe(once.html);
  });
});
