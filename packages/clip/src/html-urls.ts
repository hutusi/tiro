/**
 * Finding the URLs inside raw HTML, by walking it rather than matching it.
 *
 * Markdown carries HTML the converter could not express, and a README's first
 * line is routinely `<p align="center"><img src="logo.png"></p>`. Those
 * references are as relative as a markdown destination and break the same way,
 * but they live in attributes, so the markdown parser cannot report them.
 *
 * A regex was the first answer and it failed in both directions at once. It
 * could not see `<img src=logo.png>`, because it demanded quotes — and teaching
 * it unquoted values would have made it *worse*, because `src=` also appears
 * inside other attributes: `<img alt="src=x.png" src="y.png">` would have had
 * its alt text rewritten. Reading a tag's attributes as attributes costs about
 * forty lines and gets both right, along with comments, `>` inside a value, and
 * the case of the name.
 *
 * Everything here reports **ranges**. The caller edits the URLs in place, so a
 * value it does not need to touch keeps every byte — which matters on a path
 * whose whole promise is that the file is carried, not rewritten.
 */

/** Attributes that address something, in the tags the site's sanitizer keeps
 * them on: `img[src]`, `a[href]`, `source[srcset]`. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["src", "href", "srcset"]);

/** HTML's own whitespace set, which is not JavaScript's `\s`. */
const SPACE: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r", "\f"]);

export interface HtmlAttributeRange {
  /** Lowercased attribute name. */
  name: string;
  /** The value's source range, quotes excluded. */
  start: number;
  end: number;
}

/** Every URL-bearing attribute value in a run of raw HTML. */
export function urlAttributeRanges(html: string): HtmlAttributeRange[] {
  const found: HtmlAttributeRange[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] !== "<") {
      i++;
      continue;
    }
    // A comment may hold a whole tag, and rewriting inside one would change
    // text nobody renders.
    if (html.startsWith("<!--", i)) {
      const close = html.indexOf("-->", i + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const close = html.indexOf(">", i);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    let j = i + 1;
    if (html[j] === "/") j++;
    // A `<` not followed by a name is literal text — `5 < 6` is not a tag.
    if (!/[a-zA-Z]/.test(html[j] ?? "")) {
      i++;
      continue;
    }
    while (j < html.length && !isTagBoundary(html[j])) j++;
    j = readAttributes(html, j, found);
    i = j + 1;
  }
  return found;
}

function isTagBoundary(char: string | undefined): boolean {
  return char === undefined || SPACE.has(char) || char === ">" || char === "/";
}

/** Read a tag's attributes from `j`, returning the offset of its `>`. */
function readAttributes(
  html: string,
  from: number,
  found: HtmlAttributeRange[],
): number {
  let j = from;
  while (j < html.length && html[j] !== ">") {
    const char = html[j] ?? "";
    if (SPACE.has(char) || char === "/") {
      j++;
      continue;
    }
    const nameStart = j;
    while (j < html.length && !isTagBoundary(html[j]) && html[j] !== "=") j++;
    const name = html.slice(nameStart, j).toLowerCase();
    while (j < html.length && SPACE.has(html[j] ?? "")) j++;
    // A bare attribute carries no value; the next loop reads whatever follows
    // as the next name.
    if (html[j] !== "=") continue;
    j++;
    while (j < html.length && SPACE.has(html[j] ?? "")) j++;
    const quote = html[j];
    let start: number;
    let end: number;
    if (quote === '"' || quote === "'") {
      start = ++j;
      while (j < html.length && html[j] !== quote) j++;
      end = j;
      j++;
    } else {
      start = j;
      while (j < html.length && !SPACE.has(html[j] ?? "") && html[j] !== ">") {
        j++;
      }
      end = j;
    }
    if (URL_ATTRIBUTES.has(name)) found.push({ name, start, end });
  }
  return j;
}

/**
 * The URLs inside a `srcset`, as ranges into it.
 *
 * Splitting on every comma was the obvious reading and the wrong one: a
 * candidate's URL is a run of non-whitespace, and only a *trailing* comma ends
 * one. `data:image/png;base64,AAAA 1x, logo.png 2x` is two candidates, not
 * three, and splitting it treated the base64 payload as a relative path — which
 * destroyed the image rather than failing to fix it. Query strings carry commas
 * too (`a.png?w=1,2`).
 */
export function srcsetUrlRanges(
  value: string,
): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  let i = 0;
  while (i < value.length) {
    while (
      i < value.length &&
      (SPACE.has(value[i] ?? "") || value[i] === ",")
    ) {
      i++;
    }
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !SPACE.has(value[i] ?? "")) i++;
    let end = i;
    let commas = 0;
    while (end > start && value[end - 1] === ",") {
      end--;
      commas++;
    }
    found.push({ start, end });
    // Trailing commas ended the candidate; otherwise a descriptor follows and
    // runs to the next comma. Descriptors are `2x` or `800w` and hold none.
    if (commas > 0) continue;
    while (i < value.length && value[i] !== ",") i++;
    if (value[i] === ",") i++;
  }
  return found;
}
