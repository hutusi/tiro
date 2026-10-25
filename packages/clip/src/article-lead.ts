import {
  ASIDE_ATTR,
  BYLINE,
  FIGURE_ATTR,
  followableUrl,
  PULL_QUOTE_ATTR,
  UNLIKELY_ROLES,
} from "./dom-prepare.ts";
import { srcsetUrlRanges } from "./html-urls.ts";
import {
  articleJsonLd,
  headlineText,
  metaContents,
  plainText,
  wordsOf,
} from "./page-claims.ts";
import {
  declaredPx,
  lettersIn,
  pageBase,
  readPreparedBody,
  resolveLinksIn,
} from "./page-view.ts";

/**
 * The article's lead — its dek and its lead picture — when Readability left
 * them out (ADR 0052).
 *
 * Readability finds the block with the most prose and then looks only at that
 * block's siblings. A publisher that sets its header beside the body rather
 * than inside it — The Atlantic's `ArticleHero` next to `ArticleBody`, a
 * Substack post's subtitle above its body — loses the whole header: the
 * headline survives as the title (ADR 0042) and the byline as `author`, but
 * the dek survives only as an excerpt nobody sees, and the lead picture and
 * its caption not at all. 228 of the vault's 245 Atlantic articles had lost
 * their dek this way, and 35 of the 40 Atlantic pages that could be checked
 * had lost a picture too.
 *
 * So the page is read again, between the headline Readability's title names
 * and the place Readability's article begins — the article's header, by
 * position rather than by name. Nothing there is taken on the strength of a
 * class name: class names guess, and the corpus measured the guess (a date
 * line called `subtitle`, a blog's tagline called `subheading`). A dek is
 * taken only when the page's own description says the same words, and a
 * picture only when the page's own card names it or the page sets it as a
 * `<figure>`. The byline is never taken: it is metadata, kept as `author` and
 * shown by the site in the article's meta row.
 *
 * Narrow both ways. Every guard that cannot answer returns no lead, which is
 * the clip as it was. And if Readability already kept any confirmed part of
 * the header, it read the header and nothing is added.
 */

/** What the page's metadata says its dek and its lead picture are, read
 * before Readability, which deletes every JSON-LD script it finds. */
export interface LeadEvidence {
  /** The page's descriptions, as plain text: `description`, `og:description`,
   * `twitter:description`, and every JSON-LD article's `description`. */
  descriptions: string[];
  /** The page's pictures of itself, as absolute addresses: `og:image` and
   * `twitter:image` in their spellings, and every JSON-LD article's `image`
   * and `thumbnailUrl`. */
  images: string[];
}

const DESCRIPTION_KEYS = [
  "description",
  "og:description",
  "twitter:description",
] as const;
const IMAGE_KEYS = [
  "og:image",
  "og:image:url",
  "og:image:secure_url",
  "twitter:image",
  "twitter:image:src",
] as const;

export function readLeadEvidence(
  doc: Document,
  pageUrl?: string,
): LeadEvidence {
  const base = pageBase(doc, pageUrl);
  const descriptions = metaContents(doc, DESCRIPTION_KEYS);
  const images = metaContents(doc, IMAGE_KEYS);
  for (const node of articleJsonLd(doc)) {
    if (typeof node.description === "string") {
      descriptions.push(node.description);
    }
    collectImageClaims(node.image, images);
    collectImageClaims(node.thumbnailUrl, images);
  }
  return {
    descriptions: descriptions
      .map((text) => plainText(text).replace(/\s+/g, " ").trim())
      .filter((text) => text !== ""),
    images: images
      .map((url) => followableUrl(url, base))
      .filter((url): url is string => url !== null),
  };
}

/** A JSON-LD `image` is a string, an `ImageObject`, or a list of either. */
function collectImageClaims(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectImageClaims(item, into);
    return;
  }
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["url", "contentUrl"]) {
    if (typeof record[key] === "string") into.push(record[key] as string);
  }
}

export interface LeadInput {
  /** Readability's article, as it returned it. */
  chosen: string;
  /** The page as it stood before Readability consumed it. */
  preparedBody: string;
  doc: Document;
  pageUrl?: string;
  /** The title the clip files the article under (`chooseTitle`'s). */
  title: string;
  /** The page's metadata titles (`TitleEvidence.claims`). */
  titleClaims: readonly string[];
  evidence: LeadEvidence;
}

/**
 * Fewer letters than this in Readability's article and no lead is looked for.
 * A saved link whose page is a shell must stay a shell: the processor refuses
 * a fetched body under `fetch.min_chars` (500 by default, ADR 0034), and a dek
 * and a caption must not carry a script-built page over that line.
 */
const MIN_CHOSEN_LETTERS = 500;

/** A paragraph shorter than this cannot say where the article begins. */
const MIN_START_LETTERS = 30;

/** How much of the first paragraph is matched against the page. */
const START_KEY_CHARS = 40;

/**
 * More letters than this between the headline and the body, and the space
 * between them is not a header: a page that sets its headline in one column
 * and its body in another can put a whole sidebar between them. The largest
 * header the corpus confirmed a lead in held 4,088 — Big Think's, key
 * takeaways and all; most hold a few hundred.
 */
const MAX_ZONE_LETTERS = 5000;

/** How much of a dek is looked for in Readability's article. */
const DEK_KEY_CHARS = 60;

/** A dek says something: fewer tokens than this is a label. */
const MIN_DEK_TOKENS = 4;

/** How much of a dek may be link text before it is navigation. */
const MAX_DEK_LINK_DENSITY = 0.5;

/** How closely a dek and a description must agree, measured against the
 * larger of the two — so a tag line whose words all appear in a longer
 * description does not pass for it. */
const MIN_AGREEMENT = 0.8;

/** A lead picture is at least this large, where the markup declares it. */
const MIN_LEAD_WIDTH = 150;
const MIN_LEAD_HEIGHT = 100;

/** Names a picture that stands for a person or a brand, not the article. */
const NOT_A_LEAD = /avatar|logo|icon|headshot|profile/i;

/**
 * What a header holds that is not the article: the page's furniture.
 * Readability's unlikely-candidate list, less what a header is legitimately
 * called — `header` itself, `banner`, `meta` — which is exactly what wraps a
 * dek and a lead picture on the pages this pass is for. Nor a bare `ad` or
 * `tag`: WordPress and RebelMouse put `tag-<topic>` on the article itself,
 * and IEEE Spectrum's `tag-wall-street` hid its whole header from this pass.
 */
const FURNITURE =
  /-ad-|ad-break|ad-slot|ad-unit|adsbygoogle|advert|breadcrumb|comment|disqus|footer|menu|newsletter|outbrain|popup|promo|related|share|sharing|shoutbox|sidebar|skyscraper|social|sponsor|subscribe/i;

/** Elements whose subtree is never a dek or a lead picture. A caption travels
 * with its figure and is never a dek of its own. */
const NOT_LEAD_TAGS: ReadonlySet<string> = new Set([
  "NAV",
  "ASIDE",
  "FOOTER",
  "FORM",
  "BUTTON",
  "DIALOG",
  "TIME",
  "SVG",
  "IFRAME",
  "FIGCAPTION",
  "ADDRESS",
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "NOSCRIPT",
]);

/** Block-level elements: a dek is a block holding none of these. */
const BLOCKS: ReadonlySet<string> = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "DL",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "UL",
]);

const DEK_TAGS: ReadonlySet<string> = new Set([
  "P",
  "DIV",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

/** Inside a dek, these are not words a reader sees. */
const DEK_JUNK = "script, style, svg, button, noscript, template, iframe";

/**
 * The lead Readability left out, as article HTML to put before its article:
 * the dek as a paragraph and the lead picture as a figure, in the page's
 * order — or `""`, which is the clip as it was.
 */
export function articleLeadIn(input: LeadInput): string {
  const scratch = input.doc.implementation.createHTMLDocument("");
  const chosen = scratch.body;
  chosen.innerHTML = input.chosen;
  if (lettersIn(chosen.textContent ?? "") < MIN_CHOSEN_LETTERS) return "";

  const startKey = firstParagraphKey(chosen);
  if (startKey === null) return "";

  const page = readPreparedBody(input.preparedBody, input.doc);
  const start = startIn(page, startKey);
  if (start === null) return "";
  const headline = confirmedHeadline(page, start, input);
  if (headline === null) return "";
  if (headline.contains(start) || start.contains(headline)) return "";

  const zone = headerZone(headline, start);
  if (zone === null) return "";
  const zoneLetters =
    zone.blocks.reduce(
      (sum, block) => sum + lettersIn(block.textContent ?? ""),
      0,
    ) - lettersIn(headline.textContent ?? "");
  if (zoneLetters > MAX_ZONE_LETTERS) return "";

  const base = pageBase(input.doc, input.pageUrl);
  const dek = dekIn(zone, headline, input.evidence.descriptions);
  const picture = leadPictureIn(zone, base, input.evidence.images);
  if (dek === null && picture === null) return "";

  // Readability already read the header: whatever it kept of it stays where it
  // put it, and nothing is added beside it.
  const chosenText = normalized(chosen.textContent ?? "");
  if (
    dek !== null &&
    chosenText.includes(
      normalized(dek.textContent ?? "").slice(0, DEK_KEY_CHARS),
    )
  ) {
    return "";
  }
  if (picture !== null) {
    const chosenKeys = new Set(
      Array.from(chosen.querySelectorAll("img")).flatMap((img) =>
        keysOf(imageUrls(img, base)),
      ),
    );
    if (picture.keys.some((key) => chosenKeys.has(key))) return "";
  }

  const parts: { at: Element; html: string }[] = [];
  if (dek !== null) parts.push({ at: dek, html: dekHtml(dek, base) });
  if (picture !== null) {
    parts.push({ at: picture.image, html: pictureHtml(picture, base) });
  }
  parts.sort((a, b) =>
    a.at.compareDocumentPosition(b.at) & FOLLOWING ? -1 : 1,
  );
  return parts.map((part) => part.html).join("");
}

const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT

/** Text a reader never sees. */
const UNREAD: ReadonlySet<string> = new Set([
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "NOSCRIPT",
]);

/** Text as a matching key: letters and digits, case-folded, one space
 * between runs. Shared by the start and the dek, so markup between words
 * cannot make one text two. */
function normalized(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The start of Readability's first paragraph that says enough to be found. */
function firstParagraphKey(chosen: Element): string | null {
  for (const paragraph of Array.from(chosen.querySelectorAll("p"))) {
    const text = paragraph.textContent ?? "";
    if (lettersIn(text) < MIN_START_LETTERS) continue;
    return normalized(text).slice(0, START_KEY_CHARS);
  }
  return null;
}

/**
 * The element of the page where Readability's article begins: the first of
 * the deepest elements whose text starts with its first paragraph.
 *
 * The first, not the only one: an article may repeat its opening — the Twain
 * installments close on the same series note they open with — and Readability
 * keeps the page's order, so its first paragraph is the page's first copy of
 * it. A copy the header holds as a teaser would come first instead, and then
 * the header ends early: a lead missed, never one taken from the body.
 */
function startIn(page: Element, key: string): Element | null {
  const walker = page.ownerDocument.createTreeWalker(page, SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || UNREAD.has(parent.tagName)) continue;
    const own = normalized(node.nodeValue ?? "");
    if (own === "" || !(key.startsWith(own) || own.startsWith(key))) continue;
    // Up from the text the paragraph opens with, while what is around it still
    // opens with it, to the first element whose text holds the whole key.
    for (
      let element: Element | null = parent;
      element !== null && element !== page.parentElement;
      element = element.parentElement
    ) {
      const text = normalized(element.textContent ?? "");
      if (text.startsWith(key)) return element;
      if (!key.startsWith(text)) break;
    }
  }
  return null;
}

/**
 * The page's headline: an `<h1>` before the article whose words are the
 * clip's title or one of the page's metadata titles — ADR 0042's confirmed
 * headline, which neither a logo nor a section name can be. The last one
 * before the article, should a page show two.
 */
function confirmedHeadline(
  page: Element,
  start: Element,
  input: LeadInput,
): Element | null {
  const titles = new Set(
    [input.title, ...input.titleClaims]
      .flatMap(titleForms)
      .map(wordsOf)
      .filter((words) => words !== ""),
  );
  let found: Element | null = null;
  for (const h1 of Array.from(page.querySelectorAll("h1"))) {
    if (!(h1.compareDocumentPosition(start) & FOLLOWING)) continue;
    if (titles.has(wordsOf(headlineText(h1)))) found = h1;
  }
  return found;
}

/** Separators a page puts between its title and its own name. */
const TITLE_SEPARATOR = /\s+[|\-–—·•:»]\s+/;

/** Words a site's name runs to at most, beside a title. */
const MAX_SITE_NAME_WORDS = 5;

/**
 * A title as the page might show it: whole, and without the site's name a
 * `<title>` or `og:title` appends — "Surprisingly Complex Waves Reveal the
 * Brain’s Inner Workings | Quanta Magazine" over an `<h1>` that stops at
 * "Workings". The part kept is the longest, and only when what is cut is
 * short enough to be a name, so a logo `<h1>` reading "Quanta Magazine" never
 * becomes the headline.
 */
function titleForms(title: string): string[] {
  const parts = title.split(TITLE_SEPARATOR).filter((part) => part.trim());
  if (parts.length < 2) return [title];
  const longest = parts.reduce((a, b) => (b.length > a.length ? b : a));
  const rest = parts.filter((part) => part !== longest).join(" ");
  const restWords = rest.trim().split(/\s+/).length;
  return restWords <= MAX_SITE_NAME_WORDS ? [title, longest] : [title];
}

/** The article's header: everything between the headline and the body, inside
 * the box that holds them both. */
interface Zone {
  /** The box holding both. */
  root: Element;
  /** Its children from the headline's to the one before the body's. */
  blocks: Element[];
}

function headerZone(headline: Element, start: Element): Zone | null {
  let root: Element | null = headline.parentElement;
  while (root !== null && !root.contains(start)) root = root.parentElement;
  if (root === null) return null;
  const children = Array.from(root.children);
  const from = children.findIndex((child) => child.contains(headline));
  const to = children.findIndex((child) => child.contains(start));
  if (from === -1 || to === -1 || to <= from) return null;
  return { root, blocks: children.slice(from, to) };
}

/** Whether `element`, or anything around it inside the zone, is furniture or a
 * byline — or something an earlier pass set aside for itself. */
function excluded(element: Element, root: Element): boolean {
  for (
    let node: Element | null = element;
    node !== null && node !== root;
    node = node.parentElement
  ) {
    if (NOT_LEAD_TAGS.has(node.tagName)) return true;
    if (UNLIKELY_ROLES.has(node.getAttribute("role") ?? "")) return true;
    if (
      node.hasAttribute(ASIDE_ATTR) ||
      node.hasAttribute(PULL_QUOTE_ATTR) ||
      node.hasAttribute(FIGURE_ATTR)
    ) {
      return true;
    }
    const names = `${node.getAttribute("class") ?? ""} ${node.getAttribute("id") ?? ""}`;
    if (FURNITURE.test(names) || BYLINE.test(names)) return true;
    if (/\bauthor\b/i.test(node.getAttribute("rel") ?? "")) return true;
    if (/\bauthor\b/i.test(node.getAttribute("itemprop") ?? "")) return true;
  }
  return false;
}

function inZone(zone: Zone): Element[] {
  return zone.blocks.flatMap((block) => [
    block,
    ...Array.from(block.querySelectorAll("*")),
  ]);
}

/**
 * The dek: a block of text after the headline that the page's description
 * confirms. The first one, and only one.
 */
function dekIn(
  zone: Zone,
  headline: Element,
  descriptions: readonly string[],
): Element | null {
  if (descriptions.length === 0) return null;
  const claims = descriptions.map(tokensOf).filter((set) => set.size > 0);
  for (const element of inZone(zone)) {
    if (!DEK_TAGS.has(element.tagName)) continue;
    if (!(headline.compareDocumentPosition(element) & FOLLOWING)) continue;
    if (element.contains(headline) || headline.contains(element)) continue;
    if (Array.from(element.children).some((child) => BLOCKS.has(child.tagName)))
      continue;
    if (excluded(element, zone.root)) continue;
    const text = element.textContent ?? "";
    const tokens = tokensOf(text);
    if (tokens.size < MIN_DEK_TOKENS) continue;
    if (linkDensity(element) > MAX_DEK_LINK_DENSITY) continue;
    if (claims.some((claim) => agreement(tokens, claim) >= MIN_AGREEMENT)) {
      return element;
    }
  }
  return null;
}

/**
 * Words to compare a dek and a description by: Latin-script words, and for
 * Chinese, Japanese and Korean — written without spaces — each pair of
 * neighbouring characters, which is what makes two phrasings of one sentence
 * agree without a word list.
 */
function tokensOf(text: string): Set<string> {
  const tokens = new Set<string>();
  const runs = text.normalize("NFKC").toLowerCase().match(TOKEN_RUNS) ?? [];
  for (const run of runs) {
    if (!CJK.test(run)) {
      tokens.add(run);
      continue;
    }
    const chars = Array.from(run);
    if (chars.length === 1) tokens.add(run);
    for (let i = 0; i + 1 < chars.length; i++) {
      tokens.add(`${chars[i]}${chars[i + 1]}`);
    }
  }
  return tokens;
}

/** A run of Chinese, Japanese or Korean characters, or a run of any other
 * letters and digits — never both in one run. */
const TOKEN_RUNS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])+/gu;
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function agreement(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / Math.max(a.size, b.size);
}

function linkDensity(element: Element): number {
  const total = (element.textContent ?? "").length;
  if (total === 0) return 0;
  let linked = 0;
  for (const link of Array.from(element.querySelectorAll("a"))) {
    linked += (link.textContent ?? "").length;
  }
  return linked / total;
}

interface LeadPicture {
  image: Element;
  /** The image's address, resolved. */
  src: string;
  /** Every key its addresses come to (`imageKey`). */
  keys: string[];
  /** The figure it sits in, inside the zone, when it sits in one. */
  figure: Element | null;
}

/**
 * The lead picture: a picture in the header that the page's card names, or
 * that the page sets as a `<figure>`. Before or after the headline — many
 * pages put the picture first. The first one, and only one.
 */
function leadPictureIn(
  zone: Zone,
  base: string,
  claimed: readonly string[],
): LeadPicture | null {
  const claimedKeys = new Set(keysOf(claimed));
  for (const image of inZone(zone)) {
    if (image.tagName !== "IMG") continue;
    if (excluded(image, zone.root)) continue;
    if (
      declaredPx(image, "width") < MIN_LEAD_WIDTH ||
      declaredPx(image, "height") < MIN_LEAD_HEIGHT
    ) {
      continue;
    }
    const names = `${image.getAttribute("class") ?? ""} ${image.getAttribute("id") ?? ""} ${image.getAttribute("alt") ?? ""}`;
    if (NOT_A_LEAD.test(names)) continue;
    const urls = imageUrls(image, base);
    const src = leadSource(image, base);
    if (src === null) continue;
    const keys = keysOf(urls);
    const figure = image.closest("figure");
    const inFigure =
      figure !== null && zone.root.contains(figure) && figure !== zone.root;
    if (keys.some((key) => claimedKeys.has(key)) || inFigure) {
      return { image, src, keys, figure: inFigure ? figure : null };
    }
  }
  return null;
}

/**
 * Every address an image is known by: what it shows now, what a lazy loader
 * will show, and every candidate of its `srcset` and its `<picture>`'s
 * sources. Readability's `_fixLazyImages` reads the same attributes.
 */
function imageUrls(image: Element, base: string): string[] {
  const urls: string[] = [];
  const add = (value: string | null) => {
    const url = followableUrl(value, base);
    if (url !== null) urls.push(url);
  };
  const addSet = (value: string | null) => {
    if (value === null) return;
    for (const { start, end } of srcsetUrlRanges(value)) {
      add(value.slice(start, end));
    }
  };
  for (const name of ["src", "data-src", "data-lazy-src", "data-original"]) {
    add(image.getAttribute(name));
  }
  for (const name of ["srcset", "data-srcset"])
    addSet(image.getAttribute(name));
  const picture = image.parentElement?.closest("picture");
  if (picture !== null && picture !== undefined) {
    for (const source of Array.from(picture.querySelectorAll("source"))) {
      addSet(source.getAttribute("srcset"));
    }
  }
  return urls;
}

/**
 * The address to show the lead picture by: a lazy loader's `data-src` first,
 * as for a picture essay — below the fold its `src` is still a placeholder —
 * then `src`, then the largest candidate of its `srcset` when it has nothing
 * else.
 */
function leadSource(image: Element, base: string): string | null {
  const own =
    followableUrl(image.getAttribute("data-src"), base) ??
    followableUrl(image.getAttribute("src"), base);
  if (own !== null) return own;
  for (const name of ["srcset", "data-srcset"]) {
    const value = image.getAttribute(name);
    if (value === null) continue;
    let best: { url: string; width: number } | null = null;
    for (const { start, end } of srcsetUrlRanges(value)) {
      const url = followableUrl(value.slice(start, end), base);
      if (url === null) continue;
      const descriptor = value.slice(end).split(",")[0] ?? "";
      const width = Number.parseFloat(descriptor) || 0;
      if (best === null || width > best.width) best = { url, width };
    }
    if (best !== null) return best.url;
  }
  return null;
}

function keysOf(urls: readonly string[]): string[] {
  return urls
    .map((url) => imageKey(url))
    .filter((key): key is string => key !== null);
}

/**
 * One picture's name across the addresses it is served under: the last two
 * segments of its path, without the size a CMS appends.
 *
 * A thumbnail service puts its crop in the path and keeps the asset at the
 * end (`/thumbor/…/960x540/media/img/2017/11/Riverboat/original.jpg`), and
 * WordPress appends a size to the file name (`photo-1152x648.jpg`), so the
 * card and the page name one picture differently. An image proxy is unwrapped
 * first, or every picture behind `/_next/image?url=…` would share one name.
 */
export function imageKey(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  const inner = url.searchParams.get("url");
  if (inner !== null && inner !== "") {
    try {
      return imageKey(new URL(inner, url).href);
    } catch {
      return null;
    }
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  // A proxy that carries the original address in its path: encoded as one
  // segment (Substack), or written out (Cloudflare's `/cdn-cgi/image/…/https://…`).
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? "";
    const decoded = safeDecode(segment);
    if (/^https?:\/\//i.test(decoded)) return imageKey(decoded);
    if (/^https?:$/i.test(segment) && i + 1 < segments.length) {
      return imageKey(`${segment}//${segments.slice(i + 1).join("/")}`);
    }
  }
  const tail = segments
    .slice(-2)
    .map((segment) => safeDecode(segment).toLowerCase());
  const last = tail.pop();
  if (last === undefined) return null;
  const file = last.replace(
    /(?:-\d+x\d+|-scaled|-e\d{10,})+(?=\.[a-z0-9]+$)/,
    "",
  );
  return [...tail, file].join("/");
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The dek as a paragraph of the article: its words and inline markup, its
 * links resolved, whatever is not text left behind. */
function dekHtml(dek: Element, base: string): string {
  const copy = dek.cloneNode(true) as Element;
  for (const junk of Array.from(copy.querySelectorAll(DEK_JUNK))) junk.remove();
  unwrapScriptLinks(copy);
  resolveLinksIn(copy, base);
  return `<p>${copy.innerHTML.trim()}</p>`;
}

/** A `javascript:` link is a control, not a link: Readability keeps its text
 * and drops the link, and so does this. */
function unwrapScriptLinks(element: Element): void {
  for (const link of Array.from(element.querySelectorAll("a[href]"))) {
    if (!/^\s*javascript:/i.test(link.getAttribute("href") ?? "")) continue;
    link.replaceWith(...Array.from(link.childNodes));
  }
}

/**
 * The lead picture, rebuilt clean: the image by its resolved address, its
 * `alt` and `title`, and the figure's caption — exactly the figure
 * `foldFiguresIn` turns into a picture with its caption under it. Nothing
 * else of the page's markup comes along: not the `<picture>` sources, not a
 * zoom button, not a link round the image.
 */
function pictureHtml(picture: LeadPicture, base: string): string {
  const doc = picture.image.ownerDocument;
  const image = doc.createElement("img");
  image.setAttribute("src", picture.src);
  for (const name of ["alt", "title"]) {
    const value = picture.image.getAttribute(name);
    if (value !== null && value.trim() !== "") image.setAttribute(name, value);
  }
  if (picture.figure === null) return `<p>${image.outerHTML}</p>`;
  const figure = doc.createElement("figure");
  figure.appendChild(image);
  const caption = picture.figure.querySelector("figcaption");
  if (caption !== null && (caption.textContent ?? "").trim() !== "") {
    const copy = caption.cloneNode(true) as Element;
    for (const junk of Array.from(copy.querySelectorAll(DEK_JUNK))) {
      junk.remove();
    }
    unwrapScriptLinks(copy);
    resolveLinksIn(copy, base);
    flattenBlocks(copy);
    figure.appendChild(copy);
  }
  return figure.outerHTML;
}

/**
 * A caption's words without the boxes a page lays them out in. Quanta sets a
 * credit three `<div>`s and a `<p>` deep, Big Think one `<div>` deep, and a
 * caption holding blocks is one `foldFiguresIn` declines — so the credit came
 * out as a paragraph of its own under the picture rather than its caption.
 * Each block is replaced by what it holds and a space, innermost first, which
 * is what a reader sees of it: the words, in order.
 */
function flattenBlocks(element: Element): void {
  for (const block of Array.from(element.querySelectorAll("*")).reverse()) {
    if (!BLOCKS.has(block.tagName)) continue;
    block.replaceWith(
      ...Array.from(block.childNodes),
      block.ownerDocument.createTextNode(" "),
    );
  }
}
