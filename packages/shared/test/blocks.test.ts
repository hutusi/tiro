import { describe, expect, test } from "bun:test";
import { checkAlignment, joinBlocks, splitBlocks } from "../src/blocks.ts";

const canonicalBody = [
  "# Heading",
  "",
  "First paragraph with **bold** text.",
  "",
  "```ts",
  "const a = 1;",
  "",
  "const b = 2; // blank line above must not split this block",
  "```",
  "",
  "| col | val |",
  "| --- | --- |",
  "| a   | 1   |",
  "",
  "- item one",
  "  - nested item",
  "- item two",
  "",
  "![cover](./assets/cover.png)",
  "",
  '<figure><img src="x.png" /></figure>',
  "",
  "Closing paragraph.",
  "",
].join("\n");

describe("splitBlocks", () => {
  test("splits top-level blocks with correct types", () => {
    const blocks = splitBlocks(canonicalBody);
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "code",
      "table",
      "list",
      "paragraph",
      "html",
      "paragraph",
    ]);
  });

  test("keeps a fenced code block with blank lines as one block, byte-identical", () => {
    const blocks = splitBlocks(canonicalBody);
    const code = blocks.find((b) => b.type === "code");
    expect(code?.text).toBe(
      "```ts\nconst a = 1;\n\nconst b = 2; // blank line above must not split this block\n```",
    );
  });

  test("keeps a multi-item nested list as one block", () => {
    const blocks = splitBlocks(canonicalBody).filter((b) => b.type === "list");
    expect(blocks).toHaveLength(1);
  });

  test("returns an empty array for an empty body", () => {
    expect(splitBlocks("")).toEqual([]);
    expect(splitBlocks("\n\n")).toEqual([]);
  });
});

describe("joinBlocks", () => {
  test("round-trips a canonical body byte-identically", () => {
    expect(joinBlocks(splitBlocks(canonicalBody))).toBe(canonicalBody);
  });
});

describe("checkAlignment", () => {
  const original = splitBlocks(canonicalBody);

  test("accepts a structurally identical translation", () => {
    const translated = original.map((b) =>
      b.type === "paragraph" ? { ...b, text: "翻译后的段落。" } : b,
    );
    expect(checkAlignment(original, translated)).toEqual({
      ok: true,
      errors: [],
    });
  });

  test("rejects a block count mismatch", () => {
    const result = checkAlignment(original, original.slice(1));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("block count mismatch");
  });

  test("rejects a per-index type mismatch", () => {
    const translated = original.map((b, i) =>
      i === 0 ? { ...b, type: "paragraph" } : b,
    );
    const result = checkAlignment(original, translated);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("type mismatch");
  });

  test("rejects an altered code block", () => {
    const translated = original.map((b) =>
      b.type === "code"
        ? { ...b, text: b.text.replace("const a", "const 甲") }
        : b,
    );
    const result = checkAlignment(original, translated);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("code block was altered");
  });
});
