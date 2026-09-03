import { describe, expect, test } from "bun:test";
import { countMarkdown } from "../scripts/sweep.ts";

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
