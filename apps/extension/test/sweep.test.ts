import { describe, expect, test } from "bun:test";
import { backfill, countMarkdown } from "../scripts/sweep.ts";

describe("countMarkdown", () => {
  test("counts images and the subset that carry a folded caption", () => {
    const md = [
      "![a](x.png)  ", // folded: hard break, then a caption line
      "A caption.",
      "",
      "![b](y.png)", // bare image, no caption
      "",
      "Prose mentioning ![c](z.png) inline.",
    ].join("\n");
    expect(countMarkdown(md)).toEqual({ images: 3, captions: 1 });
  });

  test("counts nothing in empty markdown", () => {
    expect(countMarkdown("")).toEqual({ images: 0, captions: 0 });
  });

  test("counts each image on a shared line", () => {
    // Turndown emits adjacent images with nothing between them, and one vault
    // article really does carry two side by side. A per-line count reports
    // losing one of them as no change at all.
    expect(countMarkdown("![a](a.png) ![b](b.png)").images).toBe(2);
    expect(countMarkdown("![a](a.png)![b](b.png)").images).toBe(2);
  });

  test("a shared line with a hard break is still one folded caption", () => {
    // A folded figure is one paragraph however many images it holds.
    expect(countMarkdown("![a](a.png)![b](b.png)  \nCap.")).toEqual({
      images: 2,
      captions: 1,
    });
  });

  test("a line of prose ending in a hard break is not a caption", () => {
    expect(countMarkdown("Just prose.  \nMore.")).toEqual({
      images: 0,
      captions: 0,
    });
  });

  test("counts an image whose alt text carries an escaped bracket", () => {
    // What the clipper actually writes for alt="a]b" — verified against
    // htmlToMarkdown, not imagined. A `[^\]]` pattern sees no image here.
    expect(countMarkdown(String.raw`![a\]b](x.png)`).images).toBe(1);
    expect(countMarkdown(String.raw`![a\[b](x.png)`).images).toBe(1);
  });

  test("does not count an escaped bang, which is literal text", () => {
    expect(countMarkdown(String.raw`\![x](x.png)`).images).toBe(0);
  });

  test("counts an image nested in a link", () => {
    // The shape the figure fold produces for a linked picture.
    expect(countMarkdown("[![a](a.png)](full.png)").images).toBe(1);
  });
});

describe("countMarkdown ignores code, however it is written", () => {
  /** Each of these is a way a fence can be written that a line-shape test misses. */
  const cases: [string, string][] = [
    ["a plain fence", "```\n![x](x.png)\n```"],
    ["a fence with a language", "```md\n![x](x.png)\n```"],
    ["a tilde fence", "~~~\n![x](x.png)\n~~~"],
    ["four backticks around three", "````\n```\n![x](x.png)\n```\n````"],
    ["a fence inside a blockquote", "> ```\n> ![x](x.png)\n> ```"],
    ["a fence inside a list item", "- ```\n  ![x](x.png)\n  ```"],
    ["indented code", "    ![x](x.png)"],
    ["an inline span", "Write `![x](x.png)` to embed."],
  ];

  for (const [name, markdown] of cases) {
    test(`skips ${name}`, () => {
      expect(countMarkdown(markdown).images).toBe(0);
    });
  }

  test("still counts a real image beside code", () => {
    const md =
      "![real](r.png)\n\n```md\n![example](e.png)\n```\n\n![also](a.png)";
    expect(countMarkdown(md).images).toBe(2);
  });

  test("counts an image in a list item that is not code", () => {
    expect(countMarkdown("- ![x](x.png)").images).toBe(1);
  });
});

describe("backfill", () => {
  const FRONTMATTER = [
    "---",
    "url: https://example.com/a",
    "title: A",
    "domain: example.com",
    "clipped_at: 2026-09-04T00:00:00.000Z",
    "tiro:",
    "  schema: 1",
    "  clipper_version: 0.11.1",
    "---",
    "",
  ].join("\n");

  const article = (body: string) => FRONTMATTER + body;

  test("copies a fresh clip's language onto a bare fence", () => {
    const result = backfill(
      article("Intro.\n\n```\nlet x = 1;\n```\n"),
      null,
      "Intro.\n\n```rust\nlet x = 1;\n```\n",
    );
    expect(result?.languages).toEqual(["rust"]);
    expect(result?.index).toContain("```rust\nlet x = 1;\n```");
    expect(result?.index).toContain("url: https://example.com/a");
  });

  /**
   * `checkAlignment` compares a code block's source slice, fence lines
   * included, so a language written into `index.md` alone breaks byte-identity
   * and drops the article out of side-by-side rendering entirely (ADR 0003).
   */
  test("writes the same language into zh.md", () => {
    const result = backfill(
      article("Intro.\n\n```\nlet x = 1;\n```\n"),
      "介绍。\n\n```\nlet x = 1;\n```\n",
      "Intro.\n\n```rust\nlet x = 1;\n```\n",
    );
    expect(result?.index).toContain("```rust");
    expect(result?.zh).toContain("```rust");
    expect(result?.refused).toBeUndefined();
  });

  test("refuses when the two files do not correspond", () => {
    const result = backfill(
      article("Intro.\n\n```\nlet x = 1;\n```\n"),
      "介绍。\n\n```\nlet y = 2;\n```\n",
      "Intro.\n\n```rust\nlet x = 1;\n```\n",
    );
    expect(result?.refused).toContain("do not correspond");
    expect(result?.languages).toEqual([]);
  });

  test("leaves a fence that already declares a language", () => {
    expect(
      backfill(
        article("```ts\nlet x = 1;\n```\n"),
        null,
        "```rust\nlet x = 1;\n```\n",
      ),
    ).toBeNull();
  });

  test("leaves a fence the fresh clip does not name", () => {
    expect(
      backfill(
        article("```\nlet x = 1;\n```\n"),
        null,
        "```\nlet x = 1;\n```\n",
      ),
    ).toBeNull();
  });

  test("declines a snippet the page shows under two languages", () => {
    // The same code in two tabs is a real shape, and nothing in the vault says
    // which copy is which.
    expect(
      backfill(
        article("```\nprint(1)\n```\n"),
        null,
        "```python\nprint(1)\n```\n\n```ruby\nprint(1)\n```\n",
      ),
    ).toBeNull();
  });

  test("matches across trailing-whitespace drift", () => {
    const result = backfill(
      article("```\nlet x = 1;  \n```\n"),
      null,
      "```rust\nlet x = 1;\n```\n",
    );
    expect(result?.languages).toEqual(["rust"]);
  });

  test("labels each of several fences independently", () => {
    const body = "```\nlet x = 1;\n```\n\ntext\n\n```\nprint(1)\n```\n";
    const result = backfill(
      article(body),
      null,
      "```rust\nlet x = 1;\n```\n\ntext\n\n```python\nprint(1)\n```\n",
    );
    expect(result?.languages).toEqual(["rust", "python"]);
    expect(result?.index).toContain("```rust");
    expect(result?.index).toContain("```python");
  });

  test("changes nothing but the fence's opening line", () => {
    const body = "Intro.\n\n```\nlet x = 1;\n```\n\nOutro.\n";
    const result = backfill(article(body), null, "```rust\nlet x = 1;\n```\n");
    expect(result?.index).toBe(
      article(body).replace("```\nlet", "```rust\nlet"),
    );
  });
});
