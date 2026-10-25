import { describe, expect, test } from "bun:test";
import { parseArticle } from "../src/frontmatter.ts";
import { mergeLead } from "../src/lead.ts";

const DEK =
  "The first installment in a series about the author’s youthful training as a riverboat pilot";
const PICTURE =
  "![](https://cdn.example/media/img/2017/11/River-1/original.jpg)  \nCurrier & Ives / Library of Congress";
const LEAD = `${DEK}\n\n${PICTURE}`;

const FIRST =
  "When I was a boy, there was but one permanent ambition among my comrades in our village.";
const BODY = `${FIRST}\n\nOnce a day a cheap, gaudy packet arrived upward from St. Louis.\n\n![A steamboat](./assets/6295da668701.jpg)\n\nMy father was a justice of the peace.\n`;

/** An article as the processor leaves it: summary, tags, translated title,
 * processed — in the processor's own key order, not the schema's. */
function article(body = BODY, tiroExtra = "", rootExtra = ""): string {
  return `---
url: https://magazine.example/archive/1875/01/old-times/537825
title: Old Times on the River
domain: magazine.example
clipped_at: 2026-10-24T05:13:57.511Z
excerpt: A series about a riverboat pilot
author: Mark Twain
tiro:
  schema: 1
  clipper_version: 0.17.0
  processed_at: 2026-10-24T06:10:40.344Z
  processor_version: 0.1.0${tiroExtra}
lang: en
summary: 一个男孩想当领航员。
category: culture
tags:
  - 历史${rootExtra}
title_zh: 河上旧时光
---

${body}`;
}

/** The clip of the page the lead came from: the lead, then the body. */
const page = (body = BODY) => `${LEAD}\n\n${body}`;

function merged(result: ReturnType<typeof mergeLead>): string {
  if (result.kind !== "merged") throw new Error(`not merged: ${result.kind}`);
  return result.text;
}

describe("mergeLead", () => {
  test("inserts the lead at the top, and changes nothing else in the body", () => {
    const text = merged(mergeLead(article(), LEAD, page()));
    const { body } = parseArticle(text);
    expect(body).toBe(`${LEAD}\n\n${BODY}`);
  });

  test("hands the article back for translation only, keeping its key order", () => {
    const text = merged(mergeLead(article(), LEAD, page()));
    // Exactly two lines of the frontmatter change: the processed mark goes,
    // the refresh hint comes, and every other key stays where it was.
    const expected = article()
      .replace("  processed_at: 2026-10-24T06:10:40.344Z\n", "")
      .replace(
        "  processor_version: 0.1.0\n",
        "  processor_version: 0.1.0\n  refresh: translation\n",
      );
    expect(text.slice(0, text.indexOf("\n---\n", 4))).toBe(
      expected.slice(0, expected.indexOf("\n---\n", 4)),
    );
    const { frontmatter } = parseArticle(text);
    expect(frontmatter.tiro.processed_at).toBeUndefined();
    expect(frontmatter.tiro.refresh).toBe("translation");
    expect(frontmatter.summary).toBe("一个男孩想当领航员。");
  });

  test("is unchanged when the article already has its lead", () => {
    const text = merged(mergeLead(article(), LEAD, page()));
    expect(mergeLead(text, LEAD, page())).toEqual({ kind: "unchanged" });
  });

  test("puts a missing picture under the dek the article opens with", () => {
    const withDek = article(`${DEK}\n\n${BODY}`);
    const result = mergeLead(withDek, LEAD, page());
    expect(result.kind === "merged" && result.added).toEqual([PICTURE]);
    expect(parseArticle(merged(result)).body).toBe(
      `${DEK}\n\n${PICTURE}\n\n${BODY}`,
    );
  });

  test("puts a missing dek above the picture the article opens with", () => {
    const opensWithPicture = `![](./assets/aaaaaaaaaaaa.jpg)  \nCurrier & Ives / Library of Congress\n\n${BODY}`;
    const result = mergeLead(article(opensWithPicture), LEAD, page());
    expect(result.kind === "merged" && result.added).toEqual([DEK]);
    expect(parseArticle(merged(result)).body).toBe(
      `${DEK}\n\n${opensWithPicture}`,
    );
  });

  test("adds no picture to an article that already opens with one", () => {
    const opensWithPicture = `![A steamboat](./assets/bbbbbbbbbbbb.jpg)\n\n${BODY}`;
    const result = mergeLead(article(opensWithPicture), LEAD, page());
    expect(result.kind === "merged" && result.added).toEqual([DEK]);
  });

  test("puts a missing picture at the top when the dek is further down", () => {
    const later = `*This is part one of a series.*\n\n${DEK}\n\n${BODY}`;
    const result = mergeLead(article(later), LEAD, `${LEAD}\n\n${later}`);
    expect(result.kind === "merged" && result.added).toEqual([PICTURE]);
    expect(parseArticle(merged(result)).body).toBe(`${PICTURE}\n\n${later}`);
  });

  test("knows a picture by its caption, or by an address the body still hotlinks", () => {
    const captioned = `${FIRST}\n\nA picture, credited Currier & Ives / Library of Congress, below.\n`;
    const r1 = mergeLead(article(captioned), LEAD, page(captioned));
    expect(r1.kind === "merged" && r1.added).toEqual([DEK]);
    const hotlinked = `${FIRST}\n\n![](https://cdn.example/media/img/2017/11/River-1/original.jpg)\n`;
    const r2 = mergeLead(article(hotlinked), LEAD, page(hotlinked));
    expect(r2.kind === "merged" && r2.added).toEqual([DEK]);
  });

  test("refuses a page that no longer begins where the article does", () => {
    const other =
      "Subscribe to read the rest of this story and every other story we publish.";
    expect(
      mergeLead(article(), LEAD, `${LEAD}\n\n${other}\n\n${BODY}`),
    ).toEqual({
      kind: "refused",
      reason: "the page no longer begins where the article does",
    });
  });

  test("compares paragraphs, not a heading both versions open with", () => {
    const heading = "## Part One: The Boyhood Ambition of a River Town";
    const saved = `${heading}\n\n${BODY}`;
    const rewritten = `${heading}\n\nThis installment was revised after it first ran, and now opens here instead.\n\n${BODY}`;
    expect(mergeLead(article(saved), LEAD, `${LEAD}\n\n${rewritten}`)).toEqual({
      kind: "refused",
      reason: "the page no longer begins where the article does",
    });
    expect(mergeLead(article(saved), LEAD, `${LEAD}\n\n${saved}`).kind).toBe(
      "merged",
    );
  });

  test("needs no page for a lead taken from the article itself", () => {
    const result = mergeLead(article(), DEK, null);
    expect(result.kind === "merged" && result.added).toEqual([DEK]);
  });

  test("asks for everything when there is no summary worth keeping", () => {
    const pending = article().replace(
      "  processed_at: 2026-10-24T06:10:40.344Z\n",
      "",
    );
    expect(
      parseArticle(merged(mergeLead(pending, LEAD, page()))).frontmatter.tiro
        .refresh,
    ).toBeUndefined();
    const failed = article(BODY, "\n  summary_failed: true");
    expect(
      parseArticle(merged(mergeLead(failed, LEAD, page()))).frontmatter.tiro
        .refresh,
    ).toBeUndefined();
  });

  test("keeps a refresh an earlier repair asked for", () => {
    const once = merged(mergeLead(article(), DEK, null));
    const twice = merged(mergeLead(once, LEAD, page()));
    expect(parseArticle(twice).frontmatter.tiro.refresh).toBe("translation");
    expect(parseArticle(twice).body).toBe(`${DEK}\n\n${PICTURE}\n\n${BODY}`);
  });

  test("refuses a lead that is not paragraphs, and an article it cannot read", () => {
    expect(mergeLead(article(), "## A heading", page()).kind).toBe("refused");
    expect(mergeLead("no frontmatter here", LEAD, page()).kind).toBe("refused");
  });

  test("has nothing to do with an empty lead", () => {
    expect(mergeLead(article(), "", page())).toEqual({ kind: "unchanged" });
  });
});
