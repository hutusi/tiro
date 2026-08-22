import { describe, expect, test } from "bun:test";
import type { ChatFn } from "../src/llm/client.ts";
import { summarize } from "../src/llm/summarize.ts";

const baseOptions = {
  model: "test-model",
  categories: ["tech", "ai", "other"],
  title: "Hello",
  body: "First paragraph of the article.\n\nSecond paragraph.",
  targetLang: "zh",
};

function scripted(responses: string[]): { chat: ChatFn; calls: () => number } {
  let i = 0;
  return {
    chat: async () => {
      const response = responses[i];
      i += 1;
      if (response === undefined) throw new Error("fake chat exhausted");
      return response;
    },
    calls: () => i,
  };
}

describe("summarize", () => {
  test("returns a valid result on the first attempt", async () => {
    const { chat } = scripted([
      JSON.stringify({ summary: "摘要", category: "ai", tags: ["a"] }),
    ]);
    const result = await summarize({ ...baseOptions, chat });
    expect(result).toEqual({
      summary: "摘要",
      category: "ai",
      tags: ["a"],
      failed: false,
    });
  });

  test("retries invalid JSON and then succeeds", async () => {
    const { chat, calls } = scripted([
      "not json at all",
      JSON.stringify({ summary: "摘要", category: "tech", tags: [] }),
    ]);
    const result = await summarize({ ...baseOptions, chat });
    expect(result.failed).toBe(false);
    expect(result.category).toBe("tech");
    expect(calls()).toBe(2);
  });

  test("retries an off-taxonomy category", async () => {
    const { chat } = scripted([
      JSON.stringify({ summary: "摘要", category: "sports", tags: [] }),
      JSON.stringify({ summary: "摘要", category: "other", tags: [] }),
    ]);
    const result = await summarize({ ...baseOptions, chat });
    expect(result.category).toBe("other");
    expect(result.failed).toBe(false);
  });

  test("falls back to a first-paragraph excerpt after repeated failures", async () => {
    const { chat, calls } = scripted(["bad", "bad", "bad"]);
    const result = await summarize({ ...baseOptions, chat });
    expect(result.failed).toBe(true);
    expect(result.category).toBe("other");
    expect(result.tags).toEqual([]);
    expect(result.summary).toBe("First paragraph of the article.");
    expect(calls()).toBe(3);
  });

  test("truncates an oversized body", async () => {
    let seenLength = 0;
    const chat: ChatFn = async (request) => {
      seenLength =
        request.messages.find((m) => m.role === "user")?.content.length ?? 0;
      return JSON.stringify({ summary: "s", category: "ai", tags: [] });
    };
    await summarize({
      ...baseOptions,
      chat,
      body: "x".repeat(100_000),
      maxBodyChars: 1000,
    });
    expect(seenLength).toBeLessThan(2000);
  });
});
