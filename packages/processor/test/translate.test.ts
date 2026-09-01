import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

  test("never sends math to the model and copies it byte-identically", async () => {
    const mathBody = [
      "Einstein's result.",
      "",
      "$$",
      "E = mc^2 \\qquad \\text{for } m \\in \\mathbb{R}",
      "$$",
      "",
      "$$F = ma$$",
      "",
      "Closing paragraph.",
      "",
    ].join("\n");
    const mathBlocks = splitBlocks(mathBody);
    // The lone `$$F = ma$$` line is a paragraph holding one inline-math node,
    // not a math block — the case a type check alone would miss.
    expect(mathBlocks.map((b) => b.type)).toEqual([
      "paragraph",
      "math",
      "paragraph",
      "paragraph",
    ]);

    const seen: string[] = [];
    const chat = makeFakeChat({
      onRequest: (r) => seen.push(r.messages.at(-1)?.content ?? ""),
    });
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks: mathBlocks,
    });
    expect(zh).not.toBeNull();
    const zhBlocks = splitBlocks(zh ?? "");
    expect(zhBlocks.map((b) => b.type)).toEqual(mathBlocks.map((b) => b.type));
    expect(zhBlocks[1]?.text).toBe(mathBlocks[1]?.text);
    expect(zhBlocks[2]?.text).toBe("$$F = ma$$");
    const sent = seen.join("\n");
    expect(sent).not.toContain("mc^2");
    expect(sent).not.toContain("F = ma");
    expect(sent).toContain("Einstein's result.");
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

  test("repairs a block whose translation changed shape, keeping the rest", async () => {
    // A translation that splits one block into two used to reject the whole
    // article. Now that block alone reverts to the original — one untranslated
    // block instead of no translation at all.
    const chat: ChatFn = async (request) => {
      const user =
        request.messages.find((m) => m.role === "user")?.content ?? "";
      if (user.includes("<<<TIRO_BLOCK_")) {
        const matches = [...user.matchAll(/<<<TIRO_BLOCK_(\d+)>>>/g)];
        return matches
          .map((m) => `<<<TIRO_BLOCK_${m[1]}>>>\n翻译。\n\n多出来的一段。`)
          .join("\n");
      }
      return "翻译。\n\n多出来的一段。";
    };
    const logs: string[] = [];
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks,
      log: (m) => logs.push(m),
    });
    expect(zh).not.toBeNull();
    const out = splitBlocks(zh ?? "");
    expect(out.map((b) => b.text)).toEqual(blocks.map((b) => b.text));
    expect(logs.join("\n")).toContain("reverted to the original");
  });

  test("the alignment gate still refuses a body that only breaks once joined", async () => {
    // Per-block checks cannot see interactions between blocks. Two lists with
    // different bullets are two blocks; translations that normalise the bullet
    // each parse as one list alone, but merge into a single list when joined.
    // The gate stays as the backstop for that.
    const twoLists = splitBlocks("- alpha\n\n* beta");
    expect(twoLists.map((b) => b.type)).toEqual(["list", "list"]);
    const chat: ChatFn = async (request) => {
      const user =
        request.messages.find((m) => m.role === "user")?.content ?? "";
      if (user.includes("<<<TIRO_BLOCK_")) {
        const matches = [...user.matchAll(/<<<TIRO_BLOCK_(\d+)>>>/g)];
        return matches
          .map((m) => `<<<TIRO_BLOCK_${m[1]}>>>\n-   译文`)
          .join("\n");
      }
      return "-   译文";
    };
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks: twoLists,
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

  test("keeps the checkpoint after translating — the caller owns dropping it", async () => {
    // Deliberate: zh.md and index.md are still unwritten at this point, and a
    // kill in that window would lose every translated block while leaving the
    // article pending. The pipeline drops it once index.md lands; see the
    // run-budget suite in pipeline.test.ts for the other half.
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
    expect(existsSync(path)).toBe(true);
  });

  test("keeps the checkpoint on misalignment too", async () => {
    // Uses the join-merge case, since a per-block shape change is now repaired
    // rather than fatal.
    const chat: ChatFn = async () => "-   译文";
    const path = cachePath();
    const cache = await loadTranslationCache(path, header);
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks: splitBlocks("- alpha\n\n* beta"),
      cache,
    });
    expect(zh).toBeNull();
    // The pipeline still writes index.md on this path (marking
    // translation_failed) and clears it there, so the misaligned blocks are
    // not resumed and the failure cannot become permanent.
    expect(existsSync(path)).toBe(true);
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
  });
  test("a checkpoint with a non-string entry translates from scratch, not crashes", async () => {
    // End of the path the cache-level guard closes: before it, this threw
    // TypeError out of the join below, which left the article pending and
    // re-threw from the same file on every later run.
    const path = cachePath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        target: "zh",
        model: "m",
        blocks: { [`${"a".repeat(64)}`]: 42 },
      }),
    );
    const zh = await translateBlocks({
      chat: makeFakeChat(),
      model: "m",
      targetLang: "zh",
      blocks,
      cache: await loadTranslationCache(path, header),
    });
    expect(zh).not.toBeNull();
    expect(splitBlocks(zh ?? "")[1]?.text).toBe("中文：First paragraph.");
  });
  test("refuses to call it a deferral when nothing could be checkpointed", async () => {
    // The budget stop is the moment the run starts depending on the checkpoint.
    // Reporting an orderly "resuming next run" with nothing on disk would have
    // the next run repeat these same batches, and the one after that, while the
    // log showed steady progress.
    const path = cachePath();
    mkdirSync(join(`${path}.tmp`, "wedged"), { recursive: true });

    let clock = 0;
    const deadline = createDeadline(100, () => clock);
    const chat: ChatFn = async (request) => {
      clock += 60;
      return makeFakeChat()(request);
    };

    const error = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks: manyBlocks,
      batchChars: 1,
      cache: await loadTranslationCache(path, header),
      deadline,
    }).catch((e) => e);

    // A hard fault, not a budget deferral: the pipeline books the former as an
    // error and never claims the article will resume.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DeadlineExceededError);
    expect(String(error)).toContain("cannot resume");
    expect(String(error)).toContain("checkpoint could not be written");
  });

  test("an article that finishes in one run does not care that writes failed", async () => {
    // The other half of the rule: a checkpoint is only load-bearing for work
    // that has to survive the run. This article never reads it back, so an
    // unwritable path must not fail it.
    const path = cachePath();
    mkdirSync(join(`${path}.tmp`, "wedged"), { recursive: true });
    const zh = await translateBlocks({
      chat: makeFakeChat(),
      model: "m",
      targetLang: "zh",
      blocks,
      cache: await loadTranslationCache(path, header),
    });
    expect(zh).not.toBeNull();
    expect(splitBlocks(zh ?? "")[1]?.text).toBe("中文：First paragraph.");
  });
  test("a deadline that expires inside a call is caught by the same guard", async () => {
    // The hole: the pre-call check knew about the failed write, but a budget
    // that runs out *during* a request raises DeadlineExceededError from the
    // chat client and used to sail straight past. The pipeline then reported a
    // resumable skip and "checkpoint saved" with nothing on disk. Two places
    // were answering one question and only one of them had the facts.
    const path = cachePath();
    mkdirSync(join(`${path}.tmp`, "wedged"), { recursive: true });

    let calls = 0;
    const healthy = makeFakeChat();
    const chat: ChatFn = async (request) => {
      calls += 1;
      // First batch lands, so a flush is attempted and fails; the next request
      // dies in flight, exactly as a clamped request does at the budget edge.
      if (calls > 1) {
        throw new DeadlineExceededError("a chat completions request", -1);
      }
      return healthy(request);
    };

    const error = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks: manyBlocks,
      batchChars: 1,
      cache: await loadTranslationCache(path, header),
      // Deliberately unexpired: only the in-flight path can be what converts.
    }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DeadlineExceededError);
    expect(String(error)).toContain("cannot resume");
    // The original still names the batch that was reached.
    expect((error as Error).cause).toBeInstanceOf(DeadlineExceededError);
  });

  test("an in-flight deadline with a healthy checkpoint stays a deferral", async () => {
    // No over-conversion: with work actually persisted, this is the ordinary
    // resumable stop and must keep its type so the pipeline defers rather than
    // reporting a fault.
    const path = cachePath();
    let calls = 0;
    const healthy = makeFakeChat();
    const chat: ChatFn = async (request) => {
      calls += 1;
      if (calls > 1) {
        throw new DeadlineExceededError("a chat completions request", -1);
      }
      return healthy(request);
    };

    const error = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks: manyBlocks,
      batchChars: 1,
      cache: await loadTranslationCache(path, header),
    }).catch((e) => e);

    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect(existsSync(path)).toBe(true); // and there really is progress saved
  });
});

describe("translateBlocks fidelity", () => {
  test("an indented code block survives byte-identically", async () => {
    // Regression: the join used to trim every block, including ones never sent
    // anywhere. That strips the four-space indent off an indented code block,
    // which re-parses as a paragraph and fails the alignment gate — so a real
    // article lost its whole translation over a block nothing had touched.
    const source = [
      "A paragraph.",
      "",
      "    ![](./assets/cad4b351ef84.avif)",
      "",
      "Another paragraph.",
    ].join("\n");
    const src = splitBlocks(source);
    expect(src[1]?.type).toBe("code"); // indented, not fenced

    const zh = await translateBlocks({
      chat: makeFakeChat(),
      model: "m",
      targetLang: "zh",
      blocks: src,
    });
    expect(zh).not.toBeNull();
    const out = splitBlocks(zh ?? "");
    expect(out.map((b) => b.type)).toEqual(src.map((b) => b.type));
    expect(out[1]?.text).toBe(src[1]?.text); // indent intact
  });

  test("a batch that fails in transport falls back to per-block", async () => {
    // One slow or oversized batch used to end the article, and with the
    // checkpoint resuming at that same batch it would end every later run too.
    let batchAttempts = 0;
    const fallback = makeFakeChat();
    const chat: ChatFn = async (request) => {
      const user =
        request.messages.find((m) => m.role === "user")?.content ?? "";
      if (user.includes("<<<TIRO_BLOCK_")) {
        batchAttempts += 1;
        throw new Error("HTTP 502 from the provider");
      }
      return fallback(request);
    };
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks,
    });
    expect(batchAttempts).toBeGreaterThan(0);
    expect(zh).not.toBeNull();
    expect(splitBlocks(zh ?? "")[1]?.text).toBe("中文：First paragraph.");
  });

  test("budget exhaustion is not retried block by block", async () => {
    // The fallback must not apply to a deferral: retrying per-block would
    // spend budget the run has already run out of.
    const chat: ChatFn = async () => {
      throw new DeadlineExceededError("a chat completions request", -1);
    };
    await expect(
      translateBlocks({ chat, model: "m", targetLang: "zh", blocks }),
    ).rejects.toThrow(DeadlineExceededError);
  });

  test("a block too large to send is kept untranslated rather than blocking", async () => {
    // A single top-level block is never split — it is the unit alignment is
    // built on — so an oversized one would be sent alone and never succeed.
    // A 47K-char arXiv bibliography is the real case.
    const huge = Array.from(
      { length: 400 },
      (_, i) => `-   Reference ${i}`,
    ).join("\n");
    const src = splitBlocks(`Intro paragraph.\n\n${huge}\n\nOutro paragraph.`);
    const seen: string[] = [];
    const zh = await translateBlocks({
      chat: makeFakeChat({
        onRequest: (r) => seen.push(r.messages.at(-1)?.content ?? ""),
      }),
      model: "m",
      targetLang: "zh",
      blocks: src,
      maxBlockChars: 2_000,
    });

    expect(zh).not.toBeNull();
    const out = splitBlocks(zh ?? "");
    expect(out.map((b) => b.type)).toEqual(src.map((b) => b.type));
    // Passed through exactly, and never sent.
    expect(out[1]?.text).toBe(src[1]?.text);
    expect(seen.join("\n")).not.toContain("Reference 399");
    // The surrounding blocks still translate.
    expect(out[0]?.text).toBe("中文：Intro paragraph.");
  });
});

describe("inline math through translation", () => {
  const mathBlocks = splitBlocks("The variance $d_k$ grows as $O(n^2)$ here.");

  test("never shows the model the LaTeX, and puts it back verbatim", () => {
    return (async () => {
      const seen: string[] = [];
      const zh = await translateBlocks({
        chat: makeFakeChat({
          onRequest: (r) => seen.push(r.messages.at(-1)?.content ?? ""),
        }),
        model: "m",
        targetLang: "zh",
        blocks: mathBlocks,
        singleDollarMath: true,
      });
      const sent = seen.join("\n");
      expect(sent).not.toContain("d_k");
      expect(sent).not.toContain("O(n^2)");
      expect(sent).toContain("TIROMATH0");
      expect(zh).toContain("$d_k$");
      expect(zh).toContain("$O(n^2)$");
    })();
  });

  test("reverts the block when the model mangles a formula", async () => {
    // The exact case a reviewer reproduced: $E=mc^2$ came back as $E=mc^3$,
    // passed alignment because the block was still a paragraph, and published.
    const blocks = splitBlocks("Einstein showed $E=mc^2$ holds.");
    const chat: ChatFn = async (request) => {
      const user = request.messages.at(-1)?.content ?? "";
      const marker = user.match(/<<<TIRO_BLOCK_\d+>>>/)?.[0] ?? "";
      // A model that ignored the mask and wrote its own formula.
      return `${marker}\n爱因斯坦证明 $E=mc^3$ 成立。`;
    };
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks,
      singleDollarMath: true,
    });
    expect(zh).not.toContain("mc^3");
    expect(zh?.trim()).toBe("Einstein showed $E=mc^2$ holds.");
  });

  test("reverts when the model unescapes a literal dollar into a formula", async () => {
    const blocks = splitBlocks("It costs \\$5 to \\$10 with $x$ users.");
    const chat: ChatFn = async (request) => {
      const user = request.messages.at(-1)?.content ?? "";
      const marker = user.match(/<<<TIRO_BLOCK_\d+>>>/)?.[0] ?? "";
      return `${marker}\n费用为 $5 到 $10，有 TIROMATH0 位用户。`;
    };
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks,
      singleDollarMath: true,
    });
    expect(zh?.trim()).toBe("It costs \\$5 to \\$10 with $x$ users.");
  });

  test("leaves prose dollars alone when the article did not declare math", async () => {
    // singleDollarMath off: "$5 to $" is not a formula, so nothing is masked
    // and the price paragraph translates normally.
    const seen: string[] = [];
    const zh = await translateBlocks({
      chat: makeFakeChat({
        onRequest: (r) => seen.push(r.messages.at(-1)?.content ?? ""),
      }),
      model: "m",
      targetLang: "zh",
      blocks: splitBlocks("The API costs $5 to $10 per month."),
      singleDollarMath: false,
    });
    expect(seen.join("\n")).not.toContain("TIROMATH");
    expect(zh).toContain("中文");
  });
});

describe("token substitution", () => {
  /** A model that translates the prose and leaves every token untouched. */
  const echoTokens: ChatFn = async (request) => {
    const user = request.messages.at(-1)?.content ?? "";
    return user.replace(
      /(<<<TIRO_BLOCK_\d+>>>\n)([\s\S]*?)(?=<<<TIRO_BLOCK_|$)/g,
      (_m, marker, body) => `${marker}译:${body}`,
    );
  };

  test("survives more than ten formulas in one block", async () => {
    // TIROMATH1 is a prefix of TIROMATH10 unless the tokens are padded, so the
    // uniqueness check saw a duplicate and reverted the whole paragraph.
    const formulas = Array.from({ length: 11 }, (_, i) => `$x_{${i}}$`);
    const text = `Given ${formulas.join(" and ")} we conclude.`;
    const zh = await translateBlocks({
      chat: echoTokens,
      model: "m",
      targetLang: "zh",
      blocks: splitBlocks(text),
      singleDollarMath: true,
    });
    expect(zh).toContain("译:");
    for (const formula of formulas) expect(zh).toContain(formula);
  });

  test("restores formulas containing replacement syntax literally", async () => {
    // $$, $&, $` and $' are all String.replace syntax and all occur in LaTeX.
    for (const formula of ["$$O(n)$$", "$a$&$b$", "$x`y$"]) {
      const zh = await translateBlocks({
        chat: echoTokens,
        model: "m",
        targetLang: "zh",
        blocks: splitBlocks(`Given ${formula} we conclude.`),
        singleDollarMath: true,
      });
      expect(zh).toContain(formula);
      expect(zh).not.toContain("TIROMATH");
    }
  });

  test("masks display math nested in a list", async () => {
    // The block is a `list`, so it is not verbatim; without the walker seeing
    // one level down, the formula went to the model raw.
    const seen: string[] = [];
    const source = "- First item\n\n  $$\n  E=mc^2\n  $$\n\n- Second item";
    const zh = await translateBlocks({
      chat: async (request) => {
        seen.push(request.messages.at(-1)?.content ?? "");
        return echoTokens(request);
      },
      model: "m",
      targetLang: "zh",
      blocks: splitBlocks(source),
      singleDollarMath: true,
    });
    expect(seen.join("\n")).not.toContain("E=mc^2");
    expect(seen.join("\n")).toContain("TIROMATH0000");
    expect(zh).toContain("$$\n  E=mc^2\n  $$");
    expect(splitBlocks(zh ?? "").map((b) => b.type)).toEqual(["list"]);
  });
});

describe("figure captions", () => {
  const figure =
    '<figure><img src="./assets/a.png" alt="A diagram"><figcaption>A caption worth reading.</figcaption></figure>';

  /**
   * A model that translates the prose it is given and leaves the sentinel
   * tokens where they are — the same assumption `maskMath` already makes of
   * every formula it hides.
   */
  const tokenPreservingChat: ChatFn = async (request) => {
    const user = request.messages.find((m) => m.role === "user")?.content ?? "";
    return user.replace(
      /(<<<TIRO_BLOCK_\d+>>>\n)([\s\S]*?)(?=<<<TIRO_BLOCK_|$)/g,
      (_m, marker: string, body: string) =>
        marker +
        body
          .split(/(TIROMATH\d{4})/)
          .map((part) =>
            /^TIROMATH\d{4}$/.test(part) || part.trim() === "" ? part : "译文",
          )
          .join(""),
    );
  };

  test("translates the caption and restores the markup byte-for-byte", async () => {
    const sent: string[] = [];
    const chat: ChatFn = async (request) => {
      sent.push(request.messages.at(-1)?.content ?? "");
      return tokenPreservingChat(request);
    };
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks: splitBlocks(figure),
    });
    const out = zh ?? "";
    // The scaffolding is masked, so the model never sees the image path and
    // cannot rewrite it. checkAlignment would not catch that if it did: an
    // html block is compared by type, not by bytes.
    expect(sent.join("\n")).not.toContain("./assets/a.png");
    expect(sent.join("\n")).not.toContain("<figcaption>");
    // It comes back intact, with only the caption text replaced.
    expect(out).toContain('<img src="./assets/a.png" alt="A diagram">');
    expect(out).toContain("<figcaption>译文</figcaption>");
    expect(out).not.toContain("A caption worth reading");
    expect(splitBlocks(out).map((b) => b.type)).toEqual(["html"]);
  });

  test("reverts to the original when the markup would not survive", async () => {
    // The existing shape guard is what makes masking safe to attempt: a model
    // that writes outside the tokens produces a paragraph, not a figure, and
    // the block is kept in English rather than published broken.
    const sloppy: ChatFn = async (request) => {
      const user =
        request.messages.find((m) => m.role === "user")?.content ?? "";
      return user.replace(/(<<<TIRO_BLOCK_\d+>>>\n)/g, "$1前言：");
    };
    const zh = await translateBlocks({
      chat: sloppy,
      model: "m",
      targetLang: "zh",
      blocks: splitBlocks(figure),
    });
    expect(zh?.trim()).toBe(figure);
  });

  test("masks the caption's own markup, so an href cannot be rewritten", async () => {
    // A caption's markup is usually a credit link. A model that rewrites the
    // href produces a caption pointing somewhere the page never linked, and
    // an html block is compared by type, so it would publish unnoticed.
    const linked =
      '<figure><img src="./assets/a.png" alt="x"><figcaption>Credit: <a href="https://real.example/page">Someone</a></figcaption></figure>';
    const sent: string[] = [];
    const rewriter: ChatFn = async (request) => {
      const user =
        request.messages.find((m) => m.role === "user")?.content ?? "";
      sent.push(user);
      return user.replace(/real\.example/g, "hallucinated.example");
    };
    const zh = await translateBlocks({
      chat: rewriter,
      model: "m",
      targetLang: "zh",
      blocks: splitBlocks(linked),
    });
    expect(sent.join("")).not.toContain("real.example");
    expect(zh ?? "").toContain('<a href="https://real.example/page">');
    expect(zh ?? "").not.toContain("hallucinated");
  });

  test("still recognises a figure whose image is wrapped in a link", async () => {
    const linked =
      '<figure><a href="https://ex.com/full.png"><img src="./assets/a.png" alt="x"></a><figcaption>Cap</figcaption></figure>';
    const sent: string[] = [];
    const chat: ChatFn = async (request) => {
      sent.push(request.messages.at(-1)?.content ?? "");
      return tokenPreservingChat(request);
    };
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks: splitBlocks(linked),
    });
    expect(sent.join("")).not.toContain("ex.com/full.png");
    expect(zh ?? "").toContain('<a href="https://ex.com/full.png">');
    expect(zh ?? "").toContain("<figcaption>译文</figcaption>");
  });

  test("masks tags whose attributes contain a bare '>'", async () => {
    // `/<[^>]+>/` reads the first `>` as the tag's end, cutting the tag
    // mid-attribute and leaving the href in the text sent to the model. The
    // clipper escapes this (innerHTML writes &gt;), but the processor also
    // runs over vault HTML nobody generated.
    const tricky =
      '<figure><img src="./assets/a.png" alt="x"><figcaption>See <a title="1 > 0" href="https://real.example/page">this</a></figcaption></figure>';
    const sent: string[] = [];
    const rewriter: ChatFn = async (request) => {
      const user =
        request.messages.find((m) => m.role === "user")?.content ?? "";
      sent.push(user);
      return user.replace(/real\.example/g, "hallucinated.example");
    };
    const zh = await translateBlocks({
      chat: rewriter,
      model: "m",
      targetLang: "zh",
      blocks: splitBlocks(tricky),
    });
    expect(sent.join("")).not.toContain("real.example");
    expect(zh ?? "").toContain('href="https://real.example/page"');
    expect(zh ?? "").not.toContain("hallucinated");
  });

  test("skips a caption whose markup cannot be masked, leaving it as-is", async () => {
    // An unterminated tag cannot be tokenised, and sending the block whole
    // would hand the model the markup this masking exists to hide.
    const broken =
      '<figure><img src="./assets/a.png" alt="x"><figcaption>See <a href="https://real.example/page" this</figcaption></figure>';
    const sent: string[] = [];
    const chat: ChatFn = async (request) => {
      sent.push(request.messages.at(-1)?.content ?? "");
      return tokenPreservingChat(request);
    };
    const zh = await translateBlocks({
      chat,
      model: "m",
      targetLang: "zh",
      blocks: splitBlocks(broken),
    });
    expect(sent.join("")).not.toContain("real.example");
    expect(zh?.trim()).toBe(broken);
  });

  test("leaves other raw HTML blocks verbatim", async () => {
    const raw = "<div class='promo'>Subscribe now</div>";
    const zh = await translateBlocks({
      chat: makeFakeChat(),
      model: "m",
      targetLang: "zh",
      blocks: splitBlocks(raw),
    });
    expect(zh?.trim()).toBe(raw);
  });
});
