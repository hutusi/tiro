import { beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
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
const RAW = "2026/example-org-blog-raw-clip-b5de6fbd";

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
      join(vault, "articles/2026/example-com-posts-hello-ai-e8446b12/index.md"),
      "utf8",
    );
    const original = readFileSync(
      join(
        fixtureVault,
        "articles/2026/example-com-posts-hello-ai-e8446b12/index.md",
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
        join(vault, "articles/2026/example-cn-posts-ai-times-0d21367e/zh.md"),
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
