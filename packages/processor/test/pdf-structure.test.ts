import { describe, expect, test } from "bun:test";
import { DeadlineExceededError } from "../src/deadline.ts";
import type { ChatFn } from "../src/llm/client.ts";
import {
  batchPages,
  rejectReason,
  restorePdfStructure,
} from "../src/llm/pdf-structure.ts";

const PAGE = (n: number) =>
  `Section ${n}\nThe method is straightforward to imple-\nment and efficient in page ${n}.`;

/** A well-behaved model: rejoins hyphens, marks the heading, keeps every word. */
const goodChat: ChatFn = async (request) => {
  const user = request.messages.find((m) => m.role === "user")?.content ?? "";
  return user
    .replace(/-\n/g, "")
    .split("\n")
    .map((line) => (/^Section \d+$/.test(line) ? `## ${line}` : line))
    .join("\n");
};

describe("batchPages", () => {
  test("groups pages up to the batch size", () => {
    const batches = batchPages(["a".repeat(40), "b".repeat(40)], 100);
    expect(batches).toHaveLength(1);
  });

  test("starts a new batch rather than splitting a page", () => {
    const batches = batchPages(["a".repeat(60), "b".repeat(60)], 100);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toBe("a".repeat(60));
  });

  test("sends a page larger than the batch size on its own", () => {
    // Never split: a page is the boundary the source has, and a seam invented
    // mid-page is one the model would have to guess across.
    const batches = batchPages(["a".repeat(500), "b".repeat(10)], 100);
    expect(batches[0]).toBe("a".repeat(500));
    expect(batches[1]).toBe("b".repeat(10));
  });

  test("drops pages that are entirely blank", () => {
    expect(batchPages(["   ", "\n"], 100)).toEqual([]);
  });
});

describe("rejectReason", () => {
  const input = "The method is straightforward to implement and efficient.";

  test("accepts a faithful restructuring", () => {
    expect(rejectReason(input, `## Heading\n\n${input}`)).toBeNull();
  });

  test("refuses an empty reply", () => {
    expect(rejectReason(input, "   ")).toBe("empty reply");
  });

  test("refuses a rebuilt markdown table", () => {
    // ADR 0026 clause 5: a blank cell and an absent cell are the same bytes in
    // a text layer, so a rebuilt row is a guess that reads as data.
    const reply = `${input}\n\n| Model | BLEU |\n| --- | --- |\n| A | 1 |`;
    expect(rejectReason(input, reply)).toBe("rebuilt a markdown table");
  });

  test("refuses a summary wearing Markdown", () => {
    // The failure this whole guard exists for: clean output that says less.
    const reason = rejectReason(input, "## Summary\n\nA method.");
    expect(reason).toMatch(/dropped content/);
  });

  test("refuses a reply that invented content", () => {
    const reason = rejectReason(input, `${input} ${input}`);
    expect(reason).toMatch(/added content/);
  });

  test("ignores markdown syntax when measuring content", () => {
    // Only letters and digits count, so adding #, *, and blank lines is free.
    expect(rejectReason(input, `# T\n\n## S\n\n- ${input}`)).toBeNull();
  });
});

describe("restorePdfStructure", () => {
  const base = { model: "m", pages: [PAGE(1), PAGE(2)] };

  test("restores structure across pages", async () => {
    const result = await restorePdfStructure({ ...base, chat: goodChat });
    expect(result.fallbacks).toBe(0);
    expect(result.markdown).toContain("## Section 1");
    // The hyphenated break was rejoined.
    expect(result.markdown).toContain("implement");
    expect(result.markdown).not.toContain("imple-");
  });

  test("keeps the extracted text when the model summarizes", async () => {
    const chat: ChatFn = async () => "## Summary\n\nA short note.";
    const logs: string[] = [];
    const result = await restorePdfStructure({
      ...base,
      chat,
      log: (m) => logs.push(m),
    });
    expect(result.fallbacks).toBe(1);
    // Unformatted but whole — every word the extraction found is still there.
    expect(result.markdown).toContain("imple-");
    expect(result.markdown).toContain("page 2");
    expect(logs.some((m) => /dropped content/.test(m))).toBe(true);
  });

  test("retries before falling back", async () => {
    let calls = 0;
    const chat: ChatFn = async (request) => {
      calls += 1;
      if (calls === 1) return "nope";
      return goodChat(request);
    };
    const result = await restorePdfStructure({ ...base, chat });
    expect(calls).toBe(2);
    expect(result.fallbacks).toBe(0);
    expect(result.markdown).toContain("## Section 1");
  });

  test("falls back rather than accepting a rebuilt table", async () => {
    const chat: ChatFn = async (request) => {
      const user =
        request.messages.find((m) => m.role === "user")?.content ?? "";
      return `${user}\n\n| A | B |\n| --- | --- |\n| 1 | 2 |`;
    };
    const result = await restorePdfStructure({ ...base, chat });
    expect(result.fallbacks).toBe(1);
    expect(result.markdown).not.toContain("| --- |");
  });

  test("survives a provider that throws", async () => {
    // Per-article fault isolation (invariant 7): a dead provider costs
    // formatting, never the article.
    const chat: ChatFn = async () => {
      throw new Error("502 upstream");
    };
    const result = await restorePdfStructure({ ...base, chat });
    expect(result.fallbacks).toBe(1);
    expect(result.markdown).toContain("Section 1");
  });

  test("asks for no sampling", async () => {
    // Restructuring has one right answer; temperature only invents.
    let temperature: number | undefined;
    const chat: ChatFn = async (request) => {
      temperature = request.temperature;
      return goodChat(request);
    };
    await restorePdfStructure({ ...base, chat });
    expect(temperature).toBe(0);
  });
});

describe("restorePdfStructure and the run budget", () => {
  const base = { model: "m", pages: [PAGE(1), PAGE(2)] };

  test("lets a blown budget out rather than booking it as a failed batch", async () => {
    // The bug this replaced: DeadlineExceededError was caught with everything
    // else, so a run that ran out of time produced a finished-looking article
    // made mostly of fallbacks — and marked it processed.
    const chat: ChatFn = async () => {
      throw new DeadlineExceededError("a chat request", -1);
    };
    await expect(restorePdfStructure({ ...base, chat })).rejects.toThrow(
      DeadlineExceededError,
    );
  });

  test("still treats an ordinary provider error as a failed batch", async () => {
    const chat: ChatFn = async () => {
      throw new Error("502 upstream");
    };
    const result = await restorePdfStructure({ ...base, chat });
    expect(result.fallbacks).toBe(1);
  });

  test("asks the caller before each batch", async () => {
    const seen: string[] = [];
    await restorePdfStructure({
      ...base,
      pages: ["a".repeat(80), "b".repeat(80), "c".repeat(80)],
      batchChars: 100,
      chat: goodChat,
      check: (_need, what) => seen.push(what),
    });
    expect(seen).toHaveLength(3);
    expect(seen[0]).toContain("batch 1 of 3");
  });

  test("stops where the caller says stop", async () => {
    let calls = 0;
    await expect(
      restorePdfStructure({
        ...base,
        // Three batches, so there is a second one to be stopped before.
        pages: ["a".repeat(80), "b".repeat(80), "c".repeat(80)],
        batchChars: 100,
        chat: goodChat,
        check: () => {
          calls += 1;
          if (calls > 1) throw new DeadlineExceededError("the next batch", -1);
        },
      }),
    ).rejects.toThrow(DeadlineExceededError);
  });
});
