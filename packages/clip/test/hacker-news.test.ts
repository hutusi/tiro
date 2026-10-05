import { describe, expect, test } from "bun:test";
import { splitBlocks } from "@tiro/shared";
import { Window } from "happy-dom";
import { clipPage } from "../src/clip-page.ts";
import { clipHackerNewsItem, isHackerNewsItem } from "../src/hacker-news.ts";

/**
 * Pages shaped the way news.ycombinator.com serves them — measured on live
 * threads — with invented people and text: this repository is public, and a
 * thread is other people's writing.
 */

const BASE = "https://news.ycombinator.com/";

function parse(html: string): Document {
  const window = new Window({ url: BASE });
  window.document.write(html);
  return window.document as unknown as Document;
}

function page(title: string, head: string, comments: string[]): string {
  return [
    `<html><head><title>${title} | Hacker News</title></head><body><center>`,
    '<table id="hnmain"><tr><td>',
    `<table class="fatitem" border="0">${head}</table>`,
    `<table class="comment-tree" border="0">${comments.join("")}</table>`,
    "</td></tr></table></center></body></html>",
  ].join("");
}

interface StoryOptions {
  id: number;
  title: string;
  href?: string;
  by: string;
  text?: string;
}

function story({ id, title, href, by, text }: StoryOptions): string {
  return [
    `<tr class="athing submission" id="${id}">`,
    '<td class="title"><span class="rank"></span></td>',
    '<td class="votelinks"><center><div class="votearrow"></div></center></td>',
    `<td class="title"><span class="titleline"><a href="${href ?? `item?id=${id}`}">${title}</a>`,
    href === undefined
      ? ""
      : '<span class="sitebit comhead"> (<a href="from?site=example.test"><span class="sitestr">example.test</span></a>)</span>',
    "</span></td></tr>",
    '<tr><td colspan="2"></td><td class="subtext"><span class="subline">',
    `<span class="score">42 points</span> by <a href="user?id=${by}" class="hnuser">${by}</a> `,
    `<span class="age" title="2026-10-01T08:00:00"><a href="item?id=${id}">4 days ago</a></span>`,
    "</span></td></tr>",
    text === undefined
      ? ""
      : `<tr><td colspan="2"></td><td><div class="toptext">${text}</div></td></tr>`,
  ].join("");
}

interface CommentOptions {
  id: number;
  by?: string;
  indent: number;
  text?: string;
  /** What HN puts in `.comment` when there is no text: `[deleted]`, `[flagged]`. */
  marker?: string;
  /** `coll` for a collapsed comment, `noshow` for a reply hidden under one. */
  state?: "coll" | "noshow";
  stamp?: string;
}

function comment({
  id,
  by,
  indent,
  text,
  marker,
  state,
  stamp = "2026-10-01T09:30:00",
}: CommentOptions): string {
  const user =
    by === undefined ? "" : `<a href="user?id=${by}" class="hnuser">${by}</a> `;
  const toggle = state === "coll" ? "[3 more]" : "[–]";
  const body =
    text === undefined
      ? `<div class="comment${state === "coll" ? " noshow" : ""}">${marker ?? ""}<div class="reply"><p><font size="1"></font></div></div>`
      : `<div class="comment${state === "coll" ? " noshow" : ""}"><div class="commtext c00">${text}</div><div class="reply"><p><font size="1"><u><a href="reply?id=${id}&amp;goto=item%3Fid%3D1">reply</a></u></font></div></div>`;
  return [
    `<tr class="athing comtr${state === undefined ? "" : ` ${state}`}" id="${id}"><td><table border="0"><tr>`,
    `<td class="ind" indent="${indent}"><img src="s.gif" height="1" width="${indent * 40}"></td>`,
    '<td valign="top" class="votelinks"><center><div class="votearrow"></div></center></td>',
    '<td class="default"><div style="margin-top:2px; margin-bottom:-10px;"><span class="comhead">',
    user,
    `<span class="age" title="${stamp}"><a href="item?id=${id}">4 days ago</a></span> `,
    `<span class="navs"> | <a class="togg clicky" id="${id}" n="3" href="javascript:void(0)">${toggle}</a></span>`,
    `</span></div><br>${body}</td></tr></table></td></tr>`,
  ].join("");
}

const blocksOf = (markdown: string) => splitBlocks(markdown);

describe("isHackerNewsItem", () => {
  test("a story page is an item", () => {
    const doc = parse(
      page("A story", story({ id: 1, title: "A story", by: "op" }), []),
    );
    expect(isHackerNewsItem(doc)).toBe(true);
  });

  test("the front page is not — a list of stories has no item at its head", () => {
    const doc = parse(
      `<html><body><table id="hnmain"><tr><td><table>${story({ id: 1, title: "A story", by: "op", href: "https://example.test/a" })}</table></td></tr></table></body></html>`,
    );
    expect(isHackerNewsItem(doc)).toBe(false);
  });

  test("a user's threads page is not, though it is all comment rows", () => {
    const doc = parse(
      `<html><body><table class="comment-tree">${comment({ id: 2, by: "a", indent: 0, text: "Hi." })}</table></body></html>`,
    );
    expect(isHackerNewsItem(doc)).toBe(false);
  });

  test("an ordinary article is not", () => {
    const doc = parse(
      "<html><body><article><h1>Title</h1><p>Some prose.</p></article></body></html>",
    );
    expect(isHackerNewsItem(doc)).toBe(false);
  });
});

describe("clipHackerNewsItem", () => {
  test("a self-post: its text, then one blockquote per comment", () => {
    const doc = parse(
      page(
        "Ask HN: Which tools?",
        story({
          id: 1,
          title: "Ask HN: Which tools?",
          by: "asker",
          text: "First paragraph.<p>Second paragraph.",
        }),
        [
          comment({ id: 2, by: "alice", indent: 0, text: "Mine." }),
          comment({ id: 3, by: "bob", indent: 1, text: "Same here." }),
        ],
      ),
    );
    const clip = clipHackerNewsItem(doc, `${BASE}item?id=1`);
    expect(clip.title).toBe("Ask HN: Which tools?");
    expect(clip.author).toBe("asker");
    expect(clip.excerpt).toBe("First paragraph. Second paragraph.");
    expect(clip.markdown).toBe(
      [
        "First paragraph.",
        "",
        "Second paragraph.",
        "",
        `> **alice** · [2026-10-01](${BASE}item?id=2)`,
        ">",
        "> Mine.",
        "",
        `> > **bob** · [2026-10-01](${BASE}item?id=3)`,
        "> >",
        "> > Same here.",
      ].join("\n"),
    );
    // A self-post's title links to itself, so nothing points elsewhere.
    expect(clip.markdown).not.toContain("<https://");
  });

  test("a link post opens with the story's URL, and has no excerpt to give", () => {
    const doc = parse(
      page(
        "A story",
        story({
          id: 1,
          title: "A story",
          by: "op",
          href: "https://example.test/post",
        }),
        [comment({ id: 2, by: "alice", indent: 0, text: "Read it." })],
      ),
    );
    const clip = clipHackerNewsItem(doc, `${BASE}item?id=1`);
    expect(clip.title).toBe("A story");
    expect(clip.excerpt).toBe("");
    expect(clip.markdown.startsWith("<https://example.test/post>\n\n> ")).toBe(
      true,
    );
  });

  test("every comment is exactly one top-level block, at its own depth", () => {
    const doc = parse(
      page("A story", story({ id: 1, title: "A story", by: "op" }), [
        comment({ id: 2, by: "a", indent: 0, text: "One.<p>Two." }),
        comment({ id: 3, by: "b", indent: 1, text: "Reply." }),
        comment({
          id: 4,
          by: "c",
          indent: 2,
          text: "<pre><code>  let x = 1;\n</code></pre>",
        }),
        comment({ id: 5, by: "d", indent: 0, text: "Another root." }),
      ]),
    );
    const { markdown } = clipHackerNewsItem(doc, `${BASE}item?id=1`);
    const blocks = blocksOf(markdown);
    expect(blocks.map((b) => b.type)).toEqual([
      "blockquote",
      "blockquote",
      "blockquote",
      "blockquote",
    ]);
    expect(blocks[1]?.text.startsWith("> > **b**")).toBe(true);
    // A code block stays fenced inside its quote, three levels down.
    expect(blocks[2]?.text).toContain(
      "> > > ```\n> > >   let x = 1;\n> > > ```",
    );
    expect(blocks[3]?.text.startsWith("> **d**")).toBe(true);
  });

  test("a subthread the reader collapsed is left out, replies and all", () => {
    const doc = parse(
      page("A story", story({ id: 1, title: "A story", by: "op" }), [
        comment({ id: 2, by: "kept", indent: 0, text: "Kept." }),
        comment({
          id: 3,
          by: "folded",
          indent: 0,
          text: "Off topic.",
          state: "coll",
        }),
        comment({
          id: 4,
          by: "under",
          indent: 1,
          text: "Also off topic.",
          state: "noshow",
        }),
        comment({ id: 5, by: "next", indent: 0, text: "Back on topic." }),
      ]),
    );
    const { markdown } = clipHackerNewsItem(doc, `${BASE}item?id=1`);
    expect(markdown).toContain("Kept.");
    expect(markdown).toContain("Back on topic.");
    expect(markdown).not.toContain("folded");
    expect(markdown).not.toContain("Off topic");
    expect(markdown).not.toContain("under");
    expect(blocksOf(markdown)).toHaveLength(2);
  });

  test("a comment HN itself collapsed — flagged, served folded — is left out too", () => {
    const doc = parse(
      page("A story", story({ id: 1, title: "A story", by: "op" }), [
        comment({
          id: 2,
          by: "troll",
          indent: 0,
          marker: "[flagged]",
          state: "coll",
        }),
        comment({ id: 3, by: "fine", indent: 0, text: "Fine." }),
      ]),
    );
    const { markdown } = clipHackerNewsItem(doc, `${BASE}item?id=1`);
    expect(markdown).not.toContain("flagged");
    expect(markdown).not.toContain("troll");
    expect(blocksOf(markdown)).toHaveLength(1);
  });

  test("a deleted comment keeps its place, so its replies still answer something", () => {
    const doc = parse(
      page("A story", story({ id: 1, title: "A story", by: "op" }), [
        comment({ id: 2, indent: 0, marker: "[deleted]" }),
        comment({ id: 3, by: "replier", indent: 1, text: "Answering." }),
      ]),
    );
    const { markdown } = clipHackerNewsItem(doc, `${BASE}item?id=1`);
    const blocks = blocksOf(markdown);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).toBe(
      `> [2026-10-01](${BASE}item?id=2)\n>\n> \\[deleted\\]`,
    );
    expect(blocks[1]?.text.startsWith("> > **replier**")).toBe(true);
  });

  test("a comment's permalink page: the comment is the article", () => {
    const head = [
      '<tr class="athing" id="7"><td class="ind"></td>',
      '<td class="default"><div><span class="comhead">',
      '<a href="user?id=writer" class="hnuser">writer</a> ',
      '<span class="age" title="2026-10-02T10:00:00"><a href="item?id=7">3 days ago</a></span> ',
      '<span class="navs"> | <a href="item?id=1">parent</a>',
      '<span class="onstory"> | on: <a href="item?id=1" title="The full story title">The full story ti...</a></span>',
      "</span></span></div><br>",
      '<div class="comment"><div class="commtext c00">Root text.<p>More.</div><div class="reply"></div></div>',
      "</td></tr>",
    ].join("");
    const doc = parse(
      page("Root text. More.", head, [
        comment({ id: 8, by: "answer", indent: 0, text: "A reply." }),
      ]),
    );
    expect(isHackerNewsItem(doc)).toBe(true);
    const clip = clipHackerNewsItem(doc, `${BASE}item?id=7`);
    expect(clip.title).toBe("writer on: The full story title");
    expect(clip.author).toBe("writer");
    expect(clip.excerpt).toBe("Root text. More.");
    expect(clip.markdown).toBe(
      [
        `<${BASE}item?id=1>`,
        "",
        "Root text.",
        "",
        "More.",
        "",
        `> **answer** · [2026-10-01](${BASE}item?id=8)`,
        ">",
        "> A reply.",
      ].join("\n"),
    );
  });

  test("none of the page's furniture reaches the article", () => {
    const doc = parse(
      page("A story", story({ id: 1, title: "A story", by: "op" }), [
        comment({ id: 2, by: "a", indent: 0, text: "Text." }),
        comment({ id: 3, by: "b", indent: 1, text: "More text." }),
      ]),
    );
    const { markdown } = clipHackerNewsItem(doc, `${BASE}item?id=1`);
    expect(markdown).not.toContain("s.gif");
    expect(markdown).not.toContain("[–]");
    expect(markdown).not.toContain("reply");
    expect(markdown).not.toContain("ago");
    expect(markdown).not.toContain("points");
  });

  test("links in a comment are made absolute, and a typed quote stays text", () => {
    const doc = parse(
      page("A story", story({ id: 1, title: "A story", by: "op" }), [
        comment({
          id: 2,
          by: "a",
          indent: 0,
          text: '&gt; you said this<p>See <a href="item?id=99">that thread</a>.',
        }),
      ]),
    );
    const { markdown } = clipHackerNewsItem(doc, `${BASE}item?id=1`);
    expect(markdown).toContain("> \\> you said this");
    expect(markdown).toContain(`[that thread](${BASE}item?id=99)`);
    expect(blocksOf(markdown)).toHaveLength(1);
  });

  test("a name markdown would read as emphasis is escaped", () => {
    const doc = parse(
      page("A story", story({ id: 1, title: "A story", by: "op" }), [
        comment({ id: 2, by: "_under_score_", indent: 0, text: "Hi." }),
      ]),
    );
    const { markdown } = clipHackerNewsItem(doc, `${BASE}item?id=1`);
    expect(markdown.split("\n")[0]).toBe(
      `> **\\_under\\_score\\_** · [2026-10-01](${BASE}item?id=2)`,
    );
  });

  test("a comment with no timestamp is still linked, by its id", () => {
    const doc = parse(
      page("A story", story({ id: 1, title: "A story", by: "op" }), [
        comment({ id: 2, by: "a", indent: 0, text: "Hi.", stamp: "" }),
      ]),
    );
    const { markdown } = clipHackerNewsItem(doc, `${BASE}item?id=1`);
    expect(markdown.split("\n")[0]).toBe(`> **a** · [#2](${BASE}item?id=2)`);
  });
});

describe("clipPage", () => {
  test("hands an HN item to the thread clipper, not to Readability", () => {
    const doc = parse(
      page(
        "Ask HN: Which tools?",
        story({
          id: 1,
          title: "Ask HN: Which tools?",
          by: "asker",
          text: "Asking.",
        }),
        [comment({ id: 2, by: "alice", indent: 0, text: "Mine." })],
      ),
    );
    const clip = clipPage(doc, `${BASE}item?id=1`);
    expect(clip.title).toBe("Ask HN: Which tools?");
    expect(clip.readabilityFailed).toBe(false);
    expect(clip.markdown).toContain("> Mine.");
    expect(clip.markdown).not.toContain("|");
  });
});
