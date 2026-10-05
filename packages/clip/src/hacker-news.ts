import { htmlToMarkdown } from "./markdown.ts";
import type { ClipPayload } from "./payload.ts";

/**
 * Hacker News threads, clipped from their own markup (ADR 0038).
 *
 * Readability reads an item page as a stack of layout tables. Every comment is
 * a row of a flat table — depth is an attribute, not nesting — so its scorer
 * keeps the rows' *headers* and prunes the bodies: measured on a live
 * 193-comment thread, the clip was 190 tables of usernames and "1 day ago",
 * with the post's own text and every comment gone. Nothing about that page is
 * a near miss Readability could be coaxed through; the structure has to be
 * read directly.
 *
 * Detected by the markup, never the host (ADR 0013: a renderer owns its
 * markup). `table.fatitem` is the head of an item page — a story, or the
 * permalink of a single comment — and no other HN page has one: the front page,
 * `/newest`, `/user` and `/threads` all keep the generic path.
 *
 * The thread is what the tab shows. HN's script marks a comment the reader
 * collapsed with `coll` and every reply under it with `noshow`, and the server
 * renders the same classes for its own default collapses — flagged comments,
 * and off-topic subthreads the moderators folded away — so a thread fetched
 * without a browser (a saved link) honours those too. A skipped comment always
 * takes its replies with it, which is what keeps every depth below it coherent.
 */

/** The row that heads an item page. `tr.athing` with an id is the item itself,
 * story or comment; a page without one is not a thread. */
function itemRow(doc: Document): Element | null {
  return doc.querySelector("table.fatitem tr.athing[id]");
}

/** True when `doc` is a Hacker News item page: a story with its comments, or a
 * single comment with its replies. */
export function isHackerNewsItem(doc: Document): boolean {
  const row = itemRow(doc);
  if (row === null || !/^\d+$/.test(row.id)) return false;
  return row.querySelector(".titleline, .comhead") !== null;
}

/**
 * Clip an item page as one article: the story (or the comment the page is the
 * permalink of), then every visible comment under it.
 *
 * Each comment is one top-level blockquote, nested one level deeper per level
 * of the thread, and separated from the next by a blank line — which ends a
 * blockquote, so every comment is its own top-level block. That is the unit
 * translation is batched in and the reader pairs, and it keeps a block the size
 * of one comment: a nested list would make a whole subthread one block, and a
 * block past `translation.max_block_chars` is never translated at all.
 *
 * `hasMath` stays false for the reason `clipMarkdownFile` gives: the flag
 * promises every literal `$` was escaped, and that escape runs only for a
 * fragment carrying recovered math, which HN markup never does.
 */
export function clipHackerNewsItem(doc: Document, url: string): ClipPayload {
  const row = itemRow(doc);
  const head = row?.closest("table.fatitem") ?? null;
  const blocks: string[] = [];
  let title = "";
  let author = "";
  let excerpt = "";

  const story = row?.querySelector(".titleline > a") ?? null;
  if (row !== null && story !== null) {
    title = textOf(story);
    author = textOf(head?.querySelector(".subtext .hnuser") ?? null);
    const target = absolute(story.getAttribute("href") ?? "", url);
    // A self-post's title links back to the item itself; only a link post has
    // somewhere else to send the reader.
    if (target !== null && !isSameItem(target, row.id, url)) {
      blocks.push(`<${target}>`);
    }
    const text = head?.querySelector(".toptext") ?? null;
    if (text !== null && textOf(text) !== "") {
      blocks.push(markdownOf(doc, text, url));
      excerpt = excerptOf(text);
    }
  } else if (row !== null) {
    // The permalink of one comment: the comment is the article, under the
    // story it was written on.
    author = textOf(row.querySelector(".comhead .hnuser"));
    const on = row.querySelector(".onstory a");
    const storyTitle = on?.getAttribute("title") ?? textOf(on);
    title = storyTitle === "" ? author : `${author} on: ${storyTitle}`;
    const thread = absolute(on?.getAttribute("href") ?? "", url);
    if (thread !== null) blocks.push(`<${thread}>`);
    const text = row.querySelector(".commtext");
    if (text !== null) {
      blocks.push(markdownOf(doc, text, url));
      excerpt = excerptOf(text);
    }
  }

  for (const comment of Array.from(doc.querySelectorAll("tr.athing.comtr"))) {
    if (comment.classList.contains("coll")) continue;
    if (comment.classList.contains("noshow")) continue;
    blocks.push(commentBlock(doc, comment, url));
  }

  return {
    url,
    title: title || doc.title.replace(/\s*\|\s*Hacker News\s*$/, "").trim(),
    excerpt,
    author,
    markdown: blocks.filter((block) => block !== "").join("\n\n"),
    readabilityFailed: false,
    hasMath: false,
    pdfViewer: false,
    latexmlFullText: false,
    markdownSource: false,
  };
}

/**
 * One comment as a blockquote `depth + 1` levels deep: a header naming its
 * author and dated by a link to its permalink, then its text.
 *
 * The header is built as HTML and converted with the body, so Turndown escapes
 * a name like `teh_infallible` the way it escapes everything else. The date is
 * the day only: HN's own label is relative ("1 day ago"), which would be wrong
 * from the moment it was stored, and its `title` is a zone-less UTC timestamp.
 *
 * A comment with no text of its own — `[deleted]`, or `[flagged]` once someone
 * expands it — keeps its header and the marker HN shows in place of the text,
 * because its replies are still there and still answering it.
 */
function commentBlock(doc: Document, comment: Element, url: string): string {
  const depth = indentOf(comment);
  const container = doc.createElement("div");

  const header = doc.createElement("p");
  const user = textOf(comment.querySelector(".comhead .hnuser"));
  if (user !== "") {
    const strong = doc.createElement("strong");
    strong.textContent = user;
    header.append(strong, " · ");
  }
  const permalink = doc.createElement("a");
  permalink.setAttribute(
    "href",
    absolute(`item?id=${comment.id}`, url) ?? `item?id=${comment.id}`,
  );
  permalink.textContent = dayOf(comment) ?? `#${comment.id}`;
  header.append(permalink);
  container.append(header);

  const text = comment.querySelector(".commtext");
  if (text !== null) {
    container.append(...bodyOf(text, url));
  } else {
    const marker = doc.createElement("p");
    marker.textContent = textOf(comment.querySelector(".comment"));
    if (marker.textContent !== "") container.append(marker);
  }

  return quote(htmlToMarkdown(container.innerHTML).markdown.trim(), depth + 1);
}

/** Markdown for a block of HN text — a self-post's, or the comment a
 * permalink page is about — at the top level of the article. */
function markdownOf(doc: Document, element: Element, url: string): string {
  const container = doc.createElement("div");
  container.append(...bodyOf(element, url));
  return htmlToMarkdown(container.innerHTML).markdown.trim();
}

/**
 * A copy of the text's children with every link absolute. The generic path
 * leaves this to Readability, which is never asked here; and the reply link
 * is dropped wherever HN puts it — inside the text in older markup, beside it
 * today.
 */
function bodyOf(element: Element, url: string): Node[] {
  const copy = element.cloneNode(true) as Element;
  for (const reply of Array.from(copy.querySelectorAll(".reply"))) {
    reply.remove();
  }
  for (const link of Array.from(copy.querySelectorAll("a[href]"))) {
    const href = absolute(link.getAttribute("href") ?? "", url);
    if (href !== null) link.setAttribute("href", href);
  }
  return Array.from(copy.childNodes);
}

/** Prefix every line with `level` quote markers; a blank line keeps the bare
 * markers, so the blockquote runs on through it instead of ending there. */
function quote(markdown: string, level: number): string {
  const marker = "> ".repeat(level);
  return markdown
    .split("\n")
    .map((line) => (line === "" ? marker.trimEnd() : `${marker}${line}`))
    .join("\n");
}

/** The comment's depth in the thread, which HN states rather than nests. */
function indentOf(comment: Element): number {
  const value = comment.querySelector("td.ind")?.getAttribute("indent") ?? "";
  const depth = Number.parseInt(value, 10);
  return Number.isNaN(depth) || depth < 0 ? 0 : depth;
}

/** The UTC day a comment was posted, from its timestamp's `title`. */
function dayOf(comment: Element): string | null {
  const stamp = comment.querySelector(".comhead .age")?.getAttribute("title");
  return /^\d{4}-\d{2}-\d{2}/.exec(stamp ?? "")?.[0] ?? null;
}

function absolute(href: string, base: string): string | null {
  if (href === "") return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/** Whether `target` is this item's own page — how a self-post's title links. */
function isSameItem(target: string, id: string, base: string): boolean {
  const own = absolute(`item?id=${id}`, base);
  return own !== null && target.replace(/#.*$/, "") === own;
}

function textOf(element: Element | null): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

const EXCERPT_CHARS = 200;

/**
 * The opening of a block of HN text, as plain prose.
 *
 * HN separates paragraphs with bare `<p>` tags and no whitespace, so the text
 * content would run the last word of one into the first of the next; a space
 * goes in front of each first.
 */
function excerptOf(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const paragraph of Array.from(copy.querySelectorAll("p"))) {
    paragraph.before(" ");
  }
  const text = textOf(copy);
  if (text.length <= EXCERPT_CHARS) return text;
  const cut = text.slice(0, EXCERPT_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}
