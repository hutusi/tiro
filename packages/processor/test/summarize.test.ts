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
      JSON.stringify({ summary: "摘要。", category: "ai", tags: ["a"] }),
    ]);
    const result = await summarize({ ...baseOptions, chat });
    expect(result).toEqual({
      summary: "摘要。",
      category: "ai",
      tags: ["a"],
      failed: false,
    });
  });

  /**
   * The shape that reached the vault 13 times: valid JSON, a real category and
   * tags, and a `summary` that stops mid-clause. `z.string().min(1)` accepts
   * it, and the summary is the one field no later stage reads — so it goes to
   * the page and the meta description exactly as the model left it.
   */
  test("retries a summary that stops mid-sentence", async () => {
    const { chat, calls } = scripted([
      JSON.stringify({
        summary: "本文提出了三个论点，第一个是",
        category: "ai",
        tags: ["a"],
      }),
      JSON.stringify({ summary: "完整的摘要。", category: "ai", tags: ["a"] }),
    ]);
    const result = await summarize({ ...baseOptions, chat });
    expect(result.summary).toBe("完整的摘要。");
    expect(result.failed).toBe(false);
    expect(calls()).toBe(2);
  });

  test("tells the model what it cut, so the correction has a referent", async () => {
    const seen: string[] = [];
    let i = 0;
    const chat: ChatFn = async ({ messages }) => {
      for (const m of messages) if (m.role === "user") seen.push(m.content);
      i += 1;
      return JSON.stringify(
        i === 1
          ? { summary: "第一个论点是", category: "ai", tags: [] }
          : { summary: "完整的摘要。", category: "ai", tags: [] },
      );
    };
    await summarize({ ...baseOptions, chat });
    expect(seen.at(-1)).toContain("第一个论点是");
    expect(seen.at(-1)).toContain("stopped mid-sentence");
  });

  /**
   * Both halves of the decision, which pull in opposite directions. The text is
   * *kept* — dropping to the excerpt fallback would trade the model's reading
   * of the article for its own first paragraph, to fix punctuation — and the
   * article is *marked* anyway, because 13 of these reached the vault precisely
   * because nothing was written down and a run log scrolls away.
   */
  test("keeps the longest cut summary and still marks it", async () => {
    const { chat } = scripted([
      JSON.stringify({ summary: "短的", category: "ai", tags: ["a"] }),
      JSON.stringify({
        summary: "长一些的摘要，但仍然没有写完",
        category: "ai",
        tags: ["a"],
      }),
      JSON.stringify({ summary: "又短了", category: "ai", tags: ["a"] }),
    ]);
    const result = await summarize({ ...baseOptions, chat });
    // Not the excerpt fallback, which would be the body's first paragraph.
    expect(result.summary).toBe("长一些的摘要，但仍然没有写完");
    expect(result.category).toBe("ai");
    expect(result.tags).toEqual(["a"]);
    expect(result.failed).toBe(true);
  });

  /**
   * An ellipsis is what trailing off looks like, so accepting it let the exact
   * shape this guards against through on the first attempt. No model-written
   * summary in the vault ends in one; the only ones that do are
   * `excerptFallback`'s own, which never reaches the predicate.
   */
  test.each([
    ["a Chinese ellipsis", "本文提出了三个论点，第一个是…"],
    ["a doubled one", "本文提出了三个论点，第一个是……"],
    ["three ASCII dots", "The article argues that..."],
  ])("retries a summary ending in %s", async (_name, cut) => {
    const { chat, calls } = scripted([
      JSON.stringify({ summary: cut, category: "ai", tags: [] }),
      JSON.stringify({ summary: "完整的摘要。", category: "ai", tags: [] }),
    ]);
    const result = await summarize({ ...baseOptions, chat });
    expect(result.summary).toBe("完整的摘要。");
    expect(calls()).toBe(2);
  });

  test.each([
    ["Chinese full stop", "摘要。"],
    ["a closing quote after it", "他说“这很重要”。"],
    ["a question mark", "这是什么？"],
    ["an English period", "A finished summary."],
    ["a decimal point mid-sentence", "成本下降了 1.5 倍。"],
    ["a bracket after the stop", "见下文（附录）。"],
  ])("accepts a summary ending in %s", async (_name, summary) => {
    const { chat, calls } = scripted([
      JSON.stringify({ summary, category: "ai", tags: [] }),
    ]);
    const result = await summarize({ ...baseOptions, chat });
    expect(result.summary).toBe(summary);
    expect(calls()).toBe(1);
  });

  /**
   * Both marked outcomes set `tiro.summary_failed`, so the log is the only
   * thing that says which one an article is holding — a short summary, or the
   * body's first paragraph. The runbook indexes these exact strings, and it
   * already named one the code had stopped emitting, so they are asserted here
   * rather than left to agree by habit.
   */
  test("says which outcome it settled on when every attempt failed", async () => {
    const lines: string[] = [];
    const cut = JSON.stringify({
      summary: "本文提出了三个论点，第一个是",
      category: "ai",
      tags: [],
    });
    const { chat } = scripted([cut, cut, cut]);
    await summarize({ ...baseOptions, chat, log: (m) => lines.push(m) });
    expect(lines.at(-1)).toContain("summary unfinished after 3 attempts");

    const bad: string[] = [];
    const { chat: broken } = scripted(["nope", "nope", "nope"]);
    await summarize({ ...baseOptions, chat: broken, log: (m) => bad.push(m) });
    expect(bad.at(-1)).toContain("summary unusable after 3 attempts");
  });

  /**
   * The claim the old line made and could not support: `unfinished` holds the
   * best *cut* reply, but the other attempts may have failed for unrelated
   * reasons, so "every attempt stopped mid-sentence" was sometimes false.
   */
  test("does not claim every attempt was cut when only one was", async () => {
    const lines: string[] = [];
    const { chat } = scripted([
      "not json at all",
      JSON.stringify({ summary: "只有这次被截断了", category: "ai", tags: [] }),
      JSON.stringify({
        summary: "仍然没写完",
        category: "wrong-category",
        tags: [],
      }),
    ]);
    const result = await summarize({
      ...baseOptions,
      chat,
      log: (m) => lines.push(m),
    });
    expect(result.summary).toBe("只有这次被截断了");
    expect(lines.at(-1)).toContain("keeping the longest cut reply");
    expect(lines.at(-1)).not.toContain("every");
  });

  test("retries invalid JSON and then succeeds", async () => {
    const { chat, calls } = scripted([
      "not json at all",
      JSON.stringify({ summary: "摘要。", category: "tech", tags: [] }),
    ]);
    const result = await summarize({ ...baseOptions, chat });
    expect(result.failed).toBe(false);
    expect(result.category).toBe("tech");
    expect(calls()).toBe(2);
  });

  test("retries an off-taxonomy category", async () => {
    const { chat } = scripted([
      JSON.stringify({ summary: "摘要。", category: "sports", tags: [] }),
      JSON.stringify({ summary: "摘要。", category: "other", tags: [] }),
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
      return JSON.stringify({ summary: "s.", category: "ai", tags: [] });
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
      return JSON.stringify({ summary: "摘要。", category: "ai", tags: [] });
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
        summary: "摘要。",
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
      JSON.stringify({ summary: "摘要。", category: "ai", tags: ["a"] }),
    ]);
    const result = await summarize({ ...baseOptions, chat, bilingual: true });
    expect(result.failed).toBe(false);
    expect(result.summary).toBe("摘要。");
    expect(result.titleZh).toBeUndefined();
    expect(calls()).toBe(1);
  });

  test("drops a title the model echoed in the source language", async () => {
    const { chat } = scripted([
      JSON.stringify({
        summary: "摘要。",
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
        summary: "摘要。",
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
        summary: "摘要。",
        category: "ai",
        tags: [],
        summary_orig: "摘要。",
      }),
    ]);
    const result = await summarize({ ...baseOptions, chat, bilingual: true });
    expect(result.summaryOrig).toBeUndefined();
  });

  test("ignores a pair volunteered for an article already in the target language", async () => {
    const { chat } = scripted([
      JSON.stringify({
        summary: "摘要。",
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

  // The shape that shipped a broken summary: an article opening with a linked
  // hero image. That paragraph renders as nothing, so it is not the summary.
  test("the fallback skips a paragraph that is only a picture", async () => {
    const { chat } = scripted(["nope", "still nope", "nope again"]);
    const result = await summarize({
      ...baseOptions,
      chat,
      body: [
        "[![](./assets/921bcc8d8398.jpg)](https://cdn.example.com/hero.png)",
        "",
        "This is the first sentence a reader actually sees.",
      ].join("\n"),
    });
    expect(result.failed).toBe(true);
    expect(result.summary).toBe(
      "This is the first sentence a reader actually sees.",
    );
  });

  // `block.text` is exact source, but the site prints a summary as plain text
  // and into `<meta name="description">` — so the syntax must not survive.
  test("the fallback returns prose, not markdown source", async () => {
    const { chat } = scripted(["nope", "still nope", "nope again"]);
    const result = await summarize({
      ...baseOptions,
      chat,
      body: "A **bold** claim with a [link](https://example.com) and `code`.",
    });
    expect(result.summary).toBe("A bold claim with a link and code.");
  });

  // A body with no prose at all still has to produce something: an empty
  // summary is one the frontmatter schema accepts silently.
  test("the fallback uses the title when no paragraph reads as prose", async () => {
    const { chat } = scripted(["nope", "still nope", "nope again"]);
    const result = await summarize({
      ...baseOptions,
      chat,
      title: "Only Pictures",
      body: "![](./assets/a.jpg)\n\n![](./assets/b.jpg)",
    });
    expect(result.summary).toBe("Only Pictures");
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
      JSON.stringify({ summary: "摘要。", category: "ai", tags: [] }),
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
