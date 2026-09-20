import { describe, expect, test } from "bun:test";
import { DeadlineExceededError, StageTimeoutError } from "../src/deadline.ts";
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

describe("restorePdfStructure and the checkpoint", () => {
  /** The bits of the checkpoint this stage uses, in memory. */
  function fakeCache(seed: Record<string, string> = {}, writeError?: unknown) {
    const store = new Map(Object.entries(seed));
    let flushes = 0;
    let retained: readonly string[] | null = null;
    return {
      store,
      get flushes() {
        return flushes;
      },
      get retained() {
        return retained;
      },
      writeError,
      get: (k: string) => store.get(k),
      set: (k: string, v: string) => {
        store.set(k, v);
      },
      flush: async () => {
        flushes += 1;
      },
      retain: (keys: readonly string[]) => {
        retained = keys;
      },
    };
  }

  const threePages = ["a".repeat(80), "b".repeat(80), "c".repeat(80)];
  const opts = { model: "m", pages: threePages, batchChars: 100 };

  test("reuses a batch the last run already restored", async () => {
    let calls = 0;
    const chat: ChatFn = async (request) => {
      calls += 1;
      return goodChat(request);
    };
    const cache = fakeCache({ [threePages[1] as string]: "## already done" });
    const result = await restorePdfStructure({ ...opts, chat, cache });
    expect(result.reused).toBe(1);
    // Two model calls, not three: the middle batch came off disk.
    expect(calls).toBe(2);
    expect(result.markdown).toContain("## already done");
  });

  test("checkpoints each restored batch as it goes", async () => {
    // Per batch, so a hard kill costs at most one batch of work.
    const cache = fakeCache();
    await restorePdfStructure({ ...opts, chat: goodChat, cache });
    expect(cache.store.size).toBe(3);
    // Three per-batch flushes, plus the one that persists the final prune.
    expect(cache.flushes).toBe(4);
  });

  test("checkpoints a fallback too, so it is not redone every run", async () => {
    // Without this a large PDF whose batches are slow and rejected stops at
    // the same place on every run and never finishes — ADR 0008's failure by a
    // third route. A batch that spent every attempt has reached its verdict.
    const cache = fakeCache();
    const chat: ChatFn = async () => "## Summary\n\nToo short.";
    const result = await restorePdfStructure({ ...opts, chat, cache });
    expect(result.fallbacks).toBe(3);
    expect(cache.store.size).toBe(3);
  });

  test("resumes a fallback without reporting the article as clean", async () => {
    // The reason a fallback is marked rather than stored plainly: the run that
    // produced it logged it, and a run that resumes must not count it among
    // the restored.
    const cache = fakeCache();
    const rejecting: ChatFn = async () => "## Summary\n\nToo short.";
    await restorePdfStructure({ ...opts, chat: rejecting, cache });

    let calls = 0;
    const counted: ChatFn = async (request) => {
      calls += 1;
      return goodChat(request);
    };
    const again = await restorePdfStructure({ ...opts, chat: counted, cache });
    // Nothing re-sent, and the article is still reported as unformatted.
    expect(calls).toBe(0);
    expect(again.reused).toBe(3);
    expect(again.fallbacks).toBe(3);
    // The raw text came back, not the marker.
    expect(again.markdown).not.toContain("fallback");
    expect(again.markdown).toContain("a".repeat(80));
  });

  test("a resumed restored batch is not counted as a fallback", async () => {
    const cache = fakeCache();
    await restorePdfStructure({ ...opts, chat: goodChat, cache });
    const again = await restorePdfStructure({ ...opts, chat: goodChat, cache });
    expect(again.reused).toBe(3);
    expect(again.fallbacks).toBe(0);
  });

  test("prunes to this document's batches once it finishes", async () => {
    const cache = fakeCache({ "an old batch": "from a previous version" });
    await restorePdfStructure({ ...opts, chat: goodChat, cache });
    expect(cache.retained).toEqual(threePages);
  });

  test("writes the prune to disk rather than only to memory", async () => {
    // retain() without a flush left the file holding every batch of every
    // version the document had ever had.
    const cache = fakeCache();
    let flushesAtRetain = -1;
    const watched = {
      ...cache,
      retain: (keys: readonly string[]) => {
        flushesAtRetain = cache.flushes;
        cache.retain(keys);
      },
    };
    await restorePdfStructure({ ...opts, chat: goodChat, cache: watched });
    expect(cache.flushes).toBeGreaterThan(flushesAtRetain);
  });

  test("does not prune when it stopped early", async () => {
    // A run that did not get back to every batch must not treat the ones it
    // skipped as gone.
    const cache = fakeCache();
    await restorePdfStructure({
      ...opts,
      chat: goodChat,
      cache,
      check: () => {
        throw new DeadlineExceededError("the next batch", -1);
      },
    }).catch(() => {});
    expect(cache.retained).toBeNull();
  });

  test("a budget stop that saved nothing is a hard failure, not a deferral", async () => {
    // Invariant 8's sharp edge: deferring tells the pipeline to retry work
    // that was never persisted, so the next run repeats these same batches,
    // and the one after that, while the log shows steady progress.
    const cache = fakeCache({}, new Error("EROFS"));
    const error = await restorePdfStructure({
      ...opts,
      chat: goodChat,
      cache,
      check: () => {
        throw new DeadlineExceededError("the next batch", -1);
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DeadlineExceededError);
    expect(String(error)).toMatch(/cannot resume/);
  });
});

describe("restorePdfStructure and the request budget", () => {
  const opts = {
    model: "m",
    pages: ["a".repeat(80), "b".repeat(80)],
    batchChars: 100,
  };

  test("demands a whole request's budget before each one", async () => {
    // "Is there any time left" let a batch begin with a millisecond to spare
    // and then run for a full request, overshooting the stage cap by one call.
    const needed: number[] = [];
    await restorePdfStructure({
      ...opts,
      chat: goodChat,
      requestMs: 120_000,
      check: (need) => needed.push(need),
    });
    expect(needed).toEqual([120_000, 120_000]);
  });

  test("asks again before a retry, not once per batch", async () => {
    // A batch may make several attempts and the chat client retries each, so
    // one check at the top of the batch admitted work that could finish long
    // after the cap it was admitted under.
    let checks = 0;
    const rejecting: ChatFn = async () => "## Summary\n\nToo short.";
    await restorePdfStructure({
      ...opts,
      pages: ["a".repeat(80)],
      chat: rejecting,
      requestMs: 1_000,
      check: () => {
        checks += 1;
      },
    });
    // One batch, two attempts, two checks.
    expect(checks).toBe(2);
  });

  test("stops between attempts when the budget goes", async () => {
    let checks = 0;
    const rejecting: ChatFn = async () => "## Summary\n\nToo short.";
    await expect(
      restorePdfStructure({
        ...opts,
        pages: ["a".repeat(80)],
        chat: rejecting,
        check: () => {
          checks += 1;
          if (checks > 1) throw new DeadlineExceededError("a retry", -1);
        },
      }),
    ).rejects.toThrow(DeadlineExceededError);
  });

  test("asks for nothing in particular when no request cost is given", async () => {
    const needed: number[] = [];
    await restorePdfStructure({
      ...opts,
      chat: goodChat,
      check: (need) => needed.push(need),
    });
    expect(needed).toEqual([0, 0]);
  });
});

describe("restorePdfStructure and the stage cap inside a call", () => {
  const opts = { model: "m", pages: ["a".repeat(80)], batchChars: 100 };

  test("stops when one call outlives the stage", async () => {
    // The check before a request cannot bound what happens after it: the chat
    // client retries inside a single call and knows only the run's deadline,
    // so a batch admitted with room to spare could return long after the cap.
    const never: ChatFn = () => new Promise(() => {});
    await expect(
      restorePdfStructure({ ...opts, chat: never, remainingMs: () => 10 }),
    ).rejects.toThrow(StageTimeoutError);
  });

  test("does not retry a stage timeout as though the request had failed", async () => {
    // Retrying on a blown clock burns the very budget it is out of, and would
    // turn the cap into a suggestion.
    let calls = 0;
    const never: ChatFn = () => {
      calls += 1;
      return new Promise(() => {});
    };
    await restorePdfStructure({
      ...opts,
      chat: never,
      maxAttempts: 3,
      remainingMs: () => 10,
    }).catch(() => {});
    expect(calls).toBe(1);
  });

  test("reports a blown run budget as a deferral, not a stage failure", async () => {
    // The timer is set to whichever clock is nearer and does not record which,
    // so the two have to be told apart afterwards — and they want opposite
    // handling: the run's budget defers the article with the run's work
    // committed, the stage's fails this one.
    const never: ChatFn = () => new Promise(() => {});
    await expect(
      restorePdfStructure({
        ...opts,
        chat: never,
        remainingMs: () => 10,
        check: () => {
          throw new DeadlineExceededError("the run", -1);
        },
      }),
    ).rejects.toThrow(DeadlineExceededError);
  });

  test("aborts the request rather than only giving up on it", async () => {
    // Racing alone stopped this function waiting while the client kept
    // retrying underneath. The signal is what ends the work.
    let aborted = false;
    const watching: ChatFn = (_request, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    await restorePdfStructure({
      ...opts,
      chat: watching,
      remainingMs: () => 10,
    }).catch(() => {});
    expect(aborted).toBe(true);
  });

  test("leaves a call alone while the stage still has time", async () => {
    const result = await restorePdfStructure({
      ...opts,
      chat: goodChat,
      remainingMs: () => 60_000,
    });
    expect(result.fallbacks).toBe(0);
  });
});
