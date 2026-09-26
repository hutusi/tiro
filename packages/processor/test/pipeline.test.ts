import { beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAlignment,
  LOCAL_DOCUMENT_DOMAIN,
  localDocumentUrl,
  needsProcessing,
  parseArticle,
  slugForUrl,
  splitBlocks,
  stringifyArticle,
} from "@tiro/shared";
import { joinPdfPages } from "@tiro/shared/pdf";
import { createDeadline, DeadlineExceededError } from "../src/deadline.ts";
import { TRANSLATION_CACHE_FILE } from "../src/llm/cache.ts";
import {
  type ChatFn,
  ChatHttpError,
  type FetchLike,
} from "../src/llm/client.ts";
import { loadVaultConfig, runPipeline } from "../src/pipeline.ts";
import { makeFakeChat, makePdf, makeStyledPdf } from "./helpers.ts";

const fixtureVault = join(import.meta.dir, "../../../fixtures/vault");
const RAW = "example-org-blog-raw-clip-b5de6fbd";
const ZH = "example-cn-posts-ai-times-0d21367e";
const UNLISTED = "example-cn-notes-unlisted-shelf-8145cda3";

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
    expect(frontmatter.title_zh).toBe("测试标题（来自摘要）");
    expect(frontmatter.summary_orig).toBe("An English test summary.");
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

  test("reprocessing an unlisted article keeps it unlisted", async () => {
    // The flag is set by hand and read only by the site, so nothing here would
    // notice its loss: the article would simply reappear in the library after
    // the next run. Covered at the schema level too, but this is the path that
    // actually rewrites vault files.
    const config = await loadVaultConfig(vault);
    const report = await runPipeline(
      { vaultDir: vault, force: true, slug: UNLISTED },
      config,
      deps,
    );
    expect(report.processed).toEqual([UNLISTED]);
    const { frontmatter } = parseArticle(
      readFileSync(join(vault, "articles", UNLISTED, "index.md"), "utf8"),
    );
    expect(frontmatter.unlisted).toBe(true);
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

  test("a summary that fell back to an excerpt leaves no pair", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const report = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat: makeFakeChat({
        summary: { summary: "s", category: "not-in-taxonomy", tags: [] },
      }),
    });
    expect(report.summaryFailed).toEqual([RAW_SLUG]);
    const { frontmatter } = parseArticle(
      readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
    );
    expect(frontmatter.tiro.summary_failed).toBe(true);
    expect(frontmatter.title_zh).toBeUndefined();
    expect(frontmatter.summary_orig).toBeUndefined();
  });

  /**
   * The other route to the same marker, and the one where its meaning is easy
   * to get wrong: the model answered perfectly except that it stopped
   * mid-sentence every time. The article keeps that summary, its category and
   * its tags — nothing falls back — and is flagged all the same, so a summary
   * nobody would otherwise notice is greppable in the vault.
   */
  test("marks an article whose summary was cut every time, and keeps the text", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const report = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat: makeFakeChat({
        summary: {
          summary: "本文提出了三个论点，第一个是",
          category: "ai",
          tags: ["t"],
        },
      }),
    });
    expect(report.summaryFailed).toEqual([RAW_SLUG]);
    const { frontmatter } = parseArticle(
      readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
    );
    expect(frontmatter.tiro.summary_failed).toBe(true);
    // The model's reading of the article, not the body's first paragraph.
    expect(frontmatter.summary).toBe("本文提出了三个论点，第一个是");
    expect(frontmatter.category).toBe("ai");
    expect(frontmatter.tags).toEqual(["t"]);
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

  /**
   * The bug this guards was measured, not feared: a backfill took one article
   * from a 9-character summary to a 5-character one. Neither fallback route can
   * see what it overwrites, so "keep the longest cut reply" means the longest
   * of *this* run's attempts and nothing else.
   */
  test("a failed reprocess does not replace a good summary with a cut one", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    await runPipeline({ vaultDir: vault }, config, deps);
    const good = parseArticle(
      readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
    ).frontmatter;
    expect(good.tiro.summary_failed).toBeUndefined();

    const report = await runPipeline(
      { vaultDir: vault, force: true, slug: RAW_SLUG },
      config,
      {
        ...deps,
        chat: makeFakeChat({
          summary: {
            summary: "本文提出了三个论点，第一个是",
            category: "ai",
            tags: ["t"],
          },
        }),
      },
    );
    const { frontmatter } = parseArticle(
      readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
    );
    // Still flagged — the run really did fail, and the article needs a look.
    expect(report.summaryFailed).toEqual([RAW_SLUG]);
    expect(frontmatter.tiro.summary_failed).toBe(true);
    // But the reader keeps the finished summary rather than the fragment.
    expect(frontmatter.summary).toBe(good.summary);
    expect(frontmatter.summary).not.toBe("本文提出了三个论点，第一个是");
    // The pair moves together (ADR 0016) rather than mixing two replies.
    expect(frontmatter.summary_orig).toBe(good.summary_orig);
  });

  /**
   * The other direction, and the one that keeps the guard from becoming a
   * ratchet: when the run succeeds, this run's summary wins outright — a
   * re-clip whose body changed must not be described by the old one.
   */
  test("a successful reprocess still replaces the existing summary", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat: makeFakeChat({
        summary: {
          summary: "本文提出了三个论点，第一个是",
          category: "ai",
          tags: ["t"],
        },
      }),
    });
    const report = await runPipeline(
      { vaultDir: vault, force: true, slug: RAW_SLUG },
      config,
      deps,
    );
    expect(report.summaryFailed).toEqual([]);
    const { frontmatter } = parseArticle(
      readFileSync(join(vault, "articles", RAW, "index.md"), "utf8"),
    );
    expect(frontmatter.summary).not.toBe("本文提出了三个论点，第一个是");
    expect(frontmatter.tiro.summary_failed).toBeUndefined();
  });
});

describe("the translated pair", () => {
  test("an article already in the target language gets no pair, and is never asked", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const prompts: string[] = [];
    // The fake volunteers a title for every summary request; the gate, not the
    // model's restraint, is what has to keep it out of a Chinese original.
    await runPipeline({ vaultDir: vault, force: true, slug: ZH }, config, {
      ...deps,
      chat: makeFakeChat({
        onRequest: (request) => {
          if (request.response_format?.type === "json_object") {
            prompts.push(
              request.messages.find((m) => m.role === "system")?.content ?? "",
            );
          }
        },
      }),
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("title_zh");
    const { frontmatter } = parseArticle(
      readFileSync(join(vault, "articles", ZH, "index.md"), "utf8"),
    );
    expect(frontmatter.lang).toBe("zh");
    expect(frontmatter.title_zh).toBeUndefined();
    expect(frontmatter.summary_orig).toBeUndefined();
  });

  test("--force clears a title the article no longer has", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const indexAbs = join(vault, "articles", ZH, "index.md");
    // What a re-clip into the Chinese branch leaves behind: a translated title
    // for a title that no longer needs one.
    const stale = parseArticle(readFileSync(indexAbs, "utf8"));
    writeFileSync(
      indexAbs,
      stringifyArticle(
        { ...stale.frontmatter, title_zh: "过时的标题" },
        stale.body,
      ),
    );

    await runPipeline({ vaultDir: vault, force: true, slug: ZH }, config, deps);
    const { frontmatter } = parseArticle(readFileSync(indexAbs, "utf8"));
    expect(frontmatter.title_zh).toBeUndefined();
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

describe("a provider outage", () => {
  /** Five pending articles with equal bodies, so they run in slug order, and
   * the fixture's own pending clip moved out of the way. Each body names its
   * article, which is how a chat below decides whom to fail. */
  function outageVault(): { vault: string; slugs: string[] } {
    const vault = freshVault();
    rmSync(join(vault, "articles", RAW), { recursive: true });
    const slugs = ["a", "b", "c", "d", "e"].map(
      (n) => `zz-outage-${n}-aaaaaaaa`,
    );
    for (const [i, slug] of slugs.entries()) {
      mkdirSync(join(vault, "articles", slug), { recursive: true });
      writeFileSync(
        join(vault, "articles", slug, "index.md"),
        [
          "---",
          `url: "https://example.net/outage/${i}"`,
          `title: "Outage ${i}"`,
          'domain: "example.net"',
          'clipped_at: "2026-08-23T09:00:00.000Z"',
          "tiro:",
          "  schema: 1",
          "---",
          "",
          `Body of article number ${i} in the outage set.`,
          "",
        ].join("\n"),
      );
    }
    return { vault, slugs };
  }

  /** Fails the articles whose body mentions one of `numbers` with `error`. */
  function failing(numbers: number[], error: () => unknown) {
    const healthy = makeFakeChat();
    let calls = 0;
    const chat: ChatFn = async (request) => {
      calls += 1;
      const user =
        request.messages.find((m) => m.role === "user")?.content ?? "";
      if (numbers.some((n) => user.includes(`article number ${n} `))) {
        throw error();
      }
      return healthy(request);
    };
    return { chat, calls: () => calls };
  }

  test("stops after three in a row, leaving the rest pending and untouched", async () => {
    const { vault, slugs } = outageVault();
    const config = await loadVaultConfig(vault);
    const before = slugs.map((slug) =>
      readFileSync(join(vault, "articles", slug, "index.md"), "utf8"),
    );
    const { chat, calls } = failing(
      [0, 1, 2, 3, 4],
      () => new ChatHttpError(503, "busy"),
    );
    const report = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat,
    });

    expect(report.errored.map((e) => e.slug)).toEqual(slugs.slice(0, 3));
    expect(report.halted).toEqual(slugs.slice(3));
    expect(report.skipped).toEqual([]);
    // The halted two never reached the provider.
    expect(calls()).toBe(3);
    for (const [i, slug] of slugs.entries()) {
      expect(
        readFileSync(join(vault, "articles", slug, "index.md"), "utf8"),
      ).toBe(before[i] as string);
    }
  });

  test("a failure that is not an outage never stops the run", async () => {
    // A refusal is about one request; the next article may well go through.
    const { vault, slugs } = outageVault();
    const config = await loadVaultConfig(vault);
    const { chat } = failing(
      [0, 1, 2, 3, 4],
      () => new ChatHttpError(400, "data_inspection_failed"),
    );
    const report = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat,
    });
    expect(report.errored.map((e) => e.slug)).toEqual(slugs);
    expect(report.halted).toEqual([]);
  });

  test("an article that goes through ends the streak", async () => {
    const { vault, slugs } = outageVault();
    const config = await loadVaultConfig(vault);
    const { chat } = failing(
      [0, 1, 3, 4],
      () => new ChatHttpError(503, "busy"),
    );
    const report = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat,
    });
    expect(report.processed).toEqual([slugs[2] as string]);
    expect(report.errored).toHaveLength(4);
    expect(report.halted).toEqual([]);
  });

  test("a forced article it stops before returns to pending", async () => {
    // Forced discovery takes processed articles too. One left with its marker
    // would be skipped by the next ordinary run — the same trap the budget's
    // deferral had to close.
    const { vault, slugs } = outageVault();
    const config = await loadVaultConfig(vault);
    await runPipeline({ vaultDir: vault }, config, deps);
    const done = (slug: string) =>
      !needsProcessing(
        parseArticle(
          readFileSync(join(vault, "articles", slug, "index.md"), "utf8"),
        ).frontmatter,
      );
    expect(slugs.every(done)).toBe(true);

    const report = await runPipeline({ vaultDir: vault, force: true }, config, {
      ...deps,
      chat: async () => {
        throw new ChatHttpError(401, "bad key");
      },
    });
    expect(report.halted.length).toBeGreaterThan(0);
    for (const slug of report.halted) expect(done(slug)).toBe(false);
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

  test("--force reuses translations, because the key guarantees they fit", async () => {
    // ADR 0008: force means "reprocess this article", and a content-addressed
    // key already guarantees a cached translation is only ever returned for
    // byte-identical input. Re-billing for identical output is waste. The
    // levers for genuinely fresh translations are changing the model or target
    // in tiro.yml, which invalidates the file wholesale, or deleting it.
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    await runPipeline({ vaultDir: vault, slug: BIG }, config, {
      ...deps,
      chat: makeFakeChat(),
    });

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
    expect(forced.processed).toEqual([BIG]);
    // The summary is re-requested; the translation is not re-bought.
    expect(translationCalls).toBe(0);
  });

  test("a hard failure during --force returns the article to pending", async () => {
    // Invariant 7 leaves a failed article pending, which used to be automatic:
    // an article was only discovered when it had no marker. A forced one
    // enters with `processed_at`, so a provider outage mid-redo would leave it
    // marked processed and quietly retired, while the report claimed it was
    // pending and would be retried.
    const vault = withBigArticle();
    const config = await tinyConfig(vault);
    await runPipeline({ vaultDir: vault, slug: RAW }, config, {
      ...deps,
      chat: makeFakeChat(),
    });
    const indexAbs = join(vault, "articles", RAW, "index.md");
    expect(
      needsProcessing(parseArticle(readFileSync(indexAbs, "utf8")).frontmatter),
    ).toBe(false);

    const forced = await runPipeline(
      { vaultDir: vault, slug: RAW, force: true },
      config,
      {
        ...deps,
        chat: async () => {
          throw new Error("provider 403");
        },
      },
    );
    expect(forced.errored.map((e) => e.slug)).toEqual([RAW]);
    expect(forced.errored[0]?.staysPending).toBe(true);
    // And it really is pending, so the next ordinary run picks it up.
    expect(
      needsProcessing(parseArticle(readFileSync(indexAbs, "utf8")).frontmatter),
    ).toBe(true);
    const followUp = await runPipeline({ vaultDir: vault, slug: RAW }, config, {
      ...deps,
      chat: makeFakeChat(),
    });
    expect(followUp.processed).toContain(RAW);
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

    // This test is about deferral and markPending, not about caching: drop the
    // checkpoint so the forced redo actually has translation to pay for.
    // Without this the run finishes inside the budget and never defers,
    // because a finished article now keeps its translations (ADR 0010).
    rmSync(join(vault, "articles", BIG, TRANSLATION_CACHE_FILE));

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

/** Count only the structure pass; summarize and translate call out too. */
function countingChat(seen: { calls: number }): ChatFn {
  return async (request) => {
    const system =
      request.messages.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("restore structure to text extracted from a PDF")) {
      seen.calls += 1;
    }
    return makeFakeChat()(request);
  };
}

describe("runPipeline with a PDF stub", () => {
  const PDF_URL = "https://example.com/papers/method.pdf";

  /** A clipped PDF as the extension writes it: identity and title, no body.
   * The document itself is fetched at processing time (ADR 0026). */
  async function stubVault(): Promise<{ dir: string; slug: string }> {
    const dir = freshVault();
    const slug = await slugForUrl(PDF_URL);
    mkdirSync(join(dir, "articles", slug), { recursive: true });
    writeFileSync(
      join(dir, "articles", slug, "index.md"),
      stringifyArticle(
        {
          url: PDF_URL,
          title: "A Method For Something",
          domain: "example.com",
          clipped_at: "2026-09-19T10:00:00.000Z",
          tiro: { schema: 1, source_media: "pdf" },
        },
        "",
      ),
    );
    return { dir, slug };
  }

  const servePdf =
    (bytes: Uint8Array): FetchLike =>
    async (input) =>
      String(input).endsWith(".pdf")
        ? new Response(bytes, {
            headers: { "content-type": "application/pdf" },
          })
        : new Response("offline", { status: 404 });

  test("builds the body from the PDF and marks the article processed", async () => {
    const { dir, slug } = await stubVault();
    // Long enough to clear the density gate, which is what a real page is.
    const pdf = makePdf([
      "Section 1\nThe method is straightforward to imple-\nment, is computationally efficient, and has little memory requirement to speak of.",
      "Section 2\nIt is invariant to diagonal rescaling of the gradients and well suited to problems large in data or in parameters.",
    ]);
    const config = await loadVaultConfig(dir);
    await runPipeline({ vaultDir: dir }, config, {
      ...deps,
      fetchImpl: servePdf(pdf),
    });

    const article = parseArticle(
      readFileSync(join(dir, "articles", slug, "index.md"), "utf8"),
    );
    expect(needsProcessing(article.frontmatter)).toBe(false);
    // The stub had no body; this one came out of the PDF.
    expect(article.body).toContain("## Section 1");
    expect(article.body).toContain("little memory");
    // The hyphenated line break was rejoined.
    expect(article.body).toContain("implement");
    // And the marker survived the round-trip, so a later audit can still find
    // every article built this way.
    expect(article.frontmatter.tiro.source_media).toBe("pdf");
  });

  test("a PDF whose layout reads cleanly converts with no model call", async () => {
    // The point of ADR 0028: where the document's own typography says what its
    // structure is, that is the answer — better than a model inferring it from
    // wording, and free.
    const { dir, slug } = await stubVault();
    const body =
      "The method is straightforward to implement and efficient in practice.";
    const pdf = makeStyledPdf([
      [
        { text: "A Document Title", size: 20, face: "bold" },
        { text: "Chapter One", size: 16, face: "bold" },
        { text: body },
        { text: body },
        { text: "SELECT id FROM users", face: "courier" },
      ],
    ]);
    const config = await loadVaultConfig(dir);
    const seen = { calls: 0 };
    await runPipeline({ vaultDir: dir }, config, {
      ...deps,
      fetchImpl: servePdf(pdf),
      chat: countingChat(seen),
    });

    const article = parseArticle(
      readFileSync(join(dir, "articles", slug, "index.md"), "utf8"),
    );
    expect(seen.calls).toBe(0);
    expect(article.body).toContain("# A Document Title");
    expect(article.body).toContain("## Chapter One");
    expect(article.body).toContain("```");
    expect(article.body).toContain("SELECT id FROM users");
  });

  test("a PDF with no legible layout still uses the model", async () => {
    // The fallback earns its keep on exactly the documents that have nothing
    // to read: one size, one face.
    const { dir, slug } = await stubVault();
    // Comfortably over the density gate: at 99 chars a page this was refused
    // before it could reach the model at all, and proved nothing.
    const body =
      "The method is straightforward to implement, is computationally efficient, has little memory requirement, and is invariant to diagonal rescaling of the gradients.";
    const config = await loadVaultConfig(dir);
    const seen = { calls: 0 };
    await runPipeline({ vaultDir: dir }, config, {
      ...deps,
      fetchImpl: servePdf(makePdf([body, body])),
      chat: countingChat(seen),
    });
    expect(seen.calls).toBeGreaterThan(0);
    expect(
      parseArticle(
        readFileSync(join(dir, "articles", slug, "index.md"), "utf8"),
      ).body.length,
    ).toBeGreaterThan(0);
  });

  test("an unchanged re-clip reuses the conversion it already paid for", async () => {
    // A web re-clip re-downloads the document, so unchanged bytes give
    // unchanged batches and reuse is the whole point of the checkpoint — for
    // a long PDF this is a great many model calls. A document that really
    // changed misses the cache on its own, by content.
    const { dir, slug } = await stubVault();
    const pdf = makePdf([
      "Section 1\nThe method is straightforward to imple-\nment, is computationally efficient, and has little memory requirement to speak of.",
    ]);
    const config = await loadVaultConfig(dir);
    const first = { calls: 0 };
    await runPipeline({ vaultDir: dir }, config, {
      ...deps,
      fetchImpl: servePdf(pdf),
      chat: countingChat(first),
    });
    expect(first.calls).toBeGreaterThan(0);

    // A re-clip: same URL and bytes, a fresh clip time, back to a bodyless
    // stub. The clip time moving must not throw the conversion away.
    const path = join(dir, "articles", slug, "index.md");
    const clipped = parseArticle(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      stringifyArticle(
        {
          ...clipped.frontmatter,
          clipped_at: "2026-09-21T09:00:00.000Z",
          tiro: { schema: 1 as const, source_media: "pdf" as const },
        },
        "",
      ),
    );

    const again = { calls: 0 };
    await runPipeline({ vaultDir: dir }, config, {
      ...deps,
      fetchImpl: servePdf(pdf),
      chat: countingChat(again),
    });
    expect(again.calls).toBe(0);
  });

  test("a forced redo reconverts rather than resuming the checkpoint", async () => {
    // --force is how the runbook says to retry a conversion that came out
    // badly. Resuming would make it a no-op: every batch is checkpointed,
    // fallbacks included, so a forced run would replay the very results being
    // complained about.
    const { dir, slug } = await stubVault();
    const pdf = makePdf([
      "Section 1\nThe method is straightforward to imple-\nment, is computationally efficient, and has little memory requirement to speak of.",
    ]);
    const config = await loadVaultConfig(dir);

    let structureCalls = 0;
    const counting: ChatFn = async (request) => {
      const system =
        request.messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("restore structure to text extracted from a PDF")) {
        structureCalls += 1;
      }
      return makeFakeChat()(request);
    };
    await runPipeline({ vaultDir: dir }, config, {
      ...deps,
      chat: counting,
      fetchImpl: servePdf(pdf),
    });
    expect(structureCalls).toBeGreaterThan(0);
    expect(
      existsSync(join(dir, "articles", slug, ".tiro-pdf-cache.json")),
    ).toBe(true);

    structureCalls = 0;
    await runPipeline({ vaultDir: dir, slug, force: true }, config, {
      ...deps,
      chat: counting,
      fetchImpl: servePdf(pdf),
    });
    // Reconverted, not replayed: the checkpoint was discarded first.
    expect(structureCalls).toBeGreaterThan(0);
  });

  test("refuses a forced redo it cannot invalidate the checkpoint for", async () => {
    // --force must never silently become a no-op. If the checkpoint can be
    // neither removed nor emptied, converting would either replay the stale
    // results or drop this run's, and both end with the article marked
    // processed over content nobody asked for.
    const { dir, slug } = await stubVault();
    const pdf = makePdf([
      "Section 1\nThe method is straightforward to imple-\nment, is computationally efficient, and has little memory requirement to speak of.",
    ]);
    const config = await loadVaultConfig(dir);
    await runPipeline({ vaultDir: dir }, config, {
      ...deps,
      fetchImpl: servePdf(pdf),
    });
    const before = parseArticle(
      readFileSync(join(dir, "articles", slug, "index.md"), "utf8"),
    ).body;

    const articleDir = join(dir, "articles", slug);
    chmodSync(articleDir, 0o555); // no unlink, and no rename in either
    try {
      const report = await runPipeline(
        { vaultDir: dir, slug, force: true },
        config,
        {
          ...deps,
          fetchImpl: servePdf(pdf),
        },
      );
      expect(report.errored.length).toBe(1);
      expect(report.errored[0]?.error).toMatch(/--force cannot reconvert/);
    } finally {
      chmodSync(articleDir, 0o755);
    }

    // The body it could not honour the flag for survives. The frontmatter does
    // change: a forced article that fails is returned to pending, which is the
    // pipeline's own markPending path and the reason it can be retried at all.
    const after = parseArticle(
      readFileSync(join(dir, "articles", slug, "index.md"), "utf8"),
    );
    expect(after.body).toBe(before);
    expect(needsProcessing(after.frontmatter)).toBe(true);
  });

  test("an ordinary reprocess resumes from the checkpoint", async () => {
    // The other half: without --force a second run must not re-send batches it
    // already has, which is what lets a long PDF finish across runs at all.
    const { dir, slug } = await stubVault();
    const pdf = makePdf([
      "Section 1\nThe method is straightforward to imple-\nment, is computationally efficient, and has little memory requirement to speak of.",
    ]);
    const config = await loadVaultConfig(dir);
    await runPipeline({ vaultDir: dir }, config, {
      ...deps,
      fetchImpl: servePdf(pdf),
    });

    // Return it to pending the way a re-clip would, body and all.
    const path = join(dir, "articles", slug, "index.md");
    const done = parseArticle(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      stringifyArticle(
        { ...done.frontmatter, tiro: { schema: 1, source_media: "pdf" } },
        "",
      ),
    );

    // Counted by the structure pass's own system prompt: the summarize and
    // translate stages call the model too, so a bare tally would prove nothing
    // about which stage was answered from disk.
    let structureCalls = 0;
    const counting: ChatFn = async (request) => {
      const system =
        request.messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("restore structure to text extracted from a PDF")) {
        structureCalls += 1;
      }
      return makeFakeChat()(request);
    };
    await runPipeline({ vaultDir: dir }, config, {
      ...deps,
      chat: counting,
      fetchImpl: servePdf(pdf),
    });

    // Nothing re-sent, and the body was still rebuilt — which is what lets a
    // long PDF finish across runs at all.
    expect(structureCalls).toBe(0);
    const article = parseArticle(readFileSync(path, "utf8"));
    expect(article.body).toContain("## Section 1");
  });

  test("leaves the article pending when the PDF cannot be read", async () => {
    // Invariant 7: a hard failure leaves it pending and never fails the run, so
    // a later run — or a later version of the extractor — retries it.
    const { dir, slug } = await stubVault();
    const scanned = makePdf(["", "", ""]);
    const config = await loadVaultConfig(dir);
    const report = await runPipeline({ vaultDir: dir }, config, {
      ...deps,
      fetchImpl: servePdf(scanned),
    });

    const article = parseArticle(
      readFileSync(join(dir, "articles", slug, "index.md"), "utf8"),
    );
    expect(needsProcessing(article.frontmatter)).toBe(true);
    expect(article.body).toBe("");
    // Other articles in the vault still processed.
    expect(report.errored.length).toBeGreaterThan(0);
  });

  test("leaves the article pending when the URL does not serve a PDF", async () => {
    // A rate-limit interstitial or a login page must never be filed as the
    // document: the magic-byte check is what refuses it.
    const { dir, slug } = await stubVault();
    const config = await loadVaultConfig(dir);
    await runPipeline({ vaultDir: dir }, config, {
      ...deps,
      fetchImpl: async () =>
        new Response("<html>sign in</html>", {
          headers: { "content-type": "application/pdf" },
        }),
    });

    const article = parseArticle(
      readFileSync(join(dir, "articles", slug, "index.md"), "utf8"),
    );
    expect(needsProcessing(article.frontmatter)).toBe(true);
  });
});

describe("runPipeline with an imported local document", () => {
  const NAME = "stacked-prs-guide.pdf";
  const PAGE = (n: number) =>
    `Section ${n}\nThe method is straightforward to imple-\nment, is computationally efficient, and needs little memory to speak of.`;

  /** A local import as the extension writes it: the text already extracted,
   * pages separated, filed under a `local:` identity (ADR 0027). */
  async function importedVault(): Promise<{ dir: string; slug: string }> {
    const dir = freshVault();
    const url = localDocumentUrl(NAME);
    const slug = await slugForUrl(url);
    mkdirSync(join(dir, "articles", slug), { recursive: true });
    writeFileSync(
      join(dir, "articles", slug, "index.md"),
      stringifyArticle(
        {
          url,
          title: "Stacked PRs",
          domain: LOCAL_DOCUMENT_DOMAIN,
          clipped_at: "2026-09-20T10:00:00.000Z",
          unlisted: true,
          tiro: { schema: 1, source_media: "pdf", pdf_unstructured: true },
        },
        joinPdfPages([PAGE(1), PAGE(2)]),
      ),
    );
    return { dir, slug };
  }

  /** Fails the test if anything tries to reach the network for this article.
   * The whole point is that the bytes are unreachable from CI. */
  const noFetch: FetchLike = async (input) => {
    throw new Error(`unexpected fetch: ${String(input)}`);
  };

  test("restructures the extracted text without fetching anything", async () => {
    const { dir, slug } = await importedVault();
    const config = await loadVaultConfig(dir);
    await runPipeline({ vaultDir: dir, slug }, config, {
      ...deps,
      fetchImpl: noFetch,
    });

    const article = parseArticle(
      readFileSync(join(dir, "articles", slug, "index.md"), "utf8"),
    );
    expect(needsProcessing(article.frontmatter)).toBe(false);
    expect(article.body).toContain("## Section 1");
    expect(article.body).toContain("## Section 2");
    // The hyphenated break was rejoined, and the separators are gone.
    expect(article.body).toContain("implement");
    expect(article.body).not.toContain("\f");
  });

  test("keeps the local identity and the unlisted flag", async () => {
    const { dir, slug } = await importedVault();
    const config = await loadVaultConfig(dir);
    await runPipeline({ vaultDir: dir, slug }, config, {
      ...deps,
      fetchImpl: noFetch,
    });
    const { frontmatter } = parseArticle(
      readFileSync(join(dir, "articles", slug, "index.md"), "utf8"),
    );
    expect(frontmatter.url).toBe(localDocumentUrl(NAME));
    expect(frontmatter.domain).toBe(LOCAL_DOCUMENT_DOMAIN);
    expect(frontmatter.unlisted).toBe(true);
    expect(frontmatter.tiro.source_media).toBe("pdf");
  });

  test("a forced redo keeps the converted body instead of restructuring it", async () => {
    // A converted body has no page separators left, and batching never splits
    // a page — so restructuring again would send the whole document as one
    // request. There is also nothing to re-derive: the bytes were never in the
    // vault. Re-importing the file is how to start over (ADR 0027).
    const { dir, slug } = await importedVault();
    const config = await loadVaultConfig(dir);
    await runPipeline({ vaultDir: dir, slug }, config, {
      ...deps,
      fetchImpl: noFetch,
    });
    const converted = parseArticle(
      readFileSync(join(dir, "articles", slug, "index.md"), "utf8"),
    ).body;
    expect(converted).toContain("## Section 1");

    let structureCalls = 0;
    await runPipeline({ vaultDir: dir, slug, force: true }, config, {
      ...deps,
      fetchImpl: noFetch,
      chat: async (request) => {
        const system =
          request.messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("restore structure to text extracted from a PDF")) {
          structureCalls += 1;
        }
        return makeFakeChat()(request);
      },
    });

    const after = parseArticle(
      readFileSync(join(dir, "articles", slug, "index.md"), "utf8"),
    );
    expect(structureCalls).toBe(0);
    expect(after.body).toBe(converted);
    // And --force still did everything it can still do.
    expect(needsProcessing(after.frontmatter)).toBe(false);
  });

  test("a deferred forced run does not leave the body looking unconverted", async () => {
    // The trap the flag exists for. markPending strips processed_at when a
    // forced run is deferred and keeps the finished body, so a marker-based
    // check saw "unconverted" over Markdown — and the next ordinary run fed it
    // back through the structure pass as one batch.
    const { dir, slug } = await importedVault();
    const config = await loadVaultConfig(dir);
    await runPipeline({ vaultDir: dir, slug }, config, {
      ...deps,
      fetchImpl: noFetch,
    });
    const path = join(dir, "articles", slug, "index.md");
    const converted = parseArticle(readFileSync(path, "utf8"));
    expect(converted.frontmatter.tiro.pdf_unstructured).toBeUndefined();

    // Exactly what a deferred --force leaves behind: no marker, finished body.
    const { processed_at: _gone, ...tiro } = converted.frontmatter.tiro;
    writeFileSync(
      path,
      stringifyArticle({ ...converted.frontmatter, tiro }, converted.body),
    );

    let structureCalls = 0;
    await runPipeline({ vaultDir: dir }, config, {
      ...deps,
      fetchImpl: noFetch,
      chat: async (request) => {
        const system =
          request.messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("restore structure to text extracted from a PDF")) {
          structureCalls += 1;
        }
        return makeFakeChat()(request);
      },
    });

    expect(structureCalls).toBe(0);
    expect(parseArticle(readFileSync(path, "utf8")).body).toBe(converted.body);
  });

  /** Overwrite the article the way a fresh import does: the same extracted
   * text, unconverted again, and a new clip time. */
  function reimport(dir: string, slug: string, clippedAt: string): void {
    const path = join(dir, "articles", slug, "index.md");
    const existing = parseArticle(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      stringifyArticle(
        {
          ...existing.frontmatter,
          clipped_at: clippedAt,
          tiro: {
            schema: 1 as const,
            source_media: "pdf" as const,
            pdf_unstructured: true,
          },
        },
        joinPdfPages([PAGE(1), PAGE(2)]),
      ),
    );
  }

  test("a forced redo leaves the checkpoint of a converted import alone", async () => {
    // It is not going to convert, so it has no business discarding the
    // checkpoint. Loading it before deciding meant --force destroyed work it
    // never looked at.
    const { dir, slug } = await importedVault();
    const config = await loadVaultConfig(dir);
    await runPipeline({ vaultDir: dir, slug }, config, {
      ...deps,
      fetchImpl: noFetch,
    });
    const cacheAbs = join(dir, "articles", slug, ".tiro-pdf-cache.json");
    expect(existsSync(cacheAbs)).toBe(true);
    const before = readFileSync(cacheAbs, "utf8");

    await runPipeline({ vaultDir: dir, slug, force: true }, config, {
      ...deps,
      fetchImpl: noFetch,
    });
    expect(readFileSync(cacheAbs, "utf8")).toBe(before);
  });

  test("and does not fail over a checkpoint it was never going to use", async () => {
    // The sharper half. A checkpoint that can be neither removed nor emptied
    // fails a forced conversion on purpose — but this article is not being
    // converted, so refusing it would be a failure invented out of
    // housekeeping.
    const { dir, slug } = await importedVault();
    const config = await loadVaultConfig(dir);
    await runPipeline({ vaultDir: dir, slug }, config, {
      ...deps,
      fetchImpl: noFetch,
    });
    const body = parseArticle(
      readFileSync(join(dir, "articles", slug, "index.md"), "utf8"),
    ).body;

    const articleDir = join(dir, "articles", slug);
    chmodSync(articleDir, 0o555); // no unlink, and no rename in either
    try {
      const report = await runPipeline(
        { vaultDir: dir, slug, force: true },
        config,
        { ...deps, fetchImpl: noFetch },
      );
      expect(report.errored).toHaveLength(0);
      expect(report.processed).toContain(slug);
    } finally {
      chmodSync(articleDir, 0o755);
    }

    expect(
      parseArticle(
        readFileSync(join(dir, "articles", slug, "index.md"), "utf8"),
      ).body,
    ).toBe(body);
  });

  test("re-importing the same file actually reconverts it", async () => {
    // The runbook says to re-import when a conversion came out badly. An
    // unchanged file extracts to byte-identical batches, so the checkpoint hit
    // every one of them — fallbacks included — and nothing was retried.
    const { dir, slug } = await importedVault();
    const config = await loadVaultConfig(dir);
    const first = { calls: 0 };
    await runPipeline({ vaultDir: dir, slug }, config, {
      ...deps,
      fetchImpl: noFetch,
      chat: countingChat(first),
    });
    expect(first.calls).toBeGreaterThan(0);

    reimport(dir, slug, "2026-09-21T10:00:00.000Z");
    const again = { calls: 0 };
    await runPipeline({ vaultDir: dir, slug }, config, {
      ...deps,
      fetchImpl: noFetch,
      chat: countingChat(again),
    });
    expect(again.calls).toBe(first.calls);
  });

  test("but a run resuming the same import still reuses its work", async () => {
    // The other half, and the reason this is stamped rather than simply
    // discarded: a long document that stopped on budget must not start over.
    const { dir, slug } = await importedVault();
    const config = await loadVaultConfig(dir);
    await runPipeline({ vaultDir: dir, slug }, config, {
      ...deps,
      fetchImpl: noFetch,
    });

    // Back to unconverted with the *same* clip time — what a budget stop
    // leaves, not what an import leaves.
    const path = join(dir, "articles", slug, "index.md");
    const done = parseArticle(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      stringifyArticle(
        {
          ...done.frontmatter,
          tiro: {
            schema: 1 as const,
            source_media: "pdf" as const,
            pdf_unstructured: true,
          },
        },
        joinPdfPages([PAGE(1), PAGE(2)]),
      ),
    );

    const resumed = { calls: 0 };
    await runPipeline({ vaultDir: dir, slug }, config, {
      ...deps,
      fetchImpl: noFetch,
      chat: countingChat(resumed),
    });
    expect(resumed.calls).toBe(0);
  });

  test("batches by the pages the import preserved", async () => {
    // A body flattened to one string would be sent as a single enormous
    // request, which is why the separators travel with the text.
    const { dir, slug } = await importedVault();
    const config = await loadVaultConfig(dir);
    const seen: string[] = [];
    await runPipeline({ vaultDir: dir, slug }, config, {
      ...deps,
      fetchImpl: noFetch,
      chat: async (request) => {
        const system =
          request.messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("restore structure to text extracted from a PDF")) {
          seen.push(
            request.messages.find((m) => m.role === "user")?.content ?? "",
          );
        }
        return makeFakeChat()(request);
      },
    });
    // Both pages reached the model, and neither carried a separator into the
    // prompt.
    expect(seen.join("\n")).toContain("Section 1");
    expect(seen.join("\n")).toContain("Section 2");
    expect(seen.every((batch) => !batch.includes("\f"))).toBe(true);
  });
});
