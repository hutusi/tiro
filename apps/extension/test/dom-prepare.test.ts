import { describe, expect, test } from "bun:test";
import { Readability } from "@mozilla/readability";
import { splitBlocks } from "@tiro/shared";
import { Window } from "happy-dom";
import { clipPage } from "../src/clip-page.ts";
import {
  CODE_LANG_ATTR,
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

  test("reads the selected tab when a page renders one panel at a time", () => {
    // The shape platform.claude.com ships: seven tabs, one rendered panel, and
    // <pre class="shiki shiki-themes …"> carrying no language at all.
    expect(
      languageOf(
        '<div><div><div role="tablist" aria-label="Code block tabs">' +
          '<button role="tab" aria-selected="true">Python</button>' +
          '<button role="tab" aria-selected="false">TypeScript</button>' +
          '<button role="tab" aria-selected="false">Go</button>' +
          "</div></div>" +
          '<div role="tabpanel"><pre class="shiki shiki-themes github-light dark-plus">' +
          "<code>import anthropic</code></pre></div></div>",
      ),
    ).toBe("python");
  });

  test("reads data-active when no tab claims aria-selected", () => {
    expect(
      languageOf(
        '<div><div role="tablist">' +
          '<button role="tab">Java</button>' +
          '<button role="tab" data-active="">Rust</button>' +
          "</div>" +
          '<div role="tabpanel"><pre><code>x</code></pre></div></div>',
      ),
    ).toBe("rust");
  });

  test("matches a panel to its own tab when every panel is rendered", () => {
    // Taking the *selected* tab here would label all three blocks Python.
    const group =
      '<div><div role="tablist">' +
      '<button role="tab" aria-selected="true">Python</button>' +
      '<button role="tab" aria-selected="false">Ruby</button>' +
      "</div>" +
      '<div role="tabpanel"><pre><code>a</code></pre></div>' +
      '<div role="tabpanel"><pre id="second"><code>b</code></pre></div></div>';
    const { doc } = prepare(group);
    const second = doc.querySelector("#second code");
    expect(second?.getAttribute("class")).toBe("language-ruby");
  });

  test("matches a panel to its tab through aria-labelledby", () => {
    const { doc } = prepare(
      '<div><div role="tablist">' +
        '<button role="tab" id="t-go" aria-selected="false">Go</button>' +
        '<button role="tab" id="t-sql" aria-selected="true">SQL</button>' +
        "</div>" +
        '<div role="tabpanel" aria-labelledby="t-go">' +
        "<pre><code>x</code></pre></div></div>",
    );
    expect(doc.querySelector("pre code")?.getAttribute("class")).toBe(
      "language-go",
    );
  });

  /**
   * The reason the tab reading goes through an allowlist. Every one of these
   * sits exactly where a language name sits, and any of them written into a
   * fence is a wrong language in the vault for good.
   */
  test("refuses tab text that is not a language", () => {
    for (const label of ["Copy", "Output", "Response", "Terminal"]) {
      expect(
        languageOf(
          '<div><div role="tablist">' +
            `<button role="tab" aria-selected="true">${label}</button>` +
            "</div>" +
            '<div role="tabpanel"><pre><code>x</code></pre></div></div>',
        ),
      ).toBe(null);
    }
  });

  test("does not read a tab strip that belongs to something else", () => {
    // Prose beside the code means this wrapper is not the block's own chrome.
    expect(
      languageOf(
        '<div><div role="tablist">' +
          '<button role="tab" aria-selected="true">Python</button></div>' +
          "<p>Some prose that is not part of any code block.</p>" +
          "<pre><code>x</code></pre></div>",
      ),
    ).toBe(null);
  });

  test("reads a filename from the block's title chrome", () => {
    expect(
      languageOf(
        '<div><div class="code-block-title">src/main.rs</div>' +
          "<pre><code>x</code></pre></div>",
      ),
    ).toBe("rust");
    expect(
      languageOf(
        "<figure><figcaption>Dockerfile</figcaption>" +
          "<pre><code>x</code></pre></figure>",
      ),
    ).toBe("docker");
  });

  test("reads a title attribute off the block itself", () => {
    expect(
      languageOf(
        '<pre data-rehype-pretty-code-title="app.ts"><code>x</code></pre>',
      ),
    ).toBe("typescript");
  });

  test("does not read a one-word code block as its own title", () => {
    // The <pre> contributes attributes only; its text is the code.
    expect(languageOf("<pre><code>python</code></pre>")).toBe(null);
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

  test("leaves a region Readability rejects as furniture alone", () => {
    // The class this pass works around only contributes a *score*
    // (`_getClassWeight`). These are read by `_removeUnlikelyCandidates`, which
    // deletes outright and before scoring — a different judgement, and one that
    // must survive. Unwrapping discards the attribute it is read from, so a
    // sidebar holding a lone figure would publish its picture as the article's.
    for (const attr of [
      'class="sidebar"',
      'class="related"',
      'class="social share"',
      'id="footer"',
      'role="complementary"',
      'role="navigation"',
    ]) {
      const html = clip(
        `<div ${attr}><figure><img src="furniture.png" alt="f">` +
          "<figcaption>Cap.</figcaption></figure></div>",
      );
      expect(html).not.toContain("furniture.png");
    }
  });

  test("keeps a byline as metadata instead of publishing it as content", () => {
    // `_isValidByline` runs before the furniture checks and reads `rel`,
    // `itemprop` and the class. Unwrapping discarded all three, so the article
    // lost its byline *and* gained a portrait it was never meant to show.
    const filler2 = filler;
    for (const attr of [
      'class="byline"',
      'class="author"',
      'rel="author"',
      'itemprop="author"',
    ]) {
      const window = new Window();
      window.document.body.innerHTML =
        `<article>${filler2}<div ${attr}><figure>` +
        '<img src="portrait.png"><figcaption>Jane Doe</figcaption>' +
        `</figure></div>${filler2}</article>`;
      const doc = window.document as unknown as Document;
      prepareForClipping(doc);
      const article = new Readability(doc as never).parse();
      expect(article?.byline).toBe("Jane Doe");
      expect(article?.content).not.toContain("portrait.png");
      expect(article?.content).not.toContain("Jane Doe");
    }
  });

  test("refuses any wrapper carrying more than layout", () => {
    // An allow-list, so an attribute nobody has considered leaves the wrapper
    // in place rather than being discarded with whatever it meant.
    const carriers: [string, string][] = [
      ["id", 'id="fig"'],
      ["role", 'role="note"'],
      ["lang", 'lang="fr"'],
      ["rel", 'rel="license"'],
    ];
    for (const [name, attr] of carriers) {
      const { html } = prepare(
        `<figure><div ${attr}><img src="x.png" alt="d"></div>` +
          "<figcaption>Cap.</figcaption></figure>",
      );
      expect(html).toContain(name);
    }
  });

  test("unwraps a wrapper carrying only layout attributes", () => {
    // class, style and data-* are the only things real wrappers carry.
    const { doc } = prepare(
      '<figure><div class="media" data-testid="fig" style="margin:0">' +
        '<img src="x.png" alt="d"></div><figcaption>Cap.</figcaption></figure>',
    );
    expect(doc.querySelectorAll("div")).toHaveLength(0);
  });

  test("leaves every negative-weight class but the diagnosed one alone", () => {
    // `_getClassWeight` docks 25 for all of these and `_cleanConditionally`
    // deletes on a negative total — the same mechanism that loses a gallery, so
    // for every token except `media` it is doing its job. `hidden` matters
    // most: it is how Tailwind spells `display: none`, and Readability catches
    // it only here, so discarding the class publishes unrendered content.
    for (const name of [
      "hidden",
      "promo",
      "widget",
      "contact",
      "share",
      "tags",
      "masthead",
      "shopping",
    ]) {
      const html = clip(
        `<div class="${name}"><figure><img src="furniture.png" alt="f">` +
          "<figcaption>Cap.</figcaption></figure></div>",
      );
      expect(html).not.toContain("furniture.png");
    }
  });

  test("still rescues the one collision the pass exists for", () => {
    // `media` is the single token treated as a false positive.
    expect(clip(gallery)).toContain("venus.png");
  });

  test("is idempotent", () => {
    const once = prepare(gallery);
    prepareForClipping(once.doc);
    expect(once.doc.body.innerHTML).toBe(once.html);
  });
});

describe("chart svgs", () => {
  function markdownForPrepared(html: string): string {
    const { doc, html: prepared } = prepare(html);
    return htmlToMarkdown(foldFiguresIn(prepared, doc)).markdown.trim();
  }

  test("drops an svg that paints text", () => {
    // Turndown has no rule for <svg>, so it emits every text node in document
    // order with no separators — a chart arrives as one run of glyphs.
    const md = markdownForPrepared(
      "<p>Before.</p><figure><svg><text>0</text><text>1</text>" +
        "<text>2</text><text>3</text><text>Original implementation</text>" +
        "<text>Speedup on an NVIDIA H100</text></svg>" +
        "<figcaption>Inference speedup.</figcaption></figure><p>After.</p>",
    );
    expect(md).not.toContain("Speedup on an NVIDIA H100");
    expect(md).toContain("Inference speedup.");
  });

  test("keeps an icon carrying only a title", () => {
    // <title>/<desc> are accessibility labels, not painted glyphs, and a link
    // around an icon would otherwise convert to `[](…)`.
    const md = markdownForPrepared(
      '<p><a href="/share"><svg><title>Share</title></svg></a></p>',
    );
    expect(md).toBe("[Share](/share)");
    expect(md).not.toContain("[](");
  });

  test("keeps a link whose label is painted text", () => {
    // An <a>'s SVG text is the link's only label; deleting it leaves `[](…)`.
    const md = markdownForPrepared(
      '<p><a href="/d"><svg><text>Download PDF</text></svg></a></p>',
    );
    expect(md).toBe("[Download PDF](/d)");
  });

  test("keeps a lone painted label", () => {
    // One label is not soup — it converts to a sensible word, so leaving it
    // alone is the same output as before this pass existed.
    const md = markdownForPrepared(
      "<p>Before <svg><text>Status: ok</text></svg> after</p>",
    );
    expect(md).toBe("Before Status: ok after");
  });

  test("drops only once there are a chart's worth of labels", () => {
    const label = (n: number) => `<text>L${n}</text>`;
    const three = markdownForPrepared(
      `<p>A <svg>${[1, 2, 3].map(label).join("")}</svg> B</p>`,
    );
    expect(three).toContain("L1L2L3");
    const many = markdownForPrepared(
      `<p>A <svg>${[1, 2, 3, 4, 5].map(label).join("")}</svg> B</p>`,
    );
    expect(many).toBe("A B");
  });

  test("runs after math recovery, so a MathJax formula survives", () => {
    const { doc } = prepare(
      '<p>Given <span class="MathJax_SVG"><svg><text>x2</text></svg></span>' +
        '<script type="math/tex">x^2</script> holds.</p>',
    );
    expect(formulas(doc)).toEqual(["$x^2$"]);
  });
});

describe("code wrappers Readability would delete", () => {
  /** Enough prose either side that Readability keeps the article at all. */
  const filler = `<p>${"Body sentence with enough words to score. ".repeat(20)}</p>`;

  /** The clipper's real order: prepare, then extract. */
  function clip(markup: string): string {
    const window = new Window();
    window.document.body.innerHTML = `<article>${filler}${markup}${filler}</article>`;
    const doc = window.document as unknown as Document;
    prepareForClipping(doc);
    const extracted = new Readability(doc as never).parse()?.content ?? "";
    // Never fall back to the raw body the way the clipper does. A case that
    // accidentally starved Readability would exercise the path where this whole
    // defect is invisible, and pass for the wrong reason.
    if (extracted === "") throw new Error("Readability extracted nothing");
    return extracted;
  }

  /** The copy control these wrappers carry, live region and all. */
  const controls =
    '<div class="absolute top-3 right-3">' +
    '<button type="button" aria-label="Copy code"><span></span></button>' +
    '<span role="status" class="sr-only"></span></div>';

  /** Shape A: the plain block. `overflow-hidden` is what costs it its life. */
  const plain =
    '<div data-not-prose="true" class="overflow-hidden rounded-card border ' +
    'bg-surface-2 group relative">' +
    '<div class="code-block-scroll relative py-4 pl-4 text-code">' +
    '<pre class="block w-full pr-4"><code>const answer = 42;\nconsole.log(answer);</code></pre>' +
    `</div>${controls}</div>`;

  /** Shape B: highlighter output, one level deeper and with no `<code>`. */
  const highlighted =
    '<div data-not-prose="true" class="overflow-hidden rounded-card border ' +
    'bg-surface-2 group relative">' +
    '<div class="code-block-scroll relative py-4 pl-4 text-code">' +
    '<div class="block w-full pr-4"><pre class="shiki shiki-themes">' +
    '<span class="line"><span>const shiki = true;</span></span></pre></div>' +
    `</div>${controls}</div>`;

  /** Shape C: a tabbed sample — the one a layout-only allow-list refuses. */
  const tabbed =
    '<div data-cds="Tabs" data-not-prose="true" class="overflow-hidden ' +
    'rounded-card border bg-surface-2">' +
    '<div id="panel-py" role="tabpanel" tabindex="-1" ' +
    'aria-labelledby="tab-py" class="cds-reset ' +
    'outline-none focus-visible:outline-hidden">' +
    '<div class="h-full py-4 pl-4 text-code overflow-x-auto" tabindex="0">' +
    '<div class="inline-block min-w-full pr-4">' +
    '<pre class="shiki shiki-themes"><span class="line">import anthropic' +
    "</span></pre></div></div></div></div>";

  test("keeps a block whose wrapper class trips the negative regex", () => {
    // `overflow-hidden` contains `hidden`, and _getClassWeight's regex is a
    // substring test, so weight is -25 and _cleanConditionally deletes the
    // subtree at `weight + contentScore < 0` — with contentScore hardcoded to
    // 0 — before anything looks at what the wrapper holds.
    expect(clip(plain)).toContain("console.log(answer);");
  });

  test("keeps a highlighter's block, nested one level deeper", () => {
    expect(clip(highlighted)).toContain("const shiki = true;");
  });

  test("keeps a tabbed block, whose panel is labelled and focusable", () => {
    // `aria-labelledby` is the attribute this fixture was missing, and the gap
    // was invisible to every offline test: the served HTML carries no `aria-*`
    // on that panel, React adds it on hydration, so only a clip taken in a real
    // browser could show the block being lost. It was — 14 of 15 blocks landed
    // in the vault while the sweep and this suite both reported 15.
    //
    // The divergence from carriesMoreThanLayout in one test: this panel carries
    // `id`, `role` and `tabindex`, a layout-only allow-list refuses it, and its
    // own `outline-hidden` class then deletes the sample.
    expect(clip(tabbed)).toContain("import anthropic");
  });

  test("keeps a block too short to be mistaken for furniture", () => {
    // A one-line install command is the shortest real code block there is, and
    // `_cleanConditionally` has a `contentLength < 25` clause. It does not fire
    // here — it also requires `linkDensity > 0` and code has no links — so this
    // pins the outcome rather than that mechanism. An earlier comment claimed
    // the clause as the reason unwrapping beats declassifying; it is not.
    expect(
      clip('<div class="overflow-hidden"><pre><code>npm i</code></pre></div>'),
    ).toContain("npm i");
  });

  test("the recovered block is a verbatim code block", () => {
    // ADR 0003: a block that stops being `code` leaves VERBATIM_BLOCK_TYPES and
    // is sent to the translator. Recovering it has to recover it *as* code.
    const md = htmlToMarkdown(clip(plain)).markdown;
    const block = splitBlocks(md).find((b) => b.type === "code");
    expect(block?.text).toContain("console.log(answer);");
  });

  test("leaves a hidden block hidden", () => {
    // Unwrapping discards the attributes Readability excludes on, so a wrapper
    // the page hid must never become one it did not. ADR 0011 records this as
    // the failure this file guards against.
    const markup =
      '<div hidden class="overflow-hidden"><pre><code>secret()</code></pre>' +
      "</div>";
    // The wrapper still carries the attribute Readability excludes on...
    expect(prepare(markup).html).toContain('hidden=""');
    // ...so the block Readability would have dropped is still dropped.
    expect(clip(markup)).not.toContain("secret()");
  });

  test("leaves a block hidden by an inline style hidden", () => {
    // `style` is admitted as layout, so the display:none it can carry has to be
    // read rather than assumed absent.
    const { html } = prepare(
      '<div style="display: none" class="overflow-hidden"><pre><code>' +
        "secret()</code></pre></div>",
    );
    expect(html).toContain("display: none");
  });

  test("leaves a sidebar's code block rejectable", () => {
    // Only the negative *weight* regex is declined. Readability's genuine
    // rejection pass, _removeUnlikelyCandidates, still stands — so furniture
    // holding nothing but a snippet stays furniture.
    const { html } = prepare(
      '<div class="sidebar"><pre><code>side()</code></pre></div>',
    );
    expect(html).toContain('class="sidebar"');
  });

  test("leaves a byline wrapper alone", () => {
    const { html } = prepare(
      '<div class="p-author"><pre><code>whoami</code></pre></div>',
    );
    expect(html).toContain('class="p-author"');
  });

  test.each([
    ['aria-hidden="true"', "hidden from assistive tech and from Readability"],
    ['aria-modal="true" role="dialog"', "a dialog, not the article"],
    ['rel="author"', "a byline"],
    ['itemprop="author"', "the microdata spelling of one"],
  ])("a wrapper carrying %s keeps its own verdict", (attrs) => {
    // Nothing here is enumerated any more. The element is left in place with
    // every attribute it arrived with, so Readability reaches these verdicts
    // itself — which is the whole point of clearing tokens instead of
    // unwrapping. The earlier design had to mirror each of these rules, and
    // missed `aria-labelledby` in a way no offline test could see.
    expect(
      clip(
        `<div ${attrs} class="overflow-hidden"><pre><code>run()</code></pre></div>`,
      ),
    ).not.toContain("run()");
  });

  test("a hydrated tab panel keeps its code", () => {
    // The shape that broke the unwrap design: React adds `aria-labelledby` on
    // hydration, the attribute allow-list refused it, and the panel was then
    // deleted for its own `outline-hidden`. Nothing reads attributes now.
    expect(
      clip(
        '<div id="p" role="tabpanel" tabindex="-1" aria-labelledby="t" ' +
          'class="cds-reset focus-visible:outline-hidden data-[ending-style]:hidden">' +
          '<div class="inline-block"><pre><code>import anthropic</code></pre>' +
          "</div></div>",
      ),
    ).toContain("import anthropic");
  });

  test("leaves a dialog alone", () => {
    // UNLIKELY_ROLES is not a heuristic to second-guess: a code sample inside a
    // dialog is not the article's.
    const { html } = prepare(
      '<div role="dialog" class="overflow-hidden"><pre><code>modal()' +
        "</code></pre></div>",
    );
    expect(html).toContain('role="dialog"');
  });

  test("leaves a wrapper carrying an attribute that could mean something", () => {
    const { html } = prepare(
      '<div rel="author" class="overflow-hidden"><pre><code>who()' +
        "</code></pre></div>",
    );
    expect(html).toContain('rel="author"');
  });

  test("leaves a wrapper carrying a sentence alone", () => {
    // Text beside the code is content, and the class Readability objected to
    // may well be about the sentence rather than the sample.
    const { html } = prepare(
      '<div class="overflow-hidden"><p>What this shows.</p>' +
        "<pre><code>run()</code></pre></div>",
    );
    expect(html).toContain('class="overflow-hidden"');
    expect(html).toContain("What this shows.");
  });

  test("leaves a wrapper holding two blocks alone", () => {
    // A side-by-side comparison is a shape, and this pass has no reading of it.
    const { html } = prepare(
      '<div class="overflow-hidden"><pre><code>before()</code></pre>' +
        "<pre><code>after()</code></pre></div>",
    );
    expect(html).toContain('class="overflow-hidden"');
  });

  test.each([
    ['class="hidden"', "Tailwind's display:none"],
    ['class="is-hidden"', "Bulma"],
    ['class="d-none"', "Bootstrap"],
    ['class="sr-only"', "the screen-reader convention"],
    ['class="u-hidden"', "a compound nobody enumerated"],
    ['class="js-hidden"', "another"],
    ['class="hidden-sm"', "and another"],
    ['class="always-hidden"', "and another"],
    ['class="md:hidden"', "a breakpoint this cannot evaluate"],
    ['class="dark:hidden"', "a theme this cannot evaluate"],
    ['class="group-hover:hidden"', "a pointer state this cannot evaluate"],
    ['class="md:data-[x]:hidden"', "two conditions, one unanswerable"],
    [
      'class="data-[state=inactive]:hidden" data-state="inactive"',
      "a panel that really is inactive",
    ],
    [
      'class="data-[state=\'inactive\']:hidden" data-state="inactive"',
      "the same, written with quotes as HTML forces",
    ],
    [
      'class="data-[state=&quot;inactive&quot;]:hidden" data-state="inactive"',
      "and with the double quotes entity-escaped",
    ],
    [
      'class="data-[state~=inactive]:hidden" data-state="inactive"',
      "a selector operator this does not model",
    ],
  ])("leaves %s for Readability to judge", (attrs) => {
    // The assertion is about *this* pass, not about the verdict: the class
    // token survives, so whatever Readability makes of it still stands — which
    // for `d-none` and `sr-only` is nothing, its regex having never known
    // those. Clearing the token is what would take even that verdict away.
    const { html } = prepare(
      `<div ${attrs}><pre><code>secret()</code></pre></div>`,
    );
    const token = attrs.match(/class="([^"]+)"/)?.[1] ?? attrs;
    expect(html).toContain(token);
  });

  test("a block hidden with a bare class stays out of the clip", () => {
    // End to end for the token Readability does catch, so the guard is pinned
    // by consequence and not only by structure. `hidden` is how Tailwind spells
    // `display: none`, and it is caught in the negative-weight regex alone —
    // the regex this pass declines — so nothing else would stop it.
    expect(
      clip('<div class="hidden"><pre><code>secret()</code></pre></div>'),
    ).not.toContain("secret()");
  });

  test.each([
    ['class="overflow-hidden"', "the collision this pass exists for"],
    ['class="focus-visible:outline-hidden"', "a variant of the same"],
    ['class="code-block-scroll"', "the other colliding token"],
    ['class="overflow-x-hidden"', "the axis variants of the same"],
    ['class="not-sr-only"', "contains a hiding word, does the opposite"],
    ['class="backface-hidden"', "contains one, hides nothing"],
    ['class="data-[ending-style]:hidden"', "an animation that is not running"],
    [
      'class="data-[state=inactive]:hidden" data-state="active"',
      "the panel that is showing",
    ],
    [
      'class="data-[state=\'inactive\']:hidden" data-state="active"',
      "quotes normalized, condition still false",
    ],
    ['class="data-[disabled]:hidden"', "a flag the element does not carry"],
  ])("still recovers the block behind %s", (attrs) => {
    // The other half of the same rule. Whole-token matching separates
    // `overflow-hidden` from `hidden`; reading the `data-[…]` condition against
    // the element separates a panel that really is inactive from one merely
    // capable of becoming so.
    expect(
      clip(`<div ${attrs}><pre><code>shown()</code></pre></div>`),
    ).toContain("shown()");
  });

  test.each([
    "promo",
    "widget",
    "contact",
    "shopping",
    "tags",
    "meta",
    "outbrain",
    "share",
  ])('leaves furniture classed "%s" rejectable', (cls) => {
    // Only `hidden` and `scroll` are excepted from the negative-weight regex.
    // Declining it wholesale handed each of these eight back a code block
    // Readability had been deleting — they are the tokens that are
    // negative-weight *without* also being unlikely candidates, so nothing
    // else in the guard was catching them.
    const { html } = prepare(
      `<div class="${cls}"><pre><code>furniture()</code></pre></div>`,
    );
    expect(html).toContain(`class="${cls}"`);
  });

  test("leaves a citation export dropped", () => {
    // A real corpus shape: four <pre> citation blocks inside a collapsed
    // <details>. Readability is right to drop them as furniture, and there is
    // no <div> in the chain for this pass to touch. It must stay that way.
    const { html } = prepare(
      '<details class="cite-export"><ul class="citation-formats"><li>' +
        "<pre>Brown, B. K. (2026). Title.</pre></li></ul></details>",
    );
    expect(html).toContain('class="cite-export"');
  });

  test("leaves an image beside the code alone", () => {
    // Structural, not textual: an <img> carries no text and is still content.
    const { html } = prepare(
      '<div class="overflow-hidden"><img src="d.png" alt="d">' +
        "<pre><code>run()</code></pre></div>",
    );
    expect(html).toContain('class="overflow-hidden"');
  });
});

describe("code languages survive Readability", () => {
  /** Enough prose either side that Readability keeps the article at all. */
  const filler = `<p>${"Body sentence with enough words to score. ".repeat(20)}</p>`;

  /**
   * The whole clip, through the shipped entry point.
   *
   * Every other code test in this file goes straight from `prepareForClipping`
   * to `htmlToMarkdown`, and that is exactly why this defect shipped: the step
   * that erases the language sits between them. A test that does not run
   * Readability cannot see it.
   */
  function fenceOf(markup: string): string {
    const window = new Window({ url: "https://example.test/a" });
    window.document.body.innerHTML = `<article>${filler}${markup}${filler}</article>`;
    const payload = clipPage(
      window.document as unknown as Document,
      "https://example.test/a",
    );
    // The raw-body fallback never lost the class in the first place, so a case
    // that quietly took it would pass without proving anything.
    expect(payload.readabilityFailed).toBe(false);
    return (payload.markdown.match(/^```.*$/m) ?? ["<no fence>"])[0];
  }

  test("a language the page declared reaches the fence", () => {
    // The case the ten tests above cannot see. `_cleanClasses` strips `class`
    // from everything Readability returns, and a page that marks its code up
    // correctly is the common case — so this is most of the vault's 50 bare
    // fences, not an edge.
    expect(
      fenceOf('<pre><code class="language-python">import os</code></pre>'),
    ).toBe("```python");
  });

  test.each([
    ['<pre><code class="lang-ruby">puts 1</code></pre>', "```ruby"],
    ['<pre><code data-lang="go">package main</code></pre>', "```go"],
    [
      '<div class="highlight-source-js"><pre><code>let a = 1;</code></pre></div>',
      "```js",
    ],
    [
      '<pre><code class="sourceCode haskell">main = pure ()</code></pre>',
      "```haskell",
    ],
  ])("a recovered language reaches it too: %s", (markup, expected) => {
    expect(fenceOf(markup)).toBe(expected);
  });

  test("a page that names no language still gets a bare fence", () => {
    expect(fenceOf("<pre><code>plain text here</code></pre>")).toBe("```");
  });

  test("a highlighter's block with no language stays bare", () => {
    // Shape B/C from platform.claude.com: Shiki output carries no language
    // anywhere in the DOM, and the tab labels beside it are a guess this
    // deliberately does not make.
    expect(
      fenceOf(
        '<pre class="shiki"><span class="line">const a = 1;</span></pre>',
      ),
    ).toBe("```");
  });

  test("a junk language class writes no marker", () => {
    expect(
      fenceOf('<pre><code class="language-&lt;script&gt;">x</code></pre>'),
    ).toBe("```");
  });

  test("a fence still widens around backticks in the code", () => {
    // Restoring the class rather than adding a Turndown rule is what keeps this
    // working: the arithmetic stays Turndown's.
    expect(
      fenceOf('<pre><code class="language-md">a\n```\nb</code></pre>'),
    ).toBe("````md");
  });

  test("the marker is what crosses Readability, not the class", () => {
    // The mechanism itself, so a future change to either half is caught rather
    // than merely observed through the fence.
    const window = new Window();
    window.document.body.innerHTML = `<article>${filler}<pre><code class="language-python">import os</code></pre>${filler}</article>`;
    const doc = window.document as unknown as Document;
    prepareForClipping(doc);
    expect(doc.body.innerHTML).toContain(`${CODE_LANG_ATTR}="python"`);
    const extracted = new Readability(doc as never).parse()?.content ?? "";
    expect(extracted).toContain(`${CODE_LANG_ATTR}="python"`);
    expect(extracted).not.toContain("language-python");
  });

  test("a marker the page wrote itself is discarded", () => {
    // The marker is a private contract between dom-prepare and Turndown, and a
    // page is untrusted input. Backticks in a page-authored value open a fence
    // markdown cannot close: the block stops being `code`, so it goes to the
    // translator, and the stray closer swallows the prose after it (ADR 0003).
    expect(
      fenceOf('<pre><code data-tiro-lang="js```">payload()</code></pre>'),
    ).toBe("```");
  });

  test("a page-authored marker cannot cost a block its type", () => {
    const window = new Window({ url: "https://evil.test/a" });
    window.document.body.innerHTML = `<article>${filler}<pre><code data-tiro-lang="js\`\`\`">payload()</code></pre>${filler}</article>`;
    const { markdown } = clipPage(
      window.document as unknown as Document,
      "https://evil.test/a",
    );
    const block = splitBlocks(markdown).find((b) =>
      b.text.includes("payload()"),
    );
    expect(block?.type).toBe("code");
  });

  test("the marker never reaches the markdown", () => {
    const window = new Window({ url: "https://example.test/a" });
    window.document.body.innerHTML = `<article>${filler}<pre><code class="language-python">import os</code></pre>${filler}</article>`;
    const { markdown } = clipPage(
      window.document as unknown as Document,
      "https://example.test/a",
    );
    expect(markdown).not.toContain(CODE_LANG_ATTR);
  });
});

describe("markers the page wrote itself", () => {
  /** Enough prose either side that Readability keeps the article at all. */
  const filler = `<p>${"Body sentence with enough words to score. ".repeat(20)}</p>`;

  test("a page-authored math marker cannot split a paragraph", () => {
    // `data-tiro-math` has the same exposure `data-tiro-lang` does, and had it
    // first: the Turndown rule fires on the attribute alone, so a page that
    // writes one gets `$$…$$` emitted mid-paragraph — three blocks where the
    // article has one, which is the ADR 0003 alignment contract.
    const window = new Window({ url: "https://evil.test/a" });
    window.document.body.innerHTML = `<article>${filler}<p>Before. <span ${MATH_ATTR}="display">x$$ INJECTED</span> After.</p>${filler}</article>`;
    const { markdown, hasMath } = clipPage(
      window.document as unknown as Document,
      "https://evil.test/a",
    );
    expect(markdown).toContain("Before. x$$ INJECTED After.");
    // And it cannot set the flag that turns every price on the page into a
    // formula, which is what `escapeLiteralDollars` exists to prevent.
    expect(hasMath).toBe(false);
  });
});
