import { describe, expect, test } from "bun:test";
import { splitBlocks } from "@tiro/shared";
import type { ChatFn } from "../src/llm/client.ts";
import { translateBlocks } from "../src/llm/translate.ts";
import { makeFakeChat } from "./helpers.ts";

const body = [
  "# A Heading",
  "",
  "First paragraph.",
  "",
  "```ts",
  "const untouched = true;",
  "```",
  "",
  "![only an image](./assets/x.png)",
  "",
  "Last paragraph.",
  "",
].join("\n");

const blocks = splitBlocks(body);

describe("translateBlocks", () => {
  test("translates via batching, copying verbatim blocks byte-identically", async () => {
    const seen: string[] = [];
    const chat = makeFakeChat({
      onRequest: (r) => seen.push(r.messages.at(-1)?.content ?? ""),
    });
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks,
    });
    expect(zh).not.toBeNull();
    const zhBlocks = splitBlocks(zh ?? "");
    expect(zhBlocks.map((b) => b.type)).toEqual(blocks.map((b) => b.type));
    expect(zhBlocks[0]?.text).toBe("# A Heading（中文）");
    expect(zhBlocks[1]?.text).toBe("中文：First paragraph.");
    expect(zhBlocks[2]?.text).toBe("```ts\nconst untouched = true;\n```");
    expect(zhBlocks[3]?.text).toBe("![only an image](./assets/x.png)");
    // Verbatim blocks (code, image-only paragraph) never reach the LLM.
    expect(seen.join("\n")).not.toContain("const untouched");
    expect(seen.join("\n")).not.toContain("only an image");
  });

  test("falls back to per-block translation on repeated marker mismatch", async () => {
    let batchCalls = 0;
    const fallback = makeFakeChat();
    const chat: ChatFn = async (request) => {
      const user =
        request.messages.find((m) => m.role === "user")?.content ?? "";
      if (user.includes("<<<TIRO_BLOCK_")) {
        batchCalls += 1;
        return "garbage without any markers";
      }
      return fallback(request);
    };
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks,
    });
    expect(batchCalls).toBe(2);
    expect(zh).not.toBeNull();
    expect(splitBlocks(zh ?? "")[1]?.text).toBe("中文：First paragraph.");
  });

  test("returns null when the translation breaks alignment", async () => {
    const chat: ChatFn = async (request) => {
      const user =
        request.messages.find((m) => m.role === "user")?.content ?? "";
      if (user.includes("<<<TIRO_BLOCK_")) {
        // Marker-valid response whose first block splits into two paragraphs.
        const matches = [...user.matchAll(/<<<TIRO_BLOCK_(\d+)>>>/g)];
        return matches
          .map((m) => `<<<TIRO_BLOCK_${m[1]}>>>\n翻译。\n\n多出来的一段。`)
          .join("\n");
      }
      return "翻译。\n\n多出来的一段。";
    };
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks,
    });
    expect(zh).toBeNull();
  });

  test("splits oversized inputs into multiple batches", async () => {
    let batchCalls = 0;
    const chat = makeFakeChat({
      onRequest: (r) => {
        if ((r.messages.at(-1)?.content ?? "").includes("<<<TIRO_BLOCK_"))
          batchCalls += 1;
      },
    });
    const longBlocks = splitBlocks(
      Array.from({ length: 6 }, (_, i) =>
        `Paragraph ${i} ${"words ".repeat(120)}`.trim(),
      ).join("\n\n"),
    );
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks: longBlocks,
      batchChars: 1500,
    });
    expect(zh).not.toBeNull();
    expect(batchCalls).toBeGreaterThan(1);
  });

  test("uses per-block mode when the source contains the sentinel", async () => {
    let sawBatch = false;
    const fallback = makeFakeChat();
    const chat: ChatFn = async (request) => {
      const user =
        request.messages.find((m) => m.role === "user")?.content ?? "";
      if (user.includes("<<<TIRO_BLOCK_0>>>")) sawBatch = true;
      return fallback(request);
    };
    const trickyBlocks = splitBlocks(
      "A paragraph quoting the literal marker <<<TIRO_BLOCK_0>>> inline.",
    );
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks: trickyBlocks,
    });
    expect(zh).not.toBeNull();
    expect(sawBatch).toBe(true); // per-block mode passes the raw block through
  });
});
