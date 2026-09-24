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
const UNLISTED = "example-cn-notes-unlisted-shelf-8145cda3";

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
    expect(report.articles).toBe(8);
    expect(report.collections).toBe(3);
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

describe("validateVault on collections", () => {
  function withCollection(name: string, text: string): string {
    const vault = freshVault();
    writeFileSync(join(vault, "collections", name), text);
    return vault;
  }
  const valid = (items: string) =>
    `---\ntitle: "X"\nitems:\n${items}tiro:\n  schema: 1\n---\n`;

  test("a vault that has never had a collection is fine", async () => {
    const vault = freshVault();
    rmSync(join(vault, "collections"), { recursive: true, force: true });
    const report = await validateVault(vault);
    expect(report.errors).toEqual([]);
    expect(report.collections).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a member with no article behind it", async () => {
    const vault = withCollection(
      "reading.md",
      valid(`  - slug: "${EN}"\n  - slug: "gone-deadbeef"\n`),
    );
    const report = await validateVault(vault);
    expect(report.errors).toEqual([
      "collections/reading.md: gone-deadbeef is not an article in this vault",
    ]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("a member whose article failed to parse is still reported", async () => {
    const vault = withCollection("reading.md", valid(`  - slug: "${RAW}"\n`));
    writeFileSync(join(vault, "articles", RAW, "index.md"), "no frontmatter\n");
    const report = await validateVault(vault);
    expect(report.errors).toContain(
      `collections/reading.md: ${RAW} is not an article in this vault`,
    );
    rmSync(vault, { recursive: true, force: true });
  });

  test("accepts a cover that exists, member or not", async () => {
    const vault = withCollection(
      "reading.md",
      `---\ntitle: "X"\ncover: "articles/${EN}/assets/cover.png"\ntiro:\n  schema: 1\n---\n`,
    );
    const report = await validateVault(vault);
    expect(report.errors).toEqual([]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a cover whose file or article is gone, or is unlisted", async () => {
    const withCover = (cover: string) =>
      `---\ntitle: "X"\ncover: "${cover}"\ntiro:\n  schema: 1\n---\n`;
    const vault = withCollection(
      "reading.md",
      withCover(`articles/${EN}/assets/pruned.png`),
    );
    writeFileSync(
      join(vault, "collections", "other.md"),
      withCover("articles/gone-deadbeef/assets/cover.png"),
    );
    // An unlisted article's asset exists, but the site will not show it.
    mkdirSync(join(vault, "articles", UNLISTED, "assets"));
    writeFileSync(join(vault, "articles", UNLISTED, "assets", "c.jpg"), "");
    writeFileSync(
      join(vault, "collections", "shelf.md"),
      withCover(`articles/${UNLISTED}/assets/c.jpg`),
    );
    const report = await validateVault(vault);
    expect(report.errors).toEqual([
      "collections/other.md: cover articles/gone-deadbeef/assets/cover.png names gone-deadbeef, which is not an article in this vault",
      `collections/reading.md: cover articles/${EN}/assets/pruned.png does not exist`,
      `collections/shelf.md: cover articles/${UNLISTED}/assets/c.jpg belongs to an unlisted article, which the site will not show`,
    ]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a member listed twice", async () => {
    const vault = withCollection(
      "reading.md",
      valid(`  - slug: "${EN}"\n  - slug: "${CN}"\n  - slug: "${EN}"\n`),
    );
    const report = await validateVault(vault);
    expect(report.errors).toEqual([
      `collections/reading.md: ${EN} is listed more than once`,
    ]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a filename that cannot be an id", async () => {
    const vault = withCollection("Reading List.md", valid(""));
    const report = await validateVault(vault);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("is not a usable collection id");
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a collection that does not parse", async () => {
    const vault = withCollection(
      "reading.md",
      "---\ntiro:\n  schema: 1\n---\n",
    );
    const report = await validateVault(vault);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toStartWith("collections/reading.md:");
    rmSync(vault, { recursive: true, force: true });
  });

  // The site reads the directory without Bun's glob and so sees hidden files;
  // a hidden `.md` fails its build. Validate has to fail it first.
  test("catches a hidden collection the site would refuse", async () => {
    const vault = withCollection(".reading.md", valid(""));
    const report = await validateVault(vault);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain(
      '".reading" is not a usable collection id',
    );
    rmSync(vault, { recursive: true, force: true });
  });

  test("ignores filesystem litter nothing reads", async () => {
    const vault = withCollection(".DS_Store", "\u0000\u0001");
    writeFileSync(join(vault, "collections", ".gitkeep"), "");
    const report = await validateVault(vault);
    expect(report.errors).toEqual([]);
    expect(report.collections).toBe(3);
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a file the site would never read", async () => {
    const vault = withCollection("reading.yml", "title: X\n");
    mkdirSync(join(vault, "collections", "nested"));
    writeFileSync(join(vault, "collections", "nested", "x.md"), valid(""));
    const report = await validateVault(vault);
    expect(report.errors).toEqual([
      "collections/nested/x.md: not a collection, expected collections/<id>.md",
      "collections/reading.yml: not a collection, expected collections/<id>.md",
    ]);
    rmSync(vault, { recursive: true, force: true });
  });
});
