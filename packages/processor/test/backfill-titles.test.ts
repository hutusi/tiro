import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArticle, stringifyArticle } from "@tiro/shared";
import { backfillTitles } from "../src/backfill-titles.ts";
import { createDeadline } from "../src/deadline.ts";
import type { ChatFn } from "../src/llm/client.ts";
import { loadVaultConfig } from "../src/pipeline.ts";

const fixtureVault = join(import.meta.dir, "../../../fixtures/vault");

const NEEDS_TITLE = "example-net-papers-attention-notes-278b43cb";
const HAS_TITLE = "example-com-posts-hello-ai-e8446b12";
const ZH = "example-cn-posts-ai-times-0d21367e";
const PENDING = "example-org-blog-raw-clip-b5de6fbd";

function freshVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "tiro-backfill-"));
  cpSync(fixtureVault, dir, { recursive: true });
  return dir;
}

function indexOf(vault: string, slug: string): string {
  return readFileSync(join(vault, "articles", slug, "index.md"), "utf8");
}

/** A well-behaved title model. `calls` counts requests, `seen` keeps them. */
function titleChat(titleZh = "缩放点积注意力笔记（译）"): {
  chat: ChatFn;
  calls: () => number;
  seen: () => string[];
} {
  let calls = 0;
  const seen: string[] = [];
  return {
    chat: async (request) => {
      calls += 1;
      seen.push(request.messages.map((m) => m.content).join("\n"));
      return JSON.stringify({ title_zh: titleZh });
    },
    calls: () => calls,
    seen: () => seen,
  };
}

describe("backfillTitles", () => {
  test("fills a missing title and touches nothing else", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const before = {
      zh: readFileSync(join(vault, "articles", NEEDS_TITLE, "zh.md"), "utf8"),
      others: [HAS_TITLE, ZH, PENDING].map((slug) => indexOf(vault, slug)),
    };
    const parsedBefore = parseArticle(indexOf(vault, NEEDS_TITLE));

    const { chat, calls } = titleChat();
    const report = await backfillTitles(vault, config, {}, { chat });

    expect(calls()).toBe(1);
    expect(report.filled).toEqual([
      {
        slug: NEEDS_TITLE,
        title: "Notes on Scaled Dot-Product Attention",
        titleZh: "缩放点积注意力笔记（译）",
      },
    ]);
    expect(report.failed).toEqual([]);

    const after = parseArticle(indexOf(vault, NEEDS_TITLE));
    expect(after.frontmatter.title_zh).toBe("缩放点积注意力笔记（译）");
    // Nothing else moved: not the body, not the translation, not the markers
    // that decide whether the processor will pick this article up again.
    expect(after.body).toBe(parsedBefore.body);
    expect(after.frontmatter.tiro).toEqual(parsedBefore.frontmatter.tiro);
    expect(after.frontmatter.summary).toBe(parsedBefore.frontmatter.summary);
    expect(
      readFileSync(join(vault, "articles", NEEDS_TITLE, "zh.md"), "utf8"),
    ).toBe(before.zh);
    expect(
      [HAS_TITLE, ZH, PENDING].map((slug) => indexOf(vault, slug)),
    ).toEqual(before.others);
  });

  test("the written key lands where the pipeline puts it", async () => {
    // Both writers append after `tags`. If they disagreed, the next --force run
    // would rewrite all 39 articles for nothing but key order.
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const { chat } = titleChat();
    await backfillTitles(vault, config, { slug: NEEDS_TITLE }, { chat });
    const keys = indexOf(vault, NEEDS_TITLE)
      .split("---")[1]
      ?.split("\n")
      .filter((line) => /^\w/.test(line))
      .map((line) => line.split(":")[0]);
    expect(keys?.[keys.length - 1]).toBe("title_zh");
  });

  test("skips an article that has one, and --force redoes it", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const { chat, calls } = titleChat("你好，AI（重译）");

    const skipping = await backfillTitles(
      vault,
      config,
      { slug: HAS_TITLE },
      { chat },
    );
    expect(calls()).toBe(0);
    expect(skipping.skipped).toEqual([
      { slug: HAS_TITLE, reason: "already-translated" },
    ]);

    const forced = await backfillTitles(
      vault,
      config,
      { slug: HAS_TITLE, force: true },
      { chat },
    );
    expect(calls()).toBe(1);
    expect(forced.filled[0]?.titleZh).toBe("你好，AI（重译）");
    expect(parseArticle(indexOf(vault, HAS_TITLE)).frontmatter.title_zh).toBe(
      "你好，AI（重译）",
    );
  });

  test("skips the Chinese original and the pending clip without calling", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const { chat, calls } = titleChat();
    const report = await backfillTitles(vault, config, {}, { chat });
    expect(calls()).toBe(1); // only NEEDS_TITLE
    expect(report.skipped).toContainEqual({ slug: ZH, reason: "zh-original" });
    // A pending article is `run`'s job: it has the body, and it writes the
    // title in the same call as the summary.
    expect(report.skipped).toContainEqual({
      slug: PENDING,
      reason: "pending",
    });
  });

  test("--dry-run makes no calls and writes nothing", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const before = indexOf(vault, NEEDS_TITLE);
    const chat: ChatFn = async () => {
      throw new Error("dry run must not reach the provider");
    };
    const report = await backfillTitles(
      vault,
      config,
      { dryRun: true },
      { chat },
    );
    expect(report.filled).toEqual([
      {
        slug: NEEDS_TITLE,
        title: "Notes on Scaled Dot-Product Attention",
        titleZh: null,
      },
    ]);
    expect(indexOf(vault, NEEDS_TITLE)).toBe(before);
  });

  test("hands the article's own summary over as terminology context", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const { chat, seen } = titleChat();
    await backfillTitles(vault, config, { slug: NEEDS_TITLE }, { chat });
    const summary = parseArticle(indexOf(vault, NEEDS_TITLE)).frontmatter
      .summary;
    expect(summary).toBeDefined();
    expect(seen()[0]).toContain(summary ?? "");
  });

  test("a model that never returns a usable title leaves the article alone", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const before = indexOf(vault, NEEDS_TITLE);
    // An echo of the source title is not a translation, and two attempts of it
    // is a failure rather than a title.
    const chat: ChatFn = async () =>
      JSON.stringify({ title_zh: "Notes on Scaled Dot-Product Attention" });
    const report = await backfillTitles(
      vault,
      config,
      { slug: NEEDS_TITLE },
      { chat },
    );
    expect(report.filled).toEqual([]);
    expect(report.failed).toEqual([
      { slug: NEEDS_TITLE, error: "no usable translation" },
    ]);
    expect(indexOf(vault, NEEDS_TITLE)).toBe(before);
  });

  test("one article's failure does not stop the rest", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    // Two articles want a title; the first request throws, the second answers.
    writeFileSync(
      join(vault, "articles", HAS_TITLE, "index.md"),
      withoutTitleZh(indexOf(vault, HAS_TITLE)),
    );
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      if (calls === 1) throw new Error("provider hiccup");
      return JSON.stringify({ title_zh: "译出的标题" });
    };
    const report = await backfillTitles(vault, config, {}, { chat });
    expect(report.failed).toHaveLength(1);
    expect(report.filled).toHaveLength(1);
  });

  test("stops after three failures in a row rather than repeating them", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    for (const slug of [HAS_TITLE]) {
      writeFileSync(
        join(vault, "articles", slug, "index.md"),
        withoutTitleZh(indexOf(vault, slug)),
      );
    }
    // A third and fourth candidate, so the limit is reachable and provably
    // stops short of the last one.
    for (const slug of [NEEDS_TITLE, HAS_TITLE]) {
      const copy = `zz-copy-${slug}`;
      cpSync(join(vault, "articles", slug), join(vault, "articles", copy), {
        recursive: true,
      });
    }
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      throw new Error("provider down");
    };
    const report = await backfillTitles(vault, config, {}, { chat });
    // Two attempts per article would be four calls for two articles; the
    // circuit breaker counts articles, and each throw is one call.
    expect(calls).toBe(3);
    expect(report.failed).toHaveLength(3);
    expect(report.remaining.length).toBeGreaterThan(0);
  });

  test("stops cleanly when the budget is gone and names what is left", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const { chat, calls } = titleChat();
    const report = await backfillTitles(
      vault,
      config,
      {},
      { chat, deadline: createDeadline(0) },
    );
    expect(calls()).toBe(0);
    expect(report.filled).toEqual([]);
    expect(report.remaining).toContain(NEEDS_TITLE);
  });

  test("--limit caps one invocation and reports the rest as remaining", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    writeFileSync(
      join(vault, "articles", HAS_TITLE, "index.md"),
      withoutTitleZh(indexOf(vault, HAS_TITLE)),
    );
    const { chat, calls } = titleChat();
    const report = await backfillTitles(vault, config, { limit: 1 }, { chat });
    expect(calls()).toBe(1);
    expect(report.filled).toHaveLength(1);
    expect(report.remaining).toHaveLength(1);
  });

  test("an unreadable article is reported, not fatal", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    writeFileSync(
      join(vault, "articles", ZH, "index.md"),
      "no frontmatter here\n",
    );
    const { chat } = titleChat();
    const report = await backfillTitles(vault, config, {}, { chat });
    expect(report.invalid).toHaveLength(1);
    expect(report.filled).toHaveLength(1);
    // Counted, so the CLI can say "0 of 1" rather than "0 of 0" and exit
    // non-zero: an unreadable article got no title, and nothing else reports it.
    expect(report.scanned).toBe(5);
  });
});

/** Strip a fixture's stored title so it becomes a backfill candidate. */
function withoutTitleZh(text: string): string {
  const { frontmatter, body } = parseArticle(text);
  const { title_zh: _drop, ...rest } = frontmatter;
  return stringifyArticle(rest, body);
}
