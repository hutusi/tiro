import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitBlocks } from "@tiro/shared";
import { createDeadline, DeadlineExceededError } from "../src/deadline.ts";
import {
  loadTranslationCache,
  TRANSLATION_CACHE_FILE,
} from "../src/llm/cache.ts";
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

const header = { target: "zh", model: "m" };

function cachePath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "tiro-translate-")),
    TRANSLATION_CACHE_FILE,
  );
}

/** Six paragraphs, each its own batch under a tiny batchChars. */
const manyBlocks = splitBlocks(
  Array.from({ length: 6 }, (_, i) => `Paragraph ${i}.`).join("\n\n"),
);

describe("translateBlocks checkpointing", () => {
  test("reuses cached blocks and never re-sends them", async () => {
    const path = cachePath();
    const seeded = await loadTranslationCache(path, header);
    seeded.set("First paragraph.", "缓存的翻译。");
    await seeded.flush();

    const seen: string[] = [];
    const chat = makeFakeChat({
      onRequest: (r) => seen.push(r.messages.at(-1)?.content ?? ""),
    });
    const cache = await loadTranslationCache(path, header);
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks,
      cache,
    });

    expect(zh).not.toBeNull();
    expect(splitBlocks(zh ?? "")[1]?.text).toBe("缓存的翻译。");
    expect(seen.join("\n")).not.toContain("First paragraph.");
  });

  test("drops the checkpoint once the article is fully translated", async () => {
    const path = cachePath();
    const cache = await loadTranslationCache(path, header);
    const zh = await translateBlocks({
      chat: makeFakeChat(),
      model: "m",
      targetLang: "zh",
      blocks,
      cache,
    });
    expect(zh).not.toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test("drops the checkpoint on misalignment so a retry is not doomed", async () => {
    // Keeping it would resume from the very blocks that broke alignment and
    // reproduce the same failure on every future --force retry.
    const chat: ChatFn = async () => "翻译。\n\n多出来的一段。";
    const path = cachePath();
    const cache = await loadTranslationCache(path, header);
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks,
      cache,
    });
    expect(zh).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test("stops on the run budget and leaves finished batches on disk", async () => {
    let clock = 0;
    // Budget for roughly two calls; each call bills 60ms.
    const deadline = createDeadline(100, () => clock);
    let calls = 0;
    const fake = makeFakeChat();
    const chat: ChatFn = async (request) => {
      calls += 1;
      clock += 60;
      return fake(request);
    };

    const path = cachePath();
    const cache = await loadTranslationCache(path, header);
    await expect(
      translateBlocks({
        chat,
        model: "m",
        targetLang: "zh",
        blocks: manyBlocks,
        batchChars: 1,
        cache,
        deadline,
      }),
    ).rejects.toThrow(DeadlineExceededError);

    // It stopped early rather than grinding through all six blocks...
    expect(calls).toBeLessThan(manyBlocks.length);
    // ...and the work it did do survived, which is the whole point.
    const resumed = await loadTranslationCache(path, header);
    expect(resumed.restored).toBe(calls);
    expect(resumed.get("Paragraph 0.")).toBe("中文：Paragraph 0.");
  });

  test("a second run resumes and finishes what the budget cut short", async () => {
    const path = cachePath();
    let clock = 0;
    const stingy = createDeadline(100, () => clock);
    const billing: ChatFn = async (request) => {
      clock += 60;
      return makeFakeChat()(request);
    };
    await expect(
      translateBlocks({
        chat: billing,
        model: "m",
        targetLang: "zh",
        blocks: manyBlocks,
        batchChars: 1,
        cache: await loadTranslationCache(path, header),
        deadline: stingy,
      }),
    ).rejects.toThrow(DeadlineExceededError);
    const firstRun = (await loadTranslationCache(path, header)).restored;
    expect(firstRun).toBeGreaterThan(0);

    // Second run, generous budget: only the blocks the first run missed are
    // sent, and the article completes.
    let sent = 0;
    const chat = makeFakeChat({ onRequest: () => (sent += 1) });
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks: manyBlocks,
      batchChars: 1,
      cache: await loadTranslationCache(path, header),
    });
    expect(zh).not.toBeNull();
    expect(sent).toBe(manyBlocks.length - firstRun);
    expect(splitBlocks(zh ?? "")).toHaveLength(manyBlocks.length);
    expect(existsSync(path)).toBe(false);
  });
});
