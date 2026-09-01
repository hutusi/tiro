import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitBlocks } from "@tiro/shared";
import {
  joinLinkTitles,
  liftDuplicateListMarkers,
  promoteTableHeaders,
  rejoinSplitFootnotes,
  rejoinSplitLinks,
  repairBody,
  repairVault,
} from "../src/repair.ts";

const fixtureVault = join(import.meta.dir, "../../../fixtures/vault");
const EN = "example-com-posts-hello-ai-e8446b12";

function freshVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "tiro-repair-"));
  cpSync(fixtureVault, dir, { recursive: true });
  return dir;
}

describe("joinLinkTitles", () => {
  test("flattens a title that spans lines, so the link terminates", () => {
    // The lone `=` is the whole problem: markdown reads it as a setext
    // underline and turns the paragraph above into an <h1>.
    const broken =
      'the first case of ([1](#S4.E1 "In S1.\n=\nd\n3\nfor ‣ 4.1")) is';
    expect(splitBlocks(broken).map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
    ]);
    const fixed = joinLinkTitles(broken);
    expect(fixed).toBe(
      'the first case of ([1](#S4.E1 "In S1. = d 3 for ‣ 4.1")) is',
    );
    expect(splitBlocks(fixed).map((b) => b.type)).toEqual(["paragraph"]);
  });

  test("leaves a single-line title alone", () => {
    const text = '[x](/a "a title")';
    expect(joinLinkTitles(text)).toBe(text);
  });
});

describe("rejoinSplitLinks", () => {
  test("pulls a link's text back between its brackets", () => {
    const broken = "[\n\n![cap](./assets/x.jpg)\n\n](https://cdn.example/full)";
    expect(splitBlocks(broken)).toHaveLength(3);
    const fixed = rejoinSplitLinks(broken);
    expect(fixed).toBe("[![cap](./assets/x.jpg)](https://cdn.example/full)");
    expect(splitBlocks(fixed)).toHaveLength(1);
  });
});

describe("rejoinSplitFootnotes", () => {
  test("pulls a footnote label back onto its text", () => {
    // Readability rebuilds <br><br>-separated pages into blocks and cuts
    // through the middle of `[<a name="f1n">1</a>] Should students...`,
    // leaving the bracket as a paragraph of its own.
    const broken = "**Notes**\n\n\\[\n\n1\\] Should students still study CS?";
    expect(splitBlocks(broken)).toHaveLength(3);
    const fixed = rejoinSplitFootnotes(broken);
    expect(fixed).toBe("**Notes**\n\n\\[1\\] Should students still study CS?");
    expect(splitBlocks(fixed)).toHaveLength(2);
  });

  test("leaves a bracket that is not a footnote label", () => {
    const text = "\\[\n\nsomething else\\]";
    expect(rejoinSplitFootnotes(text)).toBe(text);
  });
});

describe("promoteTableHeaders", () => {
  test("drops the empty header row and promotes the row below", () => {
    const broken =
      "|     |     |\n| --- | --- |\n| Paper | Idea |\n| Ours | K-A |";
    expect(promoteTableHeaders(broken)).toBe(
      "| Paper | Idea |\n| --- | --- |\n| Ours | K-A |",
    );
  });

  test("leaves a table that already has a header", () => {
    const table = "| Paper | Idea |\n| --- | --- |\n| Ours | K-A |";
    expect(promoteTableHeaders(table)).toBe(table);
  });
});

describe("liftDuplicateListMarkers", () => {
  test("pulls the item's text onto the marker line", () => {
    const broken = "1.  (1)\n    \n    Residual activation functions.\n";
    expect(liftDuplicateListMarkers(broken)).toBe(
      "1.  Residual activation functions.\n",
    );
  });

  test("leaves a label that is the item's whole content", () => {
    const text = "1.  (1)\n2.  (2)";
    expect(liftDuplicateListMarkers(text)).toBe(text);
  });
});

describe("repairBody", () => {
  test("leaves fenced code alone", () => {
    // Every pattern above is a line shape that occurs legitimately in code.
    const body =
      "```\n|     |     |\n| --- | --- |\n| a | b |\n[\n\nx\n\n](y)\n```";
    expect(repairBody(body)).toBe(body);
  });

  test("leaves display math alone", () => {
    const body = "$$\n1.  (1)\n$$";
    expect(repairBody(body)).toBe(body);
  });
});

describe("repairVault", () => {
  test("reports nothing to do for an already-clean vault", async () => {
    const vault = freshVault();
    const report = await repairVault(vault);
    expect(report.repaired).toEqual([]);
    expect(report.refused).toEqual([]);
    expect(report.scanned).toBeGreaterThan(0);
  });

  test("repairs index and translation together", async () => {
    const vault = freshVault();
    const index = join(vault, "articles", EN, "index.md");
    const zh = join(vault, "articles", EN, "zh.md");
    const broken = "\n\n|     |     |\n| --- | --- |\n| Paper | Idea |\n";
    writeFileSync(index, readFileSync(index, "utf8") + broken);
    writeFileSync(zh, readFileSync(zh, "utf8") + broken);

    const report = await repairVault(vault, { slug: EN });
    expect(report.repaired).toEqual([
      { slug: EN, files: ["index.md", "zh.md"] },
    ]);
    expect(readFileSync(index, "utf8")).not.toMatch(/^\|\s+\|\s+\|$/m);
    expect(readFileSync(zh, "utf8")).not.toMatch(/^\|\s+\|\s+\|$/m);
  });

  test("refuses to write a repair that breaks 1:1 alignment", async () => {
    const vault = freshVault();
    const index = join(vault, "articles", EN, "index.md");
    const zh = join(vault, "articles", EN, "zh.md");
    // Aligned before (three paragraphs each), misaligned after: only the index
    // side matches a repair, so it collapses to one block while the
    // translation keeps three. Writing that would drop the whole article to
    // stacked rendering (invariant 4).
    const before = readFileSync(index, "utf8");
    writeFileSync(
      index,
      `${before}\n\n[\n\n![c](./assets/x.png)\n\n](https://e.example)\n`,
    );
    const zhBefore = readFileSync(zh, "utf8");
    writeFileSync(zh, `${zhBefore}\n\n一\n\n二\n\n三\n`);

    const report = await repairVault(vault, { slug: EN });
    expect(report.repaired).toEqual([]);
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0]?.slug).toBe(EN);
    // Refusal must leave both files byte-identical, not half-written.
    expect(readFileSync(index, "utf8")).toBe(
      `${before}\n\n[\n\n![c](./assets/x.png)\n\n](https://e.example)\n`,
    );
  });

  test("dry-run reports the repair without writing it", async () => {
    const vault = freshVault();
    const index = join(vault, "articles", EN, "index.md");
    const zh = join(vault, "articles", EN, "zh.md");
    const broken = "\n\n|     |     |\n| --- | --- |\n| Paper | Idea |\n";
    const before = readFileSync(index, "utf8") + broken;
    writeFileSync(index, before);
    writeFileSync(zh, readFileSync(zh, "utf8") + broken);

    const report = await repairVault(vault, { slug: EN, dryRun: true });
    expect(report.repaired).toHaveLength(1);
    expect(readFileSync(index, "utf8")).toBe(before);
  });
});
