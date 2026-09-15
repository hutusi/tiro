import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  absolutizeMarkdownUrls,
  excerptFromMarkdown,
  inlineReferenceLinks,
  normalizeSourceMarkdown,
  plainTextMarkdownSource,
  stripYamlFrontmatter,
  titleFromMarkdown,
} from "../src/plain-markdown.ts";

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

const RAW =
  "https://raw.githubusercontent.com/o/r/refs/heads/main/docs/GUIDE.md";

describe("plainTextMarkdownSource", () => {
  /**
   * What Chrome actually serves for a `.md` on raw.githubusercontent.com: an
   * HTML shell whose body is one `<pre>` holding the file. Until this existed
   * the clipper read it as any other bare `<pre>` — a code block.
   */
  test("recognises Chrome's plain-text viewer over a markdown file", () => {
    const doc = docFrom("<pre># Title\n\nProse.</pre>");
    expect(plainTextMarkdownSource(doc, RAW)).toBe("# Title\n\nProse.");
  });

  test("accepts every markdown extension the identity rule claims", () => {
    const doc = docFrom("<pre># T</pre>");
    for (const name of ["a.md", "a.markdown", "a.mdown", "a.mkd", "A.MD"]) {
      expect(plainTextMarkdownSource(doc, `https://x.test/${name}`)).toBe(
        "# T",
      );
    }
  });

  // The file is plain text whatever its extension, but only markdown is
  // markdown. A .txt is hard-wrapped prose and ASCII art that markdown would
  // reflow, and .mdx is JSX — both stay code blocks.
  test.each(["notes.txt", "app.py", "page.mdx", "archive.md.gz", "plain"])(
    "declines %s, whose bytes are not markdown",
    (name) => {
      const doc = docFrom("<pre>text</pre>");
      expect(plainTextMarkdownSource(doc, `https://x.test/${name}`)).toBeNull();
    },
  );

  // The false positive that matters: a real page that happens to open with a
  // code block. Its prose sits outside the <pre>, which is what the shape test
  // is for — and this one is served from a `.md` URL to defeat that gate too.
  test("declines a real page whose body merely contains a pre", () => {
    const doc = docFrom(
      `<article><pre>npm install</pre><p>${"Word ".repeat(80)}</p></article>`,
    );
    expect(plainTextMarkdownSource(doc, RAW)).toBeNull();
  });

  test("declines a page with text beside the pre", () => {
    const doc = docFrom("<pre># T</pre><p>Also this.</p>");
    expect(plainTextMarkdownSource(doc, RAW)).toBeNull();
  });

  test("declines an empty file rather than commit an empty article", () => {
    expect(plainTextMarkdownSource(docFrom("<pre>   </pre>"), RAW)).toBeNull();
    expect(plainTextMarkdownSource(docFrom(""), RAW)).toBeNull();
  });
});

describe("absolutizeMarkdownUrls", () => {
  // The defect that made the clipped transcript's 39 images dead: the
  // processor mirrors only absolute URLs, and a relative one then resolves
  // against the *site's* origin.
  test("resolves a repo-relative image against the file it came from", () => {
    expect(absolutizeMarkdownUrls("![shot](GUIDE/01.jpg)", RAW)).toBe(
      "![shot](https://raw.githubusercontent.com/o/r/refs/heads/main/docs/GUIDE/01.jpg)",
    );
  });

  test.each([
    [
      "../assets/a.png",
      "https://raw.githubusercontent.com/o/r/refs/heads/main/assets/a.png",
    ],
    [
      "./b.png",
      "https://raw.githubusercontent.com/o/r/refs/heads/main/docs/b.png",
    ],
    ["/o/r/main/c.png", "https://raw.githubusercontent.com/o/r/main/c.png"],
  ])("resolves %s", (target, expected) => {
    expect(absolutizeMarkdownUrls(`![a](${target})`, RAW)).toBe(
      `![a](${expected})`,
    );
  });

  // A sibling markdown file is a document, and the reader should land on the
  // page it is presented on rather than on its plain text. The rule that files
  // this article answers the same question, so it costs nothing to ask.
  test("points a link to a sibling markdown file at its blob page", () => {
    expect(absolutizeMarkdownUrls("[more](OTHER.md)", RAW)).toBe(
      "[more](https://github.com/o/r/blob/main/docs/OTHER.md)",
    );
  });

  test.each([
    "[a](https://example.com/x)",
    "[a](//example.com/x)",
    "[a](#section)",
    "[a](mailto:x@example.com)",
    "<https://example.com>",
    "www.example.com",
  ])("leaves %s exactly as it was", (markdown) => {
    expect(absolutizeMarkdownUrls(markdown, RAW)).toBe(markdown);
  });

  // Nothing in a fence is a destination, and the parser is what knows it.
  test("does not touch a relative path inside code", () => {
    const markdown = "```sh\ncp img/a.png ./b\n```\n\nAnd `![x](y.png)` too.";
    expect(absolutizeMarkdownUrls(markdown, RAW)).toBe(markdown);
  });

  test("keeps the title and the text the link sits on", () => {
    expect(absolutizeMarkdownUrls('[**bold** text](a.md "why")', RAW)).toBe(
      '[**bold** text](https://github.com/o/r/blob/main/docs/a.md "why")',
    );
  });

  test("escapes a destination that would otherwise close early", () => {
    expect(absolutizeMarkdownUrls("[a](Foo_(bar).png)", RAW)).toBe(
      "[a](https://raw.githubusercontent.com/o/r/refs/heads/main/docs/Foo_\\(bar\\).png)",
    );
  });
});

describe("inlineReferenceLinks", () => {
  /**
   * The site renders each top-level block through its own processor, so a
   * definition in one block cannot resolve a reference in another — both would
   * render as literal text. Turndown never emitted references, which is why
   * nothing in the vault has hit this.
   */
  test("rewrites a full reference and drops its definition", () => {
    expect(
      inlineReferenceLinks("See [the spec][rfc].\n\n[rfc]: https://e.test/s"),
    ).toBe("See [the spec](https://e.test/s).\n\n");
  });

  test.each([
    ["[collapsed][]", "[collapsed](https://e.test/a)"],
    ["[shortcut]", "[shortcut](https://e.test/a)"],
    ["![img][ref]", "![img](https://e.test/a)"],
  ])("rewrites %s", (source, expected) => {
    const body = `${source}\n\n[collapsed]: https://e.test/a\n[shortcut]: https://e.test/a\n[ref]: https://e.test/a\n`;
    expect(inlineReferenceLinks(body).trim()).toBe(expected);
  });

  test("keeps a definition's title", () => {
    expect(
      inlineReferenceLinks('[a][id]\n\n[id]: https://e.test/x "Why"').trim(),
    ).toBe('[a](https://e.test/x "Why")');
  });

  // CommonMark's rule, and worth pinning: a repeated identifier resolves to
  // the first definition, not the last.
  test("uses the first definition of a repeated identifier", () => {
    expect(
      inlineReferenceLinks(
        "[a][id]\n\n[id]: https://e.test/first\n[id]: https://e.test/second\n",
      ).trim(),
    ).toBe("[a](https://e.test/first)");
  });

  // A definition nothing points at would render as an empty block, which the
  // translation would then have to produce an empty counterpart for.
  test("drops an unused definition too", () => {
    expect(inlineReferenceLinks("Prose.\n\n[unused]: https://e.test/x\n")).toBe(
      "Prose.\n\n",
    );
  });

  test("leaves a document with no definitions byte-identical", () => {
    const markdown = "# T\n\n[a](https://e.test/x) and `[b][c]`.\n";
    expect(inlineReferenceLinks(markdown)).toBe(markdown);
  });
});

describe("stripYamlFrontmatter", () => {
  test("takes the block off and keeps its title", () => {
    const result = stripYamlFrontmatter(
      '---\ntitle: "The Note"\ndraft: false\n---\n\n# Heading\n',
    );
    expect(result.title).toBe("The Note");
    expect(result.body).toBe("\n# Heading\n");
  });

  test("leaves a file that has none alone", () => {
    const result = stripYamlFrontmatter("# Heading\n\nProse.\n");
    expect(result.body).toBe("# Heading\n\nProse.\n");
    expect(result.title).toBeNull();
  });

  // A thematic break is not frontmatter, and eating it would lose a rule the
  // author drew.
  test("does not mistake a leading thematic break for frontmatter", () => {
    const markdown = "---\n\nProse after a rule.\n";
    expect(stripYamlFrontmatter(markdown).body).toBe(markdown);
  });
});

describe("titleFromMarkdown", () => {
  test.each([
    ["# The Title\n\nProse.", "The Title"],
    ["The Title\n=========\n\nProse.", "The Title"],
    ["# A **bold** title", "A bold title"],
    ["Intro.\n\n# Later Heading", "Later Heading"],
  ])("reads the level-one heading of %s", (markdown, expected) => {
    expect(titleFromMarkdown(markdown)).toBe(expected);
  });

  test.each([
    "## Section only\n\nProse.",
    "Just prose.",
    "#\n\nEmpty heading.",
  ])("finds no title in %s", (markdown) => {
    expect(titleFromMarkdown(markdown)).toBeNull();
  });
});

describe("excerptFromMarkdown", () => {
  test("takes the first paragraph that says something", () => {
    expect(
      excerptFromMarkdown(
        "# T\n\n![cover](https://e.test/c.png)\n\nThe point.",
      ),
    ).toBe("The point.");
  });

  test("truncates a long one", () => {
    expect(
      excerptFromMarkdown(`# T\n\n${"word ".repeat(200)}`).length,
    ).toBeLessThanOrEqual(401);
  });

  test("is empty when there is no prose", () => {
    expect(excerptFromMarkdown("# T\n\n- a\n- b")).toBe("");
  });
});

describe("normalizeSourceMarkdown", () => {
  test("prefers the file's own frontmatter title over its heading", () => {
    const result = normalizeSourceMarkdown(
      "---\ntitle: From Frontmatter\n---\n\n# From Heading\n\nProse.",
      RAW,
    );
    expect(result.title).toBe("From Frontmatter");
  });

  // The body keeps its opening heading on purpose: `liftTitles` on the site
  // drops that row when it matches the article title, and lifts the zh one as
  // the translated title. Stripping it here would throw both away.
  test("keeps the body's opening heading", () => {
    const result = normalizeSourceMarkdown("# Kept\n\nProse.", RAW);
    expect(result.title).toBe("Kept");
    expect(result.markdown).toBe("# Kept\n\nProse.");
  });

  test("inlines references before resolving them, so both run", () => {
    const result = normalizeSourceMarkdown(
      "# T\n\n![shot][s]\n\n[s]: shots/a.png\n",
      RAW,
    );
    expect(result.markdown).toBe(
      "# T\n\n![shot](https://raw.githubusercontent.com/o/r/refs/heads/main/docs/shots/a.png)",
    );
  });

  test("normalizes CRLF and a byte-order mark", () => {
    expect(normalizeSourceMarkdown("﻿# T\r\n\r\nProse.\r\n", RAW).markdown).toBe(
      "# T\n\nProse.",
    );
  });
});
