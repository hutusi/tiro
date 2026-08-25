import { beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
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
} from "@tiro/shared";
import type { FetchLike } from "../src/llm/client.ts";
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
    const config = await loadVaultConfig(vault);
    // Batch responses carry no markers, and per-block fallbacks split into
    // two paragraphs — every path ends misaligned, so zhBody is null.
    const report = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat: async (request) => {
        if (request.response_format?.type === "json_object") {
          return JSON.stringify({ summary: "s", category: "ai", tags: [] });
        }
        return "第一段。\n\n第二段。";
      },
    });
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
    // Sorts after the RAW fixture, so the failure happens first.
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
    const config = await loadVaultConfig(vault);

    // Same misaligning chat as the translation-failure test above.
    const report = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat: async (request) => {
        if (request.response_format?.type === "json_object") {
          return JSON.stringify({ summary: "s", category: "ai", tags: [] });
        }
        return "第一段。\n\n第二段。";
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
    writeFileSync(join(assets, "orphanorphan.png"), "not really a png");
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
    writeFileSync(join(assets, "orphanorphan.png"), "not really a png");
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
