import { describe, expect, test } from "bun:test";
import { splitBlocks } from "@tiro/shared";
import { Window } from "happy-dom";
import { MATH_ATTR, prepareForClipping } from "../src/dom-prepare.ts";
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
