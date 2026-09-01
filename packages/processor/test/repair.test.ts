import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitBlocks } from "@tiro/shared";
import {
  deindentBlockImages,
  joinLinkTitles,
  liftDuplicateListMarkers,
  promoteTableHeaders,
  rejoinSplitFootnotes,
  rejoinSplitLinks,
  repairBody,
  repairVault,
  stripHeadingAnchors,
} from "../src/repair.ts";

const fixtureVault = join(import.meta.dir, "../../../fixtures/vault");
const EN = "example-com-posts-hello-ai-e8446b12";
const CN = "example-cn-posts-ai-times-0d21367e";

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

  test("flattens a title on a destination with escaped parentheses", () => {
    // Turndown escapes parentheses rather than dropping them, so a bare-paren
    // character class rejected the whole link and left the setext heading in
    // place on every Wikipedia-style `Foo_(disambiguation)` URL.
    const broken = 'x ([1](/a\\(b\\) "In S1.\n=\nd")) y';
    expect(splitBlocks(broken).map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
    ]);
    const fixed = joinLinkTitles(broken);
    expect(fixed).toBe('x ([1](/a\\(b\\) "In S1. = d")) y');
    expect(splitBlocks(fixed).map((b) => b.type)).toEqual(["paragraph"]);
  });

  test("still flattens a title on an angle-bracketed destination", () => {
    const broken = '[x](<https://e.com/a b> "In S1.\n=\nd")';
    expect(joinLinkTitles(broken)).toBe(
      '[x](<https://e.com/a b> "In S1. = d")',
    );
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

describe("stripHeadingAnchors", () => {
  test("drops the trailing permalink anchor, keeping the heading", () => {
    const broken =
      "#### Model selection [#](https://ex.com/p/#model-selection)";
    expect(splitBlocks(broken).map((b) => b.type)).toEqual(["heading"]);
    const fixed = stripHeadingAnchors(broken);
    expect(fixed).toBe("#### Model selection");
    expect(splitBlocks(fixed).map((b) => b.type)).toEqual(["heading"]);
  });

  test("strips an anchor separated by a non-breaking space", () => {
    // Generators emit &nbsp; here so the marker cannot wrap onto its own
    // line. Every heading on the one article in the vault with this defect
    // uses U+00A0, so a pattern accepting only space/tab repairs none of them.
    const broken =
      "#### Model selection\u00a0[#](https://ex.com/p/#model-selection)";
    expect(stripHeadingAnchors(broken)).toBe("#### Model selection");
  });

  test("leaves a heading whose trailing link is real content", () => {
    // Only the symbols generators use for the affordance may match, or a
    // heading that simply ends in a link would lose it.
    const text = "## See [the docs](https://ex.com/docs)";
    expect(stripHeadingAnchors(text)).toBe(text);
  });

  test("leaves an anchor that is not in a heading", () => {
    const text = "A paragraph ending in [#](https://ex.com/p/#x)";
    expect(stripHeadingAnchors(text)).toBe(text);
  });
});

describe("deindentBlockImages", () => {
  test("lifts an image markdown was reading as code", () => {
    const broken = "Regular text is okay:\n\n    ![](./assets/a.avif)";
    expect(splitBlocks(broken).map((b) => b.type)).toEqual([
      "paragraph",
      "code",
    ]);
    const fixed = deindentBlockImages(broken);
    expect(fixed).toBe("Regular text is okay:\n\n![](./assets/a.avif)");
    // The block count must not move, or index.md and zh.md stop aligning.
    expect(splitBlocks(fixed).map((b) => b.type)).toEqual([
      "paragraph",
      "paragraph",
    ]);
  });

  test("leaves indented code that is not purely images", () => {
    const code = "Example:\n\n    const x = 1;\n    ![](./a.png)";
    expect(deindentBlockImages(code)).toBe(code);
  });

  test("leaves an image already nested inside a list", () => {
    // Indentation inside a list belongs to a `list` block, never a top-level
    // `code` block, so this is out of reach by construction.
    const list = "1.  Item\n\n    ![](./a.png)\n";
    expect(splitBlocks(list).map((b) => b.type)).toEqual(["list"]);
    expect(deindentBlockImages(list)).toBe(list);
  });

  test("repairs every image in a document, leaving prose between them", () => {
    const broken =
      "One:\n\n    ![](./a.png)\n\nTwo:\n\n    ![](./b.png)\n\nEnd.\n";
    expect(deindentBlockImages(broken)).toBe(
      "One:\n\n![](./a.png)\n\nTwo:\n\n![](./b.png)\n\nEnd.\n",
    );
  });

  test("runs inside repairBody, which masks verbatim blocks", () => {
    // The regression this pins: the block is `code`, so outsideVerbatim hides
    // it from every transform in TRANSFORMS. Only the pre-pass can reach it.
    const broken = "Text:\n\n    ![](./a.png)";
    expect(repairBody(broken)).toBe("Text:\n\n![](./a.png)");
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

  test("leaves a longer fence alone, inner ``` included", () => {
    // A line scanner reading the first three backticks takes the inner fence
    // for the closer and rewrites the rest of the code as prose.
    const body =
      "````md\n```\n|     |     |\n| --- | --- |\n| a | b |\n```\n````";
    expect(repairBody(body)).toBe(body);
  });

  test("still repairs after a one-line $$ formula", () => {
    // A scanner that opens on `$$` and looks for the close on a later line
    // never closes this one, silently skipping every repair after it.
    const body = "$$E=mc^2$$\n\n1.  (1)\n    \n    Content.\n";
    expect(repairBody(body)).toBe("$$E=mc^2$$\n\n1.  Content.\n");
  });

  test("leaves a fence that shares its line with a list marker alone", () => {
    // Turndown writes code inside an <li> as `-   ```` — opener on the marker
    // line — so a rule demanding whitespace before a fence left every fenced
    // block in every list unprotected, and the line transforms rewrote the
    // code inside them.
    const body =
      "-   ```\n    1.  (1)\n    |     |     |\n    | --- | --- |\n    | a | b |\n    ```";
    expect(repairBody(body)).toBe(body);
  });

  test("leaves a fence in an ordered list item alone", () => {
    const body = "1.  ```\n    1.  (1)\n    ```";
    expect(repairBody(body)).toBe(body);
  });

  test("leaves a fence in a blockquote alone", () => {
    const body = "> ```\n> 1.  (1)\n> ```";
    expect(repairBody(body)).toBe(body);
  });

  test("leaves an indented code block alone", () => {
    const body = "text\n\n    1.  (1)\n\nmore";
    expect(repairBody(body)).toBe(body);
  });

  test("promotes a header on a row that contains inline html", () => {
    // remark reads each <br> in a clipped table cell as an html node. Cutting
    // the text at every verbatim range split the row mid-line and handed
    // promoteTableHeaders half of it, which it mangled — so only ranges that
    // have their lines to themselves are allowed to split.
    const body =
      "|     |     |\n| --- | --- |\n| 1  <br>2 | \\# dig TXT  <br>;; ANSWER |";
    expect(repairBody(body)).toBe(
      "| 1  <br>2 | \\# dig TXT  <br>;; ANSWER |\n| --- | --- |",
    );
  });

  test("leaves an inline code span alone", () => {
    const body = "write `1.  (1)` like this";
    expect(repairBody(body)).toBe(body);
  });

  test("leaves display math alone", () => {
    const body = "$$\n1.  (1)\n$$";
    expect(repairBody(body)).toBe(body);
  });
});

describe("inline verbatim spans", () => {
  // A range sharing its line with prose cannot split the text — that hands a
  // line transform a fragment. It is masked instead, so the three transforms
  // that match across lines find nothing inside it.
  test("leaves a multi-line title inside an inline code span", () => {
    const body = 'Write `[x](/a "line one\nline two")` here.';
    expect(repairBody(body)).toBe(body);
  });

  test("leaves a duplicate marker inside an inline code span", () => {
    const body = "Write `1.  (1)` here.";
    expect(repairBody(body)).toBe(body);
  });

  test("leaves a multi-line title inside inline math", () => {
    const body = 'Value $[a](b "one\ntwo")$ holds.';
    expect(repairBody(body)).toBe(body);
  });

  test("leaves a multi-line title inside inline html", () => {
    const body = 'Use <span title="one\ntwo">x</span> here.';
    expect(repairBody(body)).toBe(body);
  });

  test("does not eat prose that looks like a mask token", () => {
    // A fixed token prefix is a substitution waiting to happen: this
    // repository's own documentation contains the literal string, and an
    // article quoting it had that text replaced by a code span's contents.
    const body =
      "The token TIROVERBATIM0000 appears, and `code` is inline.\n\n|     |     |\n| --- | --- |\n| A | B |";
    expect(repairBody(body)).toBe(
      "The token TIROVERBATIM0000 appears, and `code` is inline.\n\n| A | B |\n| --- | --- |",
    );
  });

  test("lengthens the prefix until the source disagrees", () => {
    const body = "Both TIROVERBATIM0000 and TIROVERBATIMX0000, plus `code`.";
    expect(repairBody(body)).toBe(body);
  });

  test("restores content containing $ replacement patterns", () => {
    // `$$`, `$&`, `` $` `` and `$'` are all replacement syntax, and all occur
    // in the code spans being restored — `$$` is the shell's PID. Passing the
    // original as a string lost a `$`, and `$&` put the token itself into the
    // article.
    for (const inner of ["a$$b", "a$&b", "a$'b"]) {
      const body = "Text `" + inner + '` and title `[x](/a "one\ntwo")` here.';
      expect(repairBody(body)).toContain("`" + inner + "`");
    }
  });

  test("still repairs the prose around a masked span", () => {
    const body = "Use `code` then:\n\n|     |     |\n| --- | --- |\n| A | B |";
    expect(repairBody(body)).toBe(
      "Use `code` then:\n\n| A | B |\n| --- | --- |",
    );
  });
});

describe("articles without a translation", () => {
  test("repairs index.md alone when zh.md is absent", async () => {
    // Contract-valid: a `lang: zh` article must have no translation, and
    // validate errors if one exists. The site renders these `kind: "single"`,
    // never paired, so there is no alignment to break — refusing them would
    // skip every single-language article.
    const vault = freshVault();
    const index = join(vault, "articles", CN, "index.md");
    rmSync(join(vault, "articles", CN, "zh.md"), { force: true });
    const broken = "\n\n|     |     |\n| --- | --- |\n| Paper | Idea |\n";
    writeFileSync(index, readFileSync(index, "utf8") + broken);

    const report = await repairVault(vault, { slug: CN });
    expect(report.refused).toEqual([]);
    expect(report.repaired).toEqual([{ slug: CN, files: ["index.md"] }]);
    expect(readFileSync(index, "utf8")).not.toMatch(/^\|\s+\|\s+\|$/m);
  });
});

describe("CRLF articles", () => {
  test("repairs a CRLF body without mixing line endings", () => {
    // parseArticle accepts CRLF, so an article with it is contract-valid.
    const lf =
      "|     |     |\n| --- | --- |\n| A | B |\n\n1.  (1)\n    \n    Content.\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    const out = repairBody(crlf);
    expect(out).toBe("| A | B |\r\n| --- | --- |\r\n\r\n1.  Content.\r\n");
    // No bare LF anywhere: a repair must not leave a file half-converted.
    expect(/(?<!\r)\n/.test(out)).toBe(false);
  });

  test("normalizes despite a lone CR inside a code fence", () => {
    // A carriage return can legitimately sit inside fenced code — an article
    // about line endings would have one. Treating it as disqualifying sent an
    // otherwise-CRLF body down the direct path, where the two transforms that
    // anchor on "\n" silently did nothing.
    //
    // Built here rather than as a corpus fixture on purpose: the repo has no
    // .gitattributes, so a file whose whole point is one exotic byte is at the
    // mercy of the next checkout's core.autocrlf, and a regression test a
    // checkout can normalize into passing is worse than none.
    const body =
      '**Notes**\r\n\r\n\\[\r\n\r\n1\\] A note.\r\n\r\n```\r\nprintf "a\rb"\r\n```\r\n';
    const out = repairBody(body);
    expect(out).toContain("\\[1\\] A note.");
    // The fence, carriage return included, must come back byte for byte.
    expect(out).toContain('```\r\nprintf "a\rb"\r\n```');
    expect(/(?<!\r)\n/.test(out)).toBe(false);
  });

  test("finds the body of a CRLF article", async () => {
    // The frontmatter pattern used to accept only LF, so the YAML was read as
    // prose, entered the block list, and the article was refused as misaligned.
    const vault = freshVault();
    const index = join(vault, "articles", EN, "index.md");
    const zh = join(vault, "articles", EN, "zh.md");
    const broken = "\n\n|     |     |\n| --- | --- |\n| Paper | Idea |\n";
    writeFileSync(
      index,
      (readFileSync(index, "utf8") + broken).replace(/\n/g, "\r\n"),
    );
    writeFileSync(
      zh,
      (readFileSync(zh, "utf8") + broken).replace(/\n/g, "\r\n"),
    );

    const report = await repairVault(vault, { slug: EN });
    expect(report.refused).toEqual([]);
    expect(report.repaired).toHaveLength(1);
    expect(readFileSync(index, "utf8")).not.toMatch(/^\|\s+\|\s+\|\r?$/m);
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

  test("leaves both files untouched when one write fails", async () => {
    const vault = freshVault();
    const index = join(vault, "articles", EN, "index.md");
    const zh = join(vault, "articles", EN, "zh.md");
    const broken = "\n\n|     |     |\n| --- | --- |\n| Paper | Idea |\n";
    const indexBefore = readFileSync(index, "utf8") + broken;
    const zhBefore = readFileSync(zh, "utf8") + broken;
    writeFileSync(index, indexBefore);
    writeFileSync(zh, zhBefore);
    // A directory where zh.md's staging file goes, so staging it throws while
    // index.md's is already staged. Both originals must survive: a half-repaired
    // pair is the misaligned state checkAlignment exists to prevent.
    mkdirSync(`${zh}.tmp`);

    await expect(repairVault(vault, { slug: EN })).rejects.toThrow();

    expect(readFileSync(index, "utf8")).toBe(indexBefore);
    expect(readFileSync(zh, "utf8")).toBe(zhBefore);
    // The staged half is cleaned up, so the vault's `git add -A` never sees it.
    expect(existsSync(`${index}.tmp`)).toBe(false);
    rmSync(`${zh}.tmp`, { recursive: true });
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
