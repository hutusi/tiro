import { describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateVault } from "../src/validate.ts";

const fixtureVault = join(import.meta.dir, "../../../fixtures/vault");
const RAW = "example-org-blog-raw-clip-b5de6fbd";
const EN = "example-com-posts-hello-ai-e8446b12";
const CN = "example-cn-posts-ai-times-0d21367e";

function freshVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "tiro-validate-"));
  cpSync(fixtureVault, dir, { recursive: true });
  return dir;
}

describe("validateVault", () => {
  test("accepts the fixture vault", async () => {
    const vault = freshVault();
    const report = await validateVault(vault);
    expect(report.errors).toEqual([]);
    expect(report.articles).toBe(4);
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a directory whose slug no longer matches its url", async () => {
    const vault = freshVault();
    renameSync(
      join(vault, "articles", RAW),
      join(vault, "articles", "wrong-slug-deadbeef"),
    );
    const report = await validateVault(vault);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain(`expected ${RAW}`);
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a nested article the processor would never see", async () => {
    const vault = freshVault();
    // What `git mv` onto an existing directory silently produces.
    cpSync(join(vault, "articles", RAW), join(vault, "articles", CN, RAW), {
      recursive: true,
    });
    const report = await validateVault(vault);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("nested article");
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a translation with no sibling article", async () => {
    const vault = freshVault();
    mkdirSync(join(vault, "articles", "orphan-translation-abcd1234"));
    writeFileSync(
      join(vault, "articles", "orphan-translation-abcd1234", "zh.md"),
      "孤立的译文。\n",
    );
    const report = await validateVault(vault);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("no sibling index.md");
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a translation beside an article already in the target language", async () => {
    const vault = freshVault();
    writeFileSync(join(vault, "articles", CN, "zh.md"), "不该存在的译文。\n");
    const report = await validateVault(vault);
    expect(
      report.errors.some((e) => e.includes("it must have no translation")),
    ).toBe(true);
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a translation beside an article marked translation_failed", async () => {
    const vault = freshVault();
    const indexPath = join(vault, "articles", EN, "index.md");
    const text = readFileSync(indexPath, "utf8");
    writeFileSync(
      indexPath,
      text.replace(
        "  processed_at:",
        "  translation_failed: true\n  processed_at:",
      ),
    );
    const report = await validateVault(vault);
    expect(
      report.errors.some((e) => e.includes("marked translation_failed")),
    ).toBe(true);
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a processed article with neither a translation nor a marker", async () => {
    const vault = freshVault();
    rmSync(join(vault, "articles", EN, "zh.md"));
    const report = await validateVault(vault);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("neither zh.md nor translation_failed");
    rmSync(vault, { recursive: true, force: true });
  });

  test("exempts a pending article with no translation", async () => {
    const vault = freshVault();
    // The raw clip fixture is pending and has no zh.md — nothing has looked
    // at it yet, so demanding a translation would fail every fresh vault.
    const report = await validateVault(vault);
    expect(report.errors.filter((e) => e.includes(RAW))).toEqual([]);
    rmSync(vault, { recursive: true, force: true });
  });
});
