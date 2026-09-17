import {
  canonicalizeUrl,
  frontmatterLength,
  htmlRanges,
  isImageOnlyParagraph,
  isMarkdownUrl,
  markdownLinks,
  plainText,
  splitBlocks,
} from "@tiro/shared";
import { truncateExcerpt } from "./dom-prepare.ts";
import { srcsetUrlRanges, urlAttributeRanges } from "./html-urls.ts";

/**
 * Clipping a markdown file that a server handed over as text.
 *
 * Chrome renders `text/plain` as an HTML shell whose body is a single `<pre>`
 * holding the whole file. Nothing upstream asked what kind of document that
 * was, so the clipper did what it does with any bare `<pre>` on any page: it
 * synthesized a `<code>` inside it (`recoverCodeBlocks`) and Turndown fenced
 * the result. A 473-line transcript arrived in the vault as one code block —
 * which then could not be translated either, because `code` is verbatim by
 * contract (invariant 4), so its `zh.md` was a byte-identical copy of the
 * English.
 *
 * The file was already markdown. The whole job here is to stop converting it
 * and start carrying it, with three repairs the passthrough itself creates:
 *
 * - **Destinations become absolute.** A repo-relative `![](img/a.png)` means
 *   nothing once the file is in the vault, and the processor mirrors only
 *   absolute URLs (`images.ts`), so a relative one is not merely unmirrored —
 *   it resolves against the *site's* origin and 404s.
 * - **Reference links are inlined.** The site renders each top-level block
 *   through its own processor, so a `[ref]: …` definition in one block cannot
 *   resolve a `[text][ref]` in another; both would render as literal text.
 *   Turndown never emitted these, which is why the gap has not bitten before.
 * - **A title is found.** Chrome sets `document.title` to the host on a
 *   plain-text page, and the article said `raw.githubusercontent.com`.
 */

/**
 * The file behind Chrome's plain-text viewer, or `null` if this is a page.
 *
 * Described by shape, like `isPdfViewerDocument` — the body is exactly one
 * `<pre>` and holds all of the document's text — rather than by asking
 * `document.contentType`, which the clone Readability is handed does not
 * reliably carry and which a test DOM does not implement at all. The shape is
 * the tighter test anyway: it is what makes "a page that merely opens with a
 * code block" fail, since such a page has prose beside it.
 *
 * Paired with the URL, because a `<pre>` holding a file says nothing about
 * what kind of file. Only markdown is claimed; a `.txt` is hard-wrapped prose
 * and ASCII art that markdown would reflow, and stays a code block.
 */
export function plainTextMarkdownSource(
  doc: Document,
  url: string,
): string | null {
  if (!isMarkdownUrl(url)) return null;
  const pres = Array.from(doc.body?.querySelectorAll("pre") ?? []);
  const [pre] = pres;
  if (pres.length !== 1 || pre === undefined) return null;
  // Chrome's viewer puts the block straight in the body. One nested inside an
  // article is a page's code block, not a document.
  if (pre.parentElement !== doc.body) return null;
  const inPre = pre.textContent ?? "";
  // The load-bearing test, and the only one that was ever doing this work:
  // nothing outside the block contributes text, so a page whose article sits
  // beside it is a page.
  //
  // This used to also demand the body have exactly one child, which read like
  // a stronger version of the same idea and was in fact a different, wrong one.
  // Other extensions inject elements into every page's body — DeepL, Grammarly,
  // a password manager — and the clipper clones the document after they have.
  // The count then said two, markdown clipping silently stopped happening, and
  // an injected element contributes no text so the check below never minded.
  if ((doc.body?.textContent ?? "").trim() !== inPre.trim()) return null;
  // An empty file is not worth a second pipeline, and an empty body would
  // commit an article with nothing in it.
  if (inPre.trim() === "") return null;
  return inPre;
}

export interface SourceMarkdown {
  /** The body to store, ready for the vault. */
  markdown: string;
  /** The file's own title, or null when it names none. */
  title: string | null;
  excerpt: string;
}

/**
 * Turn a markdown file's bytes into the article body Tiro stores.
 *
 * `baseUrl` is where the bytes live, not where the article is filed. For a
 * GitHub blob the two differ on purpose: resolving `img/a.png` against the
 * blob page yields an HTML page, and against the raw URL yields the image.
 */
export function normalizeSourceMarkdown(
  text: string,
  baseUrl: string,
): SourceMarkdown {
  const source = stripYamlFrontmatter(normalizeLineEndings(text));
  // References resolve first. Inlining them makes every use site an ordinary
  // destination, which is then the only shape absolutization has to know
  // about — and it leaves no definition block behind to render as an empty row.
  const markdown = absolutizeMarkdownUrls(
    inlineReferenceLinks(source.body),
    baseUrl,
  ).trim();
  return {
    markdown,
    title: source.title ?? titleFromMarkdown(markdown),
    excerpt: excerptFromMarkdown(markdown),
  };
}

export interface StrippedSource {
  body: string;
  /** `title:` from the file's own frontmatter, when it had one. */
  title: string | null;
}

/**
 * Take the file's YAML frontmatter off the front, keeping its title.
 *
 * A stored body that still opened with `---` would be a thematic break under
 * the article's own frontmatter — and every key the file's author wrote would
 * be published as an `<hr>` and a paragraph of YAML.
 */
export function stripYamlFrontmatter(markdown: string): StrippedSource {
  const length = frontmatterLength(markdown);
  if (length === null) return { body: markdown, title: null };
  return {
    body: markdown.slice(length),
    title: yamlTitle(markdown.slice(0, length)),
  };
}

/** One line matched, not a YAML parse: every other key in that block belongs
 * to the file's own publishing setup and is none of Tiro's business. */
const YAML_TITLE = /^title:[ \t]*(\S.*?)[ \t]*$/m;

function yamlTitle(block: string): string | null {
  const value = YAML_TITLE.exec(block)?.[1];
  if (value === undefined) return null;
  const unquoted = /^(["'])(.*)\1$/.exec(value)?.[2] ?? value;
  return unquoted.trim() === "" ? null : unquoted.trim();
}

/**
 * Rewrite every reference-style link and image as an inline one, and drop the
 * definitions that are no longer pointed at.
 *
 * A definition goes only when *every* reference to it was rewritten. Dropping
 * them unconditionally was a bug of the same shape as the one `markdownLinks`
 * guards against: a reference the parser could not resolve kept its syntax and
 * lost its target, so the image or link it named simply disappeared. Refusing
 * to convert has to mean refusing to touch either half.
 *
 * A definition nothing points at is still dropped — remark reports a reference
 * node only where a definition matched, so one with no reference is one nothing
 * needs, and it would render as an empty block the translation would have to
 * match.
 */
export function inlineReferenceLinks(markdown: string): string {
  const links = markdownLinks(markdown);
  const targets = new Map<string, { url: string; title: string | null }>();
  for (const link of links) {
    // First definition wins, as CommonMark says.
    if (link.type !== "definition" || link.identifier === null) continue;
    if (!targets.has(link.identifier)) {
      targets.set(link.identifier, { url: link.url, title: link.title });
    }
  }
  if (targets.size === 0) return markdown;

  // Identifiers with a reference this cannot rewrite. Their definitions stay,
  // or the reference would be left naming a target that no longer exists.
  const unconverted = new Set<string>();
  for (const link of links) {
    if (link.type !== "linkReference" && link.type !== "imageReference") {
      continue;
    }
    if (link.identifier === null) continue;
    if (link.tail === null) unconverted.add(link.identifier);
  }

  const edits: Edit[] = [];
  for (const link of links) {
    if (link.type === "definition") {
      if (link.identifier !== null && unconverted.has(link.identifier)) {
        continue;
      }
      edits.push({
        start: link.start,
        // Take the line's terminator too, so a block of definitions leaves no
        // run of blank lines where it stood.
        end: consumeLineEnd(markdown, link.end),
        text: "",
      });
      continue;
    }
    if (link.type !== "linkReference" && link.type !== "imageReference") {
      continue;
    }
    if (link.tail === null || link.identifier === null) continue;
    const target = targets.get(link.identifier);
    if (target === undefined) continue;
    edits.push({
      start: link.tail.start,
      end: link.tail.end,
      text: destination(target.url, target.title),
    });
  }
  return applyEdits(markdown, edits);
}

/**
 * Resolve every relative destination against the URL the file came from.
 *
 * Only inline links and images: a reference has no destination of its own, and
 * an autolink has no label to be a destination after. Both are reported that
 * way by `markdownLinks`, and code is not reported at all, so there is nothing
 * here to guard against rewriting a fence.
 */
export function absolutizeMarkdownUrls(
  markdown: string,
  baseUrl: string,
): string {
  const edits: Edit[] = [];
  for (const link of markdownLinks(markdown)) {
    if (link.type !== "link" && link.type !== "image") continue;
    if (link.tail === null) continue;
    const absolute = absolutize(link.url, baseUrl);
    if (absolute === null) continue;
    edits.push({
      start: link.tail.start,
      end: link.tail.end,
      text: destination(absolute, link.title),
    });
  }
  edits.push(...htmlAttributeEdits(markdown, baseUrl));
  return applyEdits(markdown, edits);
}

/**
 * Resolve the references that live in attributes rather than in nodes.
 *
 * A relative one is not merely unmirrored once the file is in the vault: all
 * three attributes survive the site's sanitize allowlist, so they reach the
 * public page and 404, while the processor's mirroring matches absolute URLs
 * only and never localizes them.
 *
 * Every URL is edited in place at the range `html-urls.ts` reports, so a value
 * with nothing to resolve keeps every byte — including a `srcset` whose
 * spacing an earlier version re-joined for no reason.
 */
function htmlAttributeEdits(markdown: string, baseUrl: string): Edit[] {
  const edits: Edit[] = [];
  for (const range of htmlRanges(markdown)) {
    const html = markdown.slice(range.start, range.end);
    for (const attribute of urlAttributeRanges(html)) {
      const value = html.slice(attribute.start, attribute.end);
      const at = range.start + attribute.start;
      const urls =
        attribute.name === "srcset"
          ? srcsetUrlRanges(value)
          : [{ start: 0, end: value.length }];
      for (const url of urls) {
        const absolute = absolutize(value.slice(url.start, url.end), baseUrl);
        if (absolute === null) continue;
        edits.push({
          start: at + url.start,
          end: at + url.end,
          text: absolute,
        });
      }
    }
  }
  return edits;
}

/** Anything with a scheme — `https:`, but also `mailto:` and `data:`. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function absolutize(url: string, baseUrl: string): string | null {
  const target = url.trim();
  if (target === "") return null;
  if (HAS_SCHEME.test(target)) return null;
  // Protocol-relative resolves fine but needs no rewrite, and a bare fragment
  // addresses this article, which is not on the source's host at all.
  if (target.startsWith("//") || target.startsWith("#")) return null;
  let resolved: string;
  try {
    resolved = new URL(target, baseUrl).toString();
  } catch {
    return null;
  }
  // A sibling markdown file becomes the page it is presented on rather than
  // the plain text the base just resolved it to — free, because the rule that
  // decides this article's own identity answers the same question.
  return canonicalizeUrl(resolved);
}

/**
 * A destination group, escaped the way `inlineLinkRule` escapes Turndown's —
 * `<>()` in the target, `"` in the title, angle brackets when it has a space.
 */
function destination(url: string, title: string | null): string {
  const escaped = url.replace(/([<>()])/g, "\\$1");
  const target = escaped.includes(" ") ? `<${escaped}>` : escaped;
  const label =
    title === null || title === "" ? "" : ` "${title.replace(/"/g, '\\"')}"`;
  return `(${target}${label})`;
}

/** The file's own title: its first level-one heading. */
export function titleFromMarkdown(markdown: string): string | null {
  for (const block of splitBlocks(markdown)) {
    if (block.type !== "heading" || !isLevelOne(block.text)) continue;
    const text = plainText(block.text);
    if (text !== "") return text;
  }
  return null;
}

const ATX_H1 = /^[ \t]{0,3}#(?:[ \t]|$)/;
const SETEXT_H1 = /\n[ \t]{0,3}=+[ \t]*$/;

function isLevelOne(text: string): boolean {
  return ATX_H1.test(text) || SETEXT_H1.test(text.trimEnd());
}

/** The first paragraph that says something — an image-only one is a figure,
 * and its alt text is a caption rather than a summary. */
export function excerptFromMarkdown(markdown: string): string {
  for (const block of splitBlocks(markdown)) {
    if (block.type !== "paragraph" || isImageOnlyParagraph(block.text))
      continue;
    const text = plainText(block.text);
    if (text !== "") return truncateExcerpt(text);
  }
  return "";
}

function normalizeLineEndings(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

function consumeLineEnd(text: string, at: number): number {
  if (text[at] === "\r") return text[at + 1] === "\n" ? at + 2 : at + 1;
  return text[at] === "\n" ? at + 1 : at;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Back to front, so an edit never moves the offsets of the ones still to
 * come. Same reason `sweep.ts` applies its fence edits that way. */
function applyEdits(text: string, edits: Edit[]): string {
  if (edits.length === 0) return text;
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
