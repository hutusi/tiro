import { describe, expect, test } from "bun:test";
import { DeadlineExceededError } from "../src/deadline.ts";
import type { ChatFn } from "../src/llm/client.ts";
import { summarize } from "../src/llm/summarize.ts";

const baseOptions = {
  model: "test-model",
  categories: ["tech", "ai", "other"],
  title: "Hello",
  body: "First paragraph of the article.\n\nSecond paragraph.",
  targetLang: "zh",
  cjkThreshold: 0.3,
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

  test("asks for the pair only when the article has a source language", async () => {
    let system = "";
    const chat: ChatFn = async (request) => {
      system = request.messages.find((m) => m.role === "system")?.content ?? "";
      return JSON.stringify({ summary: "摘要", category: "ai", tags: [] });
    };
    await summarize({ ...baseOptions, chat, bilingual: true });
    expect(system).toContain("title_zh");
    expect(system).toContain("summary_orig");

    await summarize({ ...baseOptions, chat });
    expect(system).not.toContain("title_zh");
    expect(system).not.toContain("summary_orig");
  });

  test("returns the pair when the model supplies it", async () => {
    const { chat } = scripted([
      JSON.stringify({
        summary: "摘要",
        category: "ai",
        tags: ["a"],
        title_zh: "你好",
        summary_orig: "An English summary.",
      }),
    ]);
    const result = await summarize({ ...baseOptions, chat, bilingual: true });
    expect(result.titleZh).toBe("你好");
    expect(result.summaryOrig).toBe("An English summary.");
    expect(result.failed).toBe(false);
  });

  test("a missing title costs the article nothing", async () => {
    // The trap this pins: requiring title_zh in the response schema would feed
    // the omission back as a correction and, three attempts later, cost the
    // article its summary, category and tags and mark it summary_failed.
    const { chat, calls } = scripted([
      JSON.stringify({ summary: "摘要", category: "ai", tags: ["a"] }),
    ]);
    const result = await summarize({ ...baseOptions, chat, bilingual: true });
    expect(result.failed).toBe(false);
    expect(result.summary).toBe("摘要");
    expect(result.titleZh).toBeUndefined();
    expect(calls()).toBe(1);
  });

  test("drops a title the model echoed in the source language", async () => {
    const { chat } = scripted([
      JSON.stringify({
        summary: "摘要",
        category: "ai",
        tags: [],
        title_zh: "Hello",
      }),
    ]);
    const result = await summarize({ ...baseOptions, chat, bilingual: true });
    expect(result.titleZh).toBeUndefined();
    expect(result.failed).toBe(false);
  });

  test("drops a title echoed back with Han already in it", async () => {
    // The Han test alone cannot see this one: the source title mixes scripts,
    // so handing it back unchanged satisfies "contains Chinese".
    const { chat } = scripted([
      JSON.stringify({
        summary: "摘要",
        category: "ai",
        tags: [],
        title_zh: "AI 与 the Future",
      }),
    ]);
    const result = await summarize({
      ...baseOptions,
      chat,
      title: "AI 与 the Future",
      bilingual: true,
    });
    expect(result.titleZh).toBeUndefined();
    expect(result.failed).toBe(false);
  });

  test("drops a source summary rewritten in the target language", async () => {
    // The likelier failure by far, and the one an equality test cannot see: the
    // model writes the target language again, in different words.
    const { chat } = scripted([
      JSON.stringify({
        summary: "小模型已经到来，成本大幅下降。",
        category: "ai",
        tags: [],
        summary_orig: "这是另一段中文摘要，措辞不同但仍然是中文。",
      }),
    ]);
    const result = await summarize({ ...baseOptions, chat, bilingual: true });
    expect(result.summaryOrig).toBeUndefined();
  });

  test("keeps a source summary that only quotes the target language", async () => {
    // The line the ratio has to sit on the right side of.
    const candidate =
      'The author calls this habit "读后感" throughout the piece.';
    const { chat } = scripted([
      JSON.stringify({
        summary: "中文摘要。",
        category: "ai",
        tags: [],
        summary_orig: candidate,
      }),
    ]);
    const result = await summarize({ ...baseOptions, chat, bilingual: true });
    expect(result.summaryOrig).toBe(candidate);
  });

  test("drops a source summary that just repeats the target one", async () => {
    const { chat } = scripted([
      JSON.stringify({
        summary: "摘要",
        category: "ai",
        tags: [],
        summary_orig: "摘要",
      }),
    ]);
    const result = await summarize({ ...baseOptions, chat, bilingual: true });
    expect(result.summaryOrig).toBeUndefined();
  });

  test("ignores a pair volunteered for an article already in the target language", async () => {
    const { chat } = scripted([
      JSON.stringify({
        summary: "摘要",
        category: "ai",
        tags: [],
        title_zh: "另一个标题",
        summary_orig: "An English summary.",
      }),
    ]);
    const result = await summarize({ ...baseOptions, chat });
    expect(result.titleZh).toBeUndefined();
    expect(result.summaryOrig).toBeUndefined();
  });

  test("the excerpt fallback carries no pair", async () => {
    const { chat } = scripted(["nope", "still nope", "nope again"]);
    const result = await summarize({ ...baseOptions, chat, bilingual: true });
    expect(result.failed).toBe(true);
    expect(result.titleZh).toBeUndefined();
    expect(result.summaryOrig).toBeUndefined();
  });

  test("propagates provider errors instead of falling back", async () => {
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      throw new Error("chat completions request failed with 403: denied");
    };
    await expect(summarize({ ...baseOptions, chat })).rejects.toThrow("403");
    // No corrective retry: a 403 is not something a reworded prompt fixes,
    // and the caller needs the throw to leave the article pending.
    expect(calls).toBe(1);
  });

  test("keeps the fallback category inside a taxonomy without 'other'", async () => {
    const { chat } = scripted(["bad", "bad", "bad"]);
    const result = await summarize({
      ...baseOptions,
      categories: ["tech", "life"],
      chat,
    });
    expect(result.failed).toBe(true);
    expect(result.category).toBe("life");
  });

  test("falls back to the title when the body has no paragraph", async () => {
    const { chat } = scripted(["bad", "bad", "bad"]);
    const result = await summarize({
      ...baseOptions,
      body: "```js\nconst a = 1;\n```",
      chat,
    });
    expect(result.summary).toBe("Hello");
  });

  test("puts the rejected reply in the transcript it refers to", async () => {
    const seen: string[] = [];
    let i = 0;
    const replies = [
      "not json",
      JSON.stringify({ summary: "摘要", category: "ai", tags: [] }),
    ];
    const chat: ChatFn = async (request) => {
      seen.length = 0;
      for (const m of request.messages) seen.push(m.role);
      const reply = replies[i];
      i += 1;
      return reply ?? "";
    };
    await summarize({ ...baseOptions, chat });
    expect(seen).toEqual(["system", "user", "assistant", "user"]);
  });
  test("propagates a run-budget error instead of falling back to the excerpt", async () => {
    // Load-bearing and easy to break: `await chat(...)` sits outside the try on
    // purpose. If it were moved inside, an exhausted budget would be read as a
    // bad response, retried twice more, and buried in a silent excerpt
    // fallback — the article would be marked processed with no real summary.
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      throw new DeadlineExceededError("a chat completions request", -1);
    };
    await expect(summarize({ ...baseOptions, chat })).rejects.toThrow(
      DeadlineExceededError,
    );
    expect(calls).toBe(1); // not 3 — the retry loop must not swallow it
  });
});
