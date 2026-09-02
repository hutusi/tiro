import { beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAlignment,
  needsProcessing,
  parseArticle,
  splitBlocks,
  stringifyArticle,
} from "@tiro/shared";
import { createDeadline, DeadlineExceededError } from "../src/deadline.ts";
import { TRANSLATION_CACHE_FILE } from "../src/llm/cache.ts";
import type { ChatFn, FetchLike } from "../src/llm/client.ts";
import { loadVaultConfig, runPipeline } from "../src/pipeline.ts";
import { makeFakeChat } from "./helpers.ts";

const fixtureVault = join(import.meta.dir, "../../../fixtures/vault");
const RAW = "example-org-blog-raw-clip-b5de6fbd";

// The fixture image is a hotlink to example.org; tests must not touch the
// network, so the injected fetch fails and the pipeline keeps the hotlink.
const offlineFetch: FetchLike = async () =>
  new Response("offline", { status: 404 });

function freshVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "tiro-vault-"));
  cpSync(fixtureVault, dir, { recursive: true });
  return dir;
}

const deps = {
  chat: makeFakeChat(),
  fetchImpl: offlineFetch,
  // Host validation resolves names, so without this the suite would hit real
  // DNS. Answers public so the injected fetch decides every outcome.
  resolveHost: async () => ["93.184.216.34"],
  now: () => new Date("2026-08-22T12:00:00.000Z"),
  log: () => {},
};

describe("runPipeline", () => {
  let vault: string;

  beforeAll(async () => {
    vault = freshVault();
    const config = await loadVaultConfig(vault);
    const report = await runPipeline({ vaultDir: vault }, config, deps);
    expect(report.invalid).toEqual([]);
    expect(report.processed).toEqual(["example-org-blog-raw-clip-b5de6fbd"]);
  });

  test("marks the raw clip processed with summary, category, tags, and lang", () => {
    const { frontmatter } = parseArticle(
      readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
    );
    expect(needsProcessing(frontmatter)).toBe(false);
    expect(frontmatter.lang).toBe("en");
    expect(frontmatter.category).toBe("ai");
    expect(frontmatter.summary).toContain("测试摘要");
    expect(frontmatter.tags).toEqual(["test", "fixture"]);
    expect(frontmatter.tiro.processed_at).toBe("2026-08-22T12:00:00.000Z");
  });

  test("writes an aligned zh.md for the English article", () => {
    const { body } = parseArticle(
      readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
    );
    const zh = readFileSync(join(vault, "articles", RAW, "zh.md"), "utf8");
    const alignment = checkAlignment(splitBlocks(body), splitBlocks(zh));
    expect(alignment.errors).toEqual([]);
    expect(zh).toContain("中文：");
  });

  test("keeps the unreachable image as a hotlink without failing the article", () => {
    const { body } = parseArticle(
      readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
    );
    expect(body).toContain("https://example.org/images/figure-1.png");
  });

  test("does not touch already-processed articles", () => {
    const processed = readFileSync(
      join(vault, "articles/example-com-posts-hello-ai-e8446b12/index.md"),
      "utf8",
    );
    const original = readFileSync(
      join(
        fixtureVault,
        "articles/example-com-posts-hello-ai-e8446b12/index.md",
      ),
      "utf8",
    );
    expect(processed).toBe(original);
  });

  test("a second run is a no-op", async () => {
    const before = readFileSync(
      join(vault, "articles", RAW, "index.md"),
      "utf8",
    );
    const config = await loadVaultConfig(vault);
    const report = await runPipeline({ vaultDir: vault }, config, deps);
    expect(report.processed).toEqual([]);
    expect(readFileSync(join(vault, "articles", RAW, "index.md"), "utf8")).toBe(
      before,
    );
  });

  test("--force with --slug reprocesses exactly one article", async () => {
    const config = await loadVaultConfig(vault);
    const report = await runPipeline(
      {
        vaultDir: vault,
        force: true,
        slug: "example-cn-posts-ai-times-0d21367e",
      },
      config,
      deps,
    );
    expect(report.processed).toEqual(["example-cn-posts-ai-times-0d21367e"]);
    // Chinese original: reprocessing must not create a zh.md.
    expect(() =>
      readFileSync(
        join(vault, "articles/example-cn-posts-ai-times-0d21367e/zh.md"),
      ),
    ).toThrow();
  });

  test("dry-run reports without writing", async () => {
    const dryVault = freshVault();
    const config = await loadVaultConfig(dryVault);
    const before = readFileSync(
      join(dryVault, "articles", RAW, "index.md"),
      "utf8",
    );
    const report = await runPipeline(
      { vaultDir: dryVault, dryRun: true },
      config,
      {
        ...deps,
        chat: async () => {
          throw new Error("dry-run must not call the LLM");
        },
      },
    );
    expect(report.processed).toEqual([]);
    expect(
      readFileSync(join(dryVault, "articles", RAW, "index.md"), "utf8"),
    ).toBe(before);
  });
});

describe("failure markers", () => {
  const RAW_SLUG = "example-org-blog-raw-clip-b5de6fbd";

  test("translation failure marks translation_failed but still processes", async () => {
    const vault = freshVault();
    // A per-block shape change is repaired now, so forcing a real translation
    // failure takes the join-merge case: two lists with different bullets are
    // two blocks, and a translation that normalises the bullet merges them.
    writeFileSync(
      join(vault, "articles", RAW_SLUG, "index.md"),
      [
        "---",
        'url: "https://example.org/blog/raw-clip"',
        'title: "Raw Clip"',
        'domain: "example.org"',
        'clipped_at: "2026-08-23T09:00:00.000Z"',
        "tiro:",
        "  schema: 1",
        "---",
        "",
        "- alpha",
        "",
        "* beta",
        "",
      ].join("\n"),
    );
    const config = await loadVaultConfig(vault);
    const report = await runPipeline(
      { vaultDir: vault, slug: RAW_SLUG },
      config,
      {
        ...deps,
        chat: async (request) => {
          if (request.response_format?.type === "json_object") {
            return JSON.stringify({ summary: "s", category: "ai", tags: [] });
          }
          return "-   译文";
        },
      },
    );
    expect(report.processed).toEqual([RAW_SLUG]);
    expect(report.translationFailed).toEqual([RAW_SLUG]);
    const { frontmatter } = parseArticle(
      readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
    );
    expect(needsProcessing(frontmatter)).toBe(false);
    expect(frontmatter.tiro.translation_failed).toBe(true);
    expect(() => readFileSync(join(vault, "articles", RAW, "zh.md"))).toThrow();
  });

  test("--force reprocess clears a stale summary_failed marker", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    // First run: the category never validates, so the summary falls back.
    const failing = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat: makeFakeChat({
        summary: { summary: "s", category: "not-in-taxonomy", tags: [] },
      }),
    });
    expect(failing.summaryFailed).toEqual([RAW_SLUG]);
    let { frontmatter } = parseArticle(
      readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
    );
    expect(frontmatter.tiro.summary_failed).toBe(true);

    // Force reprocess with a healthy LLM: the stale marker must clear.
    const healthy = await runPipeline(
      { vaultDir: vault, force: true, slug: RAW_SLUG },
      config,
      deps,
    );
    expect(healthy.summaryFailed).toEqual([]);
    ({ frontmatter } = parseArticle(
      readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
    ));
    expect(frontmatter.tiro.summary_failed).toBeUndefined();
    expect(frontmatter.category).toBe("ai");
  });
});

describe("hard failures", () => {
  const SECOND = "zz-second-pending-article-aaaaaaaa";
  const secondClip = [
    "---",
    'url: "https://example.net/second"',
    'title: "Second Pending Article"',
    'domain: "example.net"',
    'clipped_at: "2026-08-23T09:00:00.000Z"',
    "tiro:",
    "  schema: 1",
    "---",
    "",
    "Second pending article body.",
    "",
  ].join("\n");

  test("a failing article stays pending while later articles still process", async () => {
    const vault = freshVault();
    // Which article fails is decided by body text below, not by order.
    const secondPath = join(vault, "articles", SECOND, "index.md");
    mkdirSync(join(vault, "articles", SECOND), { recursive: true });
    writeFileSync(secondPath, secondClip);
    const config = await loadVaultConfig(vault);
    const before = readFileSync(
      join(vault, "articles", RAW, "index.md"),
      "utf8",
    );

    const healthy = makeFakeChat();
    const report = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat: async (request) => {
        // Fail only the first article (identified by its body text).
        const user =
          request.messages.find((m) => m.role === "user")?.content ?? "";
        if (user.includes("This fixture represents an article")) {
          throw new Error("provider says 403 Model.AccessDenied");
        }
        return healthy(request);
      },
    });

    expect(report.errored).toHaveLength(1);
    expect(report.errored[0]?.slug).toBe("example-org-blog-raw-clip-b5de6fbd");
    expect(report.errored[0]?.error).toContain("AccessDenied");
    expect(report.processed).toEqual(["zz-second-pending-article-aaaaaaaa"]);

    // Failed article untouched on disk — the next run retries it.
    expect(readFileSync(join(vault, "articles", RAW, "index.md"), "utf8")).toBe(
      before,
    );
    expect(needsProcessing(parseArticle(before).frontmatter)).toBe(true);
    // Succeeding article fully processed despite the earlier failure.
    const second = parseArticle(readFileSync(secondPath, "utf8"));
    expect(needsProcessing(second.frontmatter)).toBe(false);
  });
});

describe("stale translations", () => {
  const CN = "example-cn-posts-ai-times-0d21367e";

  test("removes a leftover zh.md when the article is already in the target language", async () => {
    const vault = freshVault();
    const zhPath = join(vault, "articles", CN, "zh.md");
    // A previous clip of this URL was English and got translated; the re-clip
    // is Chinese, so the translation branch is skipped entirely.
    writeFileSync(zhPath, "过时的译文。\n");
    const config = await loadVaultConfig(vault);

    const report = await runPipeline(
      { vaultDir: vault, force: true, slug: CN },
      config,
      deps,
    );

    expect(report.processed).toEqual([CN]);
    expect(report.translated).toEqual([]);
    expect(() => readFileSync(zhPath)).toThrow();
  });

  test("removes a leftover zh.md when the translation fails", async () => {
    const vault = freshVault();
    const zhPath = join(vault, "articles", RAW, "zh.md");
    writeFileSync(zhPath, "过时的译文。\n");
    writeFileSync(
      join(vault, "articles", RAW, "index.md"),
      [
        "---",
        'url: "https://example.org/blog/raw-clip"',
        'title: "Raw Clip"',
        'domain: "example.org"',
        'clipped_at: "2026-08-23T09:00:00.000Z"',
        "tiro:",
        "  schema: 1",
        "---",
        "",
        "- alpha",
        "",
        "* beta",
        "",
      ].join("\n"),
    );
    const config = await loadVaultConfig(vault);

    // Same join-merge chat as the translation-failure test above.
    const report = await runPipeline({ vaultDir: vault, slug: RAW }, config, {
      ...deps,
      chat: async (request) => {
        if (request.response_format?.type === "json_object") {
          return JSON.stringify({ summary: "s", category: "ai", tags: [] });
        }
        return "-   译文";
      },
    });

    expect(report.translationFailed).toEqual([RAW]);
    // Keeping it would pair last clip's translation with this clip's body.
    expect(() => readFileSync(zhPath)).toThrow();
  });
});

describe("asset reconciliation", () => {
  const EN = "example-com-posts-hello-ai-e8446b12";
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const servingFetch: FetchLike = async () =>
    new Response(PNG, { headers: { "Content-Type": "image/png" } });
  const throwingChat = async () => {
    throw new Error("provider says 403 Model.AccessDenied");
  };

  test("rolls back downloads from a run that failed before writing", async () => {
    const vault = freshVault();
    const assets = join(vault, "articles", RAW, "assets");
    const before = readFileSync(
      join(vault, "articles", RAW, "index.md"),
      "utf8",
    );
    const config = await loadVaultConfig(vault);

    // Image succeeds, summary does not: exactly the window where files land on
    // disk that no committed body references, and the workflow commits them.
    const report = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      fetchImpl: servingFetch,
      chat: throwingChat,
    });

    expect(report.errored).toHaveLength(1);
    expect(report.processed).toEqual([]);
    expect(readdirSync(assets)).toEqual([]);
    // Rolled back against the body on disk, which was never rewritten.
    expect(readFileSync(join(vault, "articles", RAW, "index.md"), "utf8")).toBe(
      before,
    );
  });

  test("keeps assets the committed article still references", async () => {
    const vault = freshVault();
    const assets = join(vault, "articles", EN, "assets");
    writeFileSync(join(assets, "deadbeefdead.png"), "not really a png");
    const config = await loadVaultConfig(vault);

    const report = await runPipeline(
      { vaultDir: vault, force: true, slug: EN },
      config,
      { ...deps, chat: throwingChat },
    );

    expect(report.errored).toHaveLength(1);
    // cover.png is named by the committed body; the orphan is not.
    expect(readdirSync(assets)).toEqual(["cover.png"]);
  });

  test("a failure while cleaning up does not change the article's outcome", async () => {
    const vault = freshVault();
    const assets = join(vault, "articles", EN, "assets");
    writeFileSync(join(assets, "deadbeefdead.png"), "not really a png");
    chmodSync(assets, 0o500); // readable, not writable: rm will fail
    const config = await loadVaultConfig(vault);

    try {
      const report = await runPipeline(
        { vaultDir: vault, force: true, slug: EN },
        config,
        deps,
      );
      // Reconciliation is housekeeping. Before this it ran before the article
      // was recorded, so a throw here reported "left pending" for an article
      // already marked processed on disk — and every later run skipped it.
      expect(report.processed).toEqual([EN]);
      expect(report.errored).toEqual([]);
      const { frontmatter } = parseArticle(
        readFileSync(join(vault, "articles", EN, "index.md"), "utf8"),
      );
      expect(needsProcessing(frontmatter)).toBe(false);
    } finally {
      chmodSync(assets, 0o700);
    }
  });
});

describe("run budget", () => {
  const BIG = "zz-oversized-paper-aaaaaaaa";

  /** Long article: 40 short paragraphs, so it needs many sequential calls. */
  function bigClip(): string {
    return [
      "---",
      'url: "https://example.net/oversized"',
      'title: "Oversized Paper"',
      'domain: "example.net"',
      'clipped_at: "2026-08-23T09:00:00.000Z"',
      "tiro:",
      "  schema: 1",
      "---",
      "",
      Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of the paper.`).join(
        "\n\n",
      ),
      "",
    ].join("\n");
  }

  function withBigArticle(): string {
    const vault = freshVault();
    mkdirSync(join(vault, "articles", BIG), { recursive: true });
    writeFileSync(join(vault, "articles", BIG, "index.md"), bigClip());
    return vault;
  }

  /**
   * Scaled-down budget arithmetic: one block per batch and a 50ms reserve per
   * call, against a chat fake that bills 100ms. Keeps the real ratios (budget
   * >> per-call reserve) without a test that sleeps.
   */
  async function tinyConfig(vault: string) {
    const config = await loadVaultConfig(vault);
    return {
      ...config,
      llm: { ...config.llm, timeout_ms: 50 },
      translation: { ...config.translation, batch_chars: 1 },
    };
  }

  function billingChat(bill: () => void): ChatFn {
    const fake = makeFakeChat();
    return async (request) => {
      bill();
      return fake(request);
    };
  }

  test("stops cleanly mid-article, leaving it pending with its checkpoint", async () => {
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    let clock = 0;

    const report = await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: billingChat(() => {
        clock += 100;
      }),
      // ~15 calls' worth: enough to make real progress, nowhere near 40 blocks.
      deadline: createDeadline(1500, () => clock),
    });

    // Budget exhaustion is an orderly stop, not a fault.
    expect(report.errored).toEqual([]);
    expect(report.skipped).toEqual([BIG]);
    expect(report.processed).toEqual([]);

    // Unmarked on disk, so the next run picks it up again...
    const { frontmatter } = parseArticle(
      readFileSync(join(vault, "articles", BIG, "index.md"), "utf8"),
    );
    expect(needsProcessing(frontmatter)).toBe(true);
    // ...and no half-written translation was published.
    expect(() => readFileSync(join(vault, "articles", BIG, "zh.md"))).toThrow();
    // The checkpoint is what makes the next run cheaper instead of identical.
    const checkpoint = JSON.parse(
      readFileSync(
        join(vault, "articles", BIG, TRANSLATION_CACHE_FILE),
        "utf8",
      ),
    );
    expect(Object.keys(checkpoint.blocks).length).toBeGreaterThan(0);
  });

  test("a later run resumes the checkpoint and finishes the article", async () => {
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    let clock = 0;
    const first = await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: billingChat(() => {
        clock += 100;
      }),
      deadline: createDeadline(1500, () => clock),
    });
    expect(first.skipped).toEqual([BIG]);
    const cached = Object.keys(
      JSON.parse(
        readFileSync(
          join(vault, "articles", BIG, TRANSLATION_CACHE_FILE),
          "utf8",
        ),
      ).blocks,
    ).length;

    // Second run, full budget: it must not start over.
    let calls = 0;
    const second = await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: makeFakeChat({
        onRequest: () => {
          calls += 1;
        },
      }),
    });
    expect(second.processed).toEqual([BIG]);
    expect(second.translated).toEqual([BIG]);

    const { body } = parseArticle(
      readFileSync(join(vault, "articles", BIG, "index.md"), "utf8"),
    );
    const zh = readFileSync(join(vault, "articles", BIG, "zh.md"), "utf8");
    expect(checkAlignment(splitBlocks(body), splitBlocks(zh)).errors).toEqual(
      [],
    );
    // A finished article KEEPS its checkpoint (ADR 0008): that is what makes a
    // later re-clip cheap. It is pruned to the blocks this article still has,
    // so it cannot accumulate every version of every paragraph.
    const kept = JSON.parse(
      readFileSync(
        join(vault, "articles", BIG, TRANSLATION_CACHE_FILE),
        "utf8",
      ),
    ) as { blocks: Record<string, string> };
    expect(Object.keys(kept.blocks).length).toBeGreaterThanOrEqual(cached);
    expect(Object.keys(kept.blocks).length).toBeLessThanOrEqual(
      splitBlocks(body).length,
    );
    // Resumption is the point: the blocks the first run paid for are not
    // bought twice. (+1 for this run's summary call.)
    expect(calls).toBe(splitBlocks(body).length - cached + 1);
  });

  test("an exhausted budget defers articles instead of failing them", async () => {
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    const report = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat: async () => {
        throw new Error("no article should reach the LLM");
      },
      deadline: createDeadline(0, () => 0),
    });
    expect(report.processed).toEqual([]);
    expect(report.errored).toEqual([]);
    expect(report.skipped).toContain(BIG);
    expect(report.skipped).toContain(RAW);
  });

  test("a short article still lands when an oversized one is queued", async () => {
    // The original bug in one test: an oversized article ran first on every
    // push, spent the entire budget without finishing, and starved a short
    // article clipped alongside it. Cheapest-first means the short one lands
    // and only the oversized one waits for the next run.
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    let clock = 0;
    const report = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat: billingChat(() => {
        clock += 100;
      }),
      deadline: createDeadline(1500, () => clock),
    });

    expect(report.processed).toEqual([RAW]);
    expect(report.translated).toEqual([RAW]);
    expect(report.skipped).toEqual([BIG]);
    expect(report.errored).toEqual([]);
  });
  test("a re-clip reuses the translations of blocks it did not change", async () => {
    // The point of keeping the checkpoint. A clip rewrites index.md from
    // clip-time data only, so the article goes fully pending again — and
    // before this, the checkpoint had already been deleted by the run that
    // made it "processed", so every block was re-sent and re-billed.
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: makeFakeChat(),
    });

    // Simulate a re-clip: same body, one paragraph edited, markers stripped.
    const indexAbs = join(vault, "articles", BIG, "index.md");
    const { frontmatter, body } = parseArticle(readFileSync(indexAbs, "utf8"));
    const edited = body.replace(
      /^Paragraph 0 of the paper\.$/m,
      "Paragraph 0 rewritten after the re-clip.",
    );
    // The edit must actually land, or this test silently proves nothing.
    expect(edited).not.toBe(body);
    const {
      processed_at: _gone,
      processor_version: _alsoGone,
      ...clipTime
    } = frontmatter.tiro;
    writeFileSync(
      indexAbs,
      stringifyArticle(
        { ...frontmatter, tiro: clipTime, summary: undefined },
        edited,
      ),
    );

    let translationCalls = 0;
    const after = await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: makeFakeChat({
        onRequest: (r) => {
          if (r.response_format?.type !== "json_object") translationCalls += 1;
        },
      }),
    });
    expect(after.translated).toEqual([BIG]);
    // Selective, not wholesale: the edited block is paid for, everything else
    // comes from the checkpoint. A full re-translation of this article batches
    // into many more calls than this.
    expect(translationCalls).toBeGreaterThan(0);
    expect(translationCalls).toBeLessThan(3);
    // The superseded block's entry does not linger: the checkpoint holds this
    // article's blocks, not every version it has ever had.
    const afterCache = JSON.parse(
      readFileSync(
        join(vault, "articles", BIG, TRANSLATION_CACHE_FILE),
        "utf8",
      ),
    ) as { blocks: Record<string, string> };
    expect(Object.keys(afterCache.blocks).length).toBeLessThanOrEqual(
      splitBlocks(edited).length,
    );
    const zh = readFileSync(join(vault, "articles", BIG, "zh.md"), "utf8");
    const fresh = parseArticle(readFileSync(indexAbs, "utf8"));
    expect(
      checkAlignment(splitBlocks(fresh.body), splitBlocks(zh)).errors,
    ).toEqual([]);
  });

  test("--force --dry-run leaves the checkpoint alone", async () => {
    // A dry run's whole contract is that the vault is unchanged, and deleting
    // a checkpoint is the most destructive thing this run could do to it.
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: makeFakeChat(),
    });
    const cacheAbs = join(vault, "articles", BIG, TRANSLATION_CACHE_FILE);
    const before = readFileSync(cacheAbs, "utf8");

    await runPipeline(
      { vaultDir: vault, slug: BIG, force: true, dryRun: true },
      config,
      { ...deps, chat: makeFakeChat() },
    );
    expect(readFileSync(cacheAbs, "utf8")).toBe(before);
  });

  test("a checkpoint that cannot be cleared takes its article out of a forced run", async () => {
    // --force depends on the removal now: a checkpoint that survives is read
    // straight back and the redo reuses every block, silently. Logging and
    // carrying on would defeat the flag.
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: makeFakeChat(),
    });
    // Make the checkpoint undeletable but still readable.
    const dir = join(vault, "articles", BIG);
    chmodSync(dir, 0o555);
    try {
      let translationCalls = 0;
      const forced = await runPipeline(
        { vaultDir: vault, slug: BIG, force: true },
        config,
        {
          ...deps,
          chat: makeFakeChat({
            onRequest: (r) => {
              if (r.response_format?.type !== "json_object")
                translationCalls += 1;
            },
          }),
        },
      );
      expect(forced.errored.map((e) => e.slug)).toContain(BIG);
      expect(forced.processed).not.toContain(BIG);
      expect(translationCalls).toBe(0);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("a --force redo survives being deferred before it reaches translation", async () => {
    // The forced discard has to happen before anything that can spend budget.
    // Images and summarisation both can, and deferring after them clears
    // processed_at via markPending while leaving a complete checkpoint — so
    // the next ordinary run saw a pending article, no --force, and reused
    // every block. The forced redo evaporated silently.
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: makeFakeChat(),
    });
    expect(
      existsSync(join(vault, "articles", BIG, TRANSLATION_CACHE_FILE)),
    ).toBe(true);

    // Forced redo with a budget too small to reach translation at all.
    let clock = 0;
    const forced = await runPipeline(
      { vaultDir: vault, slug: BIG, force: true },
      config,
      {
        ...deps,
        chat: billingChat(() => {
          clock += 1000;
        }),
        deadline: createDeadline(1, () => clock),
      },
    );
    expect(forced.translated).toEqual([]);
    // The checkpoint is gone, so the redo cannot be quietly skipped later.
    expect(
      existsSync(join(vault, "articles", BIG, TRANSLATION_CACHE_FILE)),
    ).toBe(false);

    // The ordinary run that picks it up really does re-translate.
    let translationCalls = 0;
    const followUp = await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: makeFakeChat({
        onRequest: (r) => {
          if (r.response_format?.type !== "json_object") translationCalls += 1;
        },
      }),
    });
    expect(followUp.translated).toEqual([BIG]);
    expect(translationCalls).toBeGreaterThan(0);
  });

  test("a budget-deferred --force article returns to pending and a normal run finishes it", async () => {
    // Forced discovery includes already-processed articles, so deferring one
    // used to leave processed_at in place: the next ordinary run skipped it,
    // despite the log promising it would resume, and a repeated --force just
    // redid the cheapest articles again.
    const vault = withBigArticle();
    const config = await tinyConfig(vault);

    // Process everything normally first, so both articles carry the marker.
    await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat: makeFakeChat(),
    });
    expect(
      needsProcessing(
        parseArticle(
          readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
        ).frontmatter,
      ),
    ).toBe(false);

    // Forced redo that runs out of budget partway.
    let clock = 0;
    const forced = await runPipeline({ vaultDir: vault, force: true }, config, {
      ...deps,
      chat: billingChat(() => {
        clock += 100;
      }),
      deadline: createDeadline(1500, () => clock),
    });
    expect(forced.skipped).toContain(BIG);
    expect(forced.errored).toEqual([]);

    // The deferred article is genuinely pending again...
    const deferred = parseArticle(
      readFileSync(join(vault, "articles", BIG, "index.md"), "utf8"),
    );
    expect(needsProcessing(deferred.frontmatter)).toBe(true);
    // ...but keeps everything the earlier run produced, so it still renders.
    expect(deferred.frontmatter.summary).toBeDefined();
    expect(deferred.frontmatter.category).toBe("ai");
    expect(
      readFileSync(join(vault, "articles", BIG, "zh.md"), "utf8"),
    ).toContain("中文");

    // An ordinary run — no --force — now picks it up, which is the whole point.
    // `toContain`, not `toEqual`: --force reset every article in the fixture
    // vault, and which of the others also fell outside the budget above is an
    // accident of how many fixtures there are, not what this test is about.
    const followUp = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat: makeFakeChat(),
    });
    expect(followUp.processed).toContain(BIG);
  });

  test("deferring an unforced article writes nothing", async () => {
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    const before = readFileSync(
      join(vault, "articles", BIG, "index.md"),
      "utf8",
    );
    const report = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat: async () => {
        throw new Error("no article should reach the LLM");
      },
      deadline: createDeadline(0, () => 0),
    });
    expect(report.skipped).toContain(BIG);
    // Pending articles have no marker to clear, so the file must be untouched.
    expect(readFileSync(join(vault, "articles", BIG, "index.md"), "utf8")).toBe(
      before,
    );
  });
  test("a failure after translating but before index.md keeps the checkpoint", async () => {
    // The window fix 3 closes: translation has finished and cost real money,
    // but zh.md and index.md are not written yet. Discarding the checkpoint at
    // the end of translation would lose all of it and leave the article
    // pending — the exact loss the checkpoint exists to prevent.
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    const indexPath = join(vault, "articles", BIG, "index.md");

    let calls = 0;
    const report = await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: makeFakeChat({
        onRequest: () => {
          calls += 1;
        },
      }),
      now: () => {
        // Throwing from the clock aborts processOne after translation has
        // completed but before index.md is assembled and written.
        if (calls > 0) throw new Error("disk gone");
        return new Date("2026-08-22T12:00:00.000Z");
      },
    });

    expect(report.errored).toHaveLength(1);
    expect(report.processed).toEqual([]);
    // Article still pending, and the translated blocks survived.
    expect(
      needsProcessing(
        parseArticle(readFileSync(indexPath, "utf8")).frontmatter,
      ),
    ).toBe(true);
    const checkpoint = JSON.parse(
      readFileSync(
        join(vault, "articles", BIG, TRANSLATION_CACHE_FILE),
        "utf8",
      ),
    );
    expect(Object.keys(checkpoint.blocks).length).toBeGreaterThan(0);

    // And the next run reuses them instead of paying again.
    let secondCalls = 0;
    const second = await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: makeFakeChat({
        onRequest: () => {
          secondCalls += 1;
        },
      }),
    });
    expect(second.processed).toEqual([BIG]);
    expect(secondCalls).toBeLessThan(calls);
  });
  test("a slow image stage cannot outrun the budget of an article it starts", async () => {
    // The coverage the review asked for. processImages has its own five-minute
    // stage limit and runs on real time, so before the clamp an article started
    // with one LLM timeout left could sit in image downloads long past the run
    // budget — and past the workflow timeout, whose kill skips the commit step.
    const vault = withBigArticle();
    const config = await tinyConfig(vault);

    // Honours the abort signal, as a real fetch does: with the stage clamped to
    // what is left of the run this is cut short, unclamped it runs the full 3 s.
    const slowImageFetch: FetchLike = async (_input, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(new Response("offline", { status: 404 })),
          3_000,
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });

    const started = Date.now();
    const report = await runPipeline({ vaultDir: vault, slug: RAW }, config, {
      ...deps,
      fetchImpl: slowImageFetch,
      chat: makeFakeChat(),
      // Real clock: the image stage reads real time, so this is what it clamps
      // against. Comfortably above llm.timeout_ms (50 ms) so the article starts
      // and the image stage is what has to stop it.
      deadline: createDeadline(400),
    });
    const elapsed = Date.now() - started;

    // Clamped to the ~400 ms left, not the stage's own 5 min or the image's 3 s.
    expect(elapsed).toBeLessThan(1_500);
    // Stopped on budget rather than failing, and left for the next run.
    expect(report.errored).toEqual([]);
    expect(report.processed).toEqual([]);
    expect(report.skipped).toEqual([RAW]);
    expect(
      needsProcessing(
        parseArticle(
          readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
        ).frontmatter,
      ),
    ).toBe(true);
  });
  test("a failing checkpoint cleanup cannot turn a finished article into a failure", async () => {
    // The window: index.md is written and durable, but the article is not yet
    // recorded. A throw here reaches the outer catch, which reports the article
    // as pending — while it carries processed_at on disk, so it never retries —
    // and reconciles assets against the pre-download body, which references
    // none of the downloaded files. Every image would be deleted while the
    // committed index.md still points at them.
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    // rm() without `recursive` throws on a directory, so this is a real
    // cleanup failure rather than a mocked one.
    const cachePath = join(vault, "articles", RAW, TRANSLATION_CACHE_FILE);
    mkdirSync(join(cachePath, "wedged"), { recursive: true });

    const report = await runPipeline({ vaultDir: vault }, config, deps);

    expect(report.errored).toEqual([]);
    expect(report.processed).toEqual([RAW]);
    // The article is finished, and its translation is still there.
    const { frontmatter } = parseArticle(
      readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
    );
    expect(needsProcessing(frontmatter)).toBe(false);
    expect(existsSync(join(vault, "articles", RAW, "zh.md"))).toBe(true);
  });

  test("an article already in the target language clears staging debris", async () => {
    // It never loads a checkpoint, so nothing else would clean a killed run's
    // .tmp — and the workflow's `git add -A` would commit it.
    const vault = freshVault();
    const CN = "example-cn-posts-ai-times-0d21367e";
    const cachePath = join(vault, "articles", CN, TRANSLATION_CACHE_FILE);
    writeFileSync(cachePath, '{"version":1}');
    writeFileSync(`${cachePath}.tmp`, '{ "version": 1, "blocks": { "trunc');

    const config = await loadVaultConfig(vault);
    const report = await runPipeline(
      { vaultDir: vault, force: true, slug: CN },
      config,
      deps,
    );

    expect(report.processed).toEqual([CN]);
    expect(existsSync(cachePath)).toBe(false);
    expect(existsSync(`${cachePath}.tmp`)).toBe(false);
  });
  test("an unwritable checkpoint is reported as a fault, not as resumable progress", async () => {
    // The reviewer's repro: two runs, identical LLM calls, no checkpoint — and
    // both reporting an orderly deferral. The repetition is unavoidable with
    // nowhere to persist to; claiming it is progress is not, and it is what
    // hides a permanently stuck article behind a healthy-looking log.
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    mkdirSync(
      join(vault, "articles", BIG, `${TRANSLATION_CACHE_FILE}.tmp`, "x"),
      {
        recursive: true,
      },
    );

    let clock = 0;
    const logged: string[] = [];
    const report = await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: billingChat(() => {
        clock += 100;
      }),
      deadline: createDeadline(1500, () => clock),
      log: (m) => logged.push(m),
    });

    expect(report.skipped).toEqual([]);
    expect(report.errored).toHaveLength(1);
    expect(report.errored[0]?.slug).toBe(BIG);
    expect(report.errored[0]?.error).toContain("cannot resume");
    // The false reassurance must be gone from the log entirely.
    expect(logged.join("\n")).not.toContain("checkpoint saved");
    expect(
      needsProcessing(
        parseArticle(
          readFileSync(join(vault, "articles", BIG, "index.md"), "utf8"),
        ).frontmatter,
      ),
    ).toBe(true);
  });

  test("the budget-deferral log names what actually stopped the run", async () => {
    // DeadlineExceededError carries the fault observed as the budget ran out;
    // without it in the log that diagnosis lives only in the unit tests.
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    let clock = 0;
    const logged: string[] = [];
    const report = await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: billingChat(() => {
        clock += 100;
      }),
      deadline: createDeadline(1500, () => clock),
      log: (m) => logged.push(m),
    });

    expect(report.skipped).toEqual([BIG]);
    const line = logged.find((m) =>
      m.includes("run budget exhausted mid-article"),
    );
    expect(line).toBeDefined();
    expect(line).toContain("run budget exhausted before");
  });
  test("the same when the budget dies inside a call, not before one", async () => {
    // End to end on the reported symptom: a budget that runs out mid-request
    // raises DeadlineExceededError from the chat client, which used to bypass
    // the guard entirely and have the run log a resumable skip with nothing
    // persisted.
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    mkdirSync(
      join(vault, "articles", BIG, `${TRANSLATION_CACHE_FILE}.tmp`, "x"),
      {
        recursive: true,
      },
    );

    let calls = 0;
    const healthy = makeFakeChat();
    const logged: string[] = [];
    const report = await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      // 1 = summary, 2 = first batch (its flush fails), 3 = dies in flight.
      chat: async (request) => {
        calls += 1;
        if (calls >= 3) {
          throw new DeadlineExceededError("a chat completions request", -1);
        }
        return healthy(request);
      },
      log: (m) => logged.push(m),
    });

    expect(report.skipped).toEqual([]);
    expect(report.errored).toHaveLength(1);
    expect(report.errored[0]?.error).toContain("cannot resume");
    expect(logged.join("\n")).not.toContain("checkpoint saved");
  });
  test("a deferral whose marker cannot be cleared is reported, not silently promised", async () => {
    // markPending() writes from inside the per-article catch. An unguarded
    // throw there escaped runPipeline entirely and abandoned every remaining
    // article — invariant 7 says one article's failure must not cost the
    // others. And since a forced deferral only resumes if its marker is
    // cleared, a failed write must be booked as the failure it is rather than
    // counted among the orderly skips.
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const DONE = "example-com-posts-hello-ai-e8446b12"; // already processed
    chmodSync(join(vault, "articles", DONE, "index.md"), 0o444);

    const logged: string[] = [];
    const report = await runPipeline({ vaultDir: vault, force: true }, config, {
      ...deps,
      chat: async () => {
        throw new Error("no article should reach the LLM");
      },
      deadline: createDeadline(0, () => 0), // out of budget before article 1
      log: (m) => logged.push(m),
    });

    // The run completed rather than throwing out of the loop...
    expect(report.errored).toHaveLength(1);
    expect(report.errored[0]?.slug).toBe(DONE);
    expect(report.errored[0]?.error).toContain(
      "could not be returned to pending",
    );
    // ...and the other articles were still deferred rather than abandoned.
    expect(report.skipped.length).toBeGreaterThan(0);
    expect(report.skipped).not.toContain(DONE);
    // The summary counts what was actually deferred, not what was attempted:
    // an article that cannot resume must not pad the "left pending" figure.
    const summary = logged.find((m) =>
      m.includes("left pending for the next run"),
    );
    expect(summary).toContain(`${report.skipped.length} article(s)`);
  });
});
