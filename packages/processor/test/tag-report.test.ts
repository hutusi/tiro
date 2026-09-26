import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tagAliases } from "@tiro/shared";
import {
  readTaggedArticles,
  type TaggedArticle,
  tagReport,
} from "../src/tag-report.ts";

const none = new Map<string, string | null>();
const done = (slug: string, tags: string[]): TaggedArticle => ({
  slug,
  tags,
  processed: true,
});

describe("tagReport", () => {
  test("counts distinct tags and the ones only one article carries", () => {
    const report = tagReport(
      [
        done("a", ["rust", "databases"]),
        done("b", ["Rust", "Open-Source"]),
        done("c", ["rust"]),
      ],
      none,
    );
    expect(report.articles).toBe(3);
    expect(report.distinct).toBe(3);
    expect(report.singletons).toBe(2);
    expect(report.vocabulary).toBe(1);
    expect(report.top[0]).toEqual({ tag: "rust", articles: 3 });
  });

  test("lists spellings that are not canonical, and what they become", () => {
    const report = tagReport([done("a", ["Open-Source", "rust"])], none);
    expect(report.nonCanonical).toEqual([
      { tag: "Open-Source", canonical: "open source" },
    ]);
  });

  test("lists tags that are not in English", () => {
    const report = tagReport(
      [done("a", ["知识管理"]), done("b", ["知识管理", "rust"])],
      none,
    );
    expect(report.nonEnglish).toEqual([{ tag: "知识管理", articles: 2 }]);
  });

  test("finds a tag used in both singular and plural", () => {
    const report = tagReport(
      [done("a", ["ai agent"]), done("b", ["ai agents"])],
      none,
    );
    expect(report.plurals).toEqual([["ai agent", "ai agents"]]);
  });

  test("counts as a run would, through the aliases", () => {
    const report = tagReport(
      [done("a", ["llm"]), done("b", ["large language models"])],
      tagAliases({ "large language models": "llm" }),
    );
    expect(report.distinct).toBe(1);
    expect(report.singletons).toBe(0);
  });

  test("flags processed articles outside three to six tags, not pending ones", () => {
    const report = tagReport(
      [
        done("few", ["a"]),
        done("many", ["a", "b", "c", "d", "e", "f", "g"]),
        { slug: "pending", tags: [], processed: false },
      ],
      none,
    );
    expect(report.fewTags).toEqual(["few"]);
    expect(report.manyTags).toEqual(["many"]);
  });
});

describe("readTaggedArticles", () => {
  test("reads the fixture vault, and counts what it cannot read", async () => {
    const vault = mkdtempSync(join(tmpdir(), "tiro-tags-"));
    cpSync(join(import.meta.dir, "../../../fixtures/vault"), vault, {
      recursive: true,
    });
    const before = await readTaggedArticles(vault);
    expect(before.unreadable).toBe(0);
    expect(
      before.articles.find(
        (a) => a.slug === "example-org-blog-raw-clip-b5de6fbd",
      )?.processed,
    ).toBe(false);

    writeFileSync(
      join(vault, "articles", "example-org-blog-raw-clip-b5de6fbd", "index.md"),
      "---\nnot: [valid\n---\n",
    );
    const after = await readTaggedArticles(vault);
    expect(after.unreadable).toBe(1);
    expect(after.articles).toHaveLength(before.articles.length - 1);
  });
});
