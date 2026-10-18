import { afterEach, expect, spyOn, test } from "bun:test";
import type { Element, Root } from "hast";
import { rehypeShiki } from "../src/lib/highlight.ts";

function fence(lang: string, text: string): Element {
  return {
    type: "element",
    tagName: "pre",
    properties: {},
    children: [
      {
        type: "element",
        tagName: "code",
        properties: { className: [`language-${lang}`] },
        children: [{ type: "text", value: `${text}\n` }],
      },
    ],
  };
}

const warn = spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => warn.mockClear());

// The engine throws on a grammar pattern it cannot translate. That must cost
// the block its colors and nothing else, or one clipped fence fails the build.
test("a highlighter that throws leaves that block plain and the rest highlighted", () => {
  const broken = fence("python", "x = 1");
  const fine = fence("json", '{"a": 1}');
  const tree: Root = { type: "root", children: [broken, fine] };
  const highlighted: Element = {
    type: "element",
    tagName: "pre",
    properties: { className: ["shiki"] },
    children: [],
  };

  rehypeShiki({
    codeToHast: (_code, lang) => {
      if (lang === "python") throw new Error("unsupported regex feature");
      return { type: "root", children: [highlighted] };
    },
  })(tree);

  expect(tree.children[0]).toBe(broken);
  expect(tree.children[1]).toBe(highlighted);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain('"python"');
});
