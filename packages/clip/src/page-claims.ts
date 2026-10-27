import { pageHides } from "./dom-prepare.ts";

/**
 * What a page says about itself, read before Readability consumes it: the
 * metadata a clip may hold the page's own markup to (ADR 0042, ADR 0052).
 *
 * Claims, never content. A JSON-LD string arrives with its markup still in it,
 * a meta description may be written for search engines rather than readers,
 * and an og:image may be a card nobody sees on the page. What they are good for
 * is confirming that something the page *shows* is what the page says it is:
 * an `<h1>` that is the headline, a paragraph that is the dek, a picture that
 * is the lead.
 */

/**
 * The JSON-LD types that describe an article. Readability's own list, anchored:
 * a `WebSite` or `Organization` node is named after the publisher, and letting
 * its `name` count would confirm an `<h1>` that holds the logo.
 */
export const ARTICLE_TYPE =
  /^(?:Article|AdvertiserContentArticle|NewsArticle|AnalysisNewsArticle|AskPublicNewsArticle|BackgroundNewsArticle|BlogPosting|DiscussionForumPosting|LiveBlogPosting|OpinionNewsArticle|ReportageNewsArticle|ReviewNewsArticle|Report|SatiricalArticle|ScholarlyArticle|MedicalScholarlyArticle|SocialMediaPosting|TechArticle)$/;

/**
 * A type may be written as its full IRI — `https://schema.org/NewsArticle` —
 * which JSON-LD allows and the bare-name list above would refuse. That node's
 * `alternativeHeadline` can be the only claim that names the `<h1>`.
 */
export const SCHEMA_IRI = /^(?:https?:\/\/schema\.org\/|schema:)/;

/**
 * Every JSON-LD node on the page that describes an article, in document order —
 * the only nodes whose headline, description or image speak for the article.
 * Walks arrays and `@graph`, as Readability does; a script whose JSON is broken
 * is a fact about the page, not a reason to lose the rest, and is skipped.
 */
export function articleJsonLd(doc: Document): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record["@graph"])) collect(record["@graph"]);
    const type = record["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (
      types.some(
        (t) =>
          typeof t === "string" && ARTICLE_TYPE.test(t.replace(SCHEMA_IRI, "")),
      )
    ) {
      nodes.push(record);
    }
  };
  for (const script of Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  )) {
    try {
      collect(JSON.parse(script.textContent ?? ""));
    } catch {
      // Broken JSON-LD: skipped, as above.
    }
  }
  return nodes;
}

/** The `content` of every `<meta>` naming one of `keys`, by `property` or by
 * `name` — publishers use both for the same Open Graph keys — in document
 * order. */
export function metaContents(doc: Document, keys: readonly string[]): string[] {
  const contents: string[] = [];
  for (const key of keys) {
    for (const meta of Array.from(
      doc.querySelectorAll(`meta[property="${key}"], meta[name="${key}"]`),
    )) {
      const content = meta.getAttribute("content");
      if (content !== null) contents.push(content);
    }
  }
  return contents;
}

/** Where a page describes itself, best first: the Open Graph text is the one
 * written for a person to read, the plain `description` is often written for
 * a search engine, and the Twitter card usually repeats one of the two. */
const DESCRIPTION_ORDER = [
  "og:description",
  "description",
  "twitter:description",
] as const;

/** The page's description of itself, or "" when it gives none. */
export function pageDescription(doc: Document): string {
  for (const content of metaContents(doc, DESCRIPTION_ORDER)) {
    const text = content.replace(/\s+/g, " ").trim();
    if (text !== "") return text;
  }
  return "";
}

/** Whether `element` or anything around it is hidden by the page. */
export function hiddenWithin(element: Element): boolean {
  for (
    let node: Element | null = element;
    node !== null;
    node = node.parentElement
  ) {
    if (pageHides(node)) return true;
  }
  return false;
}

/**
 * A headline's text as it reads: a `<br>` is a space, not a join, and a part
 * the page hides is not read at all. An `aria-hidden` icon would otherwise lead
 * the title, since words match on letters and digits and would not notice it,
 * and a screen-reader-only "(opens in a new tab)" would keep the `<h1>` from
 * matching anything.
 */
export function headlineText(element: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) parts.push(child.nodeValue ?? "");
      else if (child.nodeName === "BR") parts.push(" ");
      else if (
        child.nodeType === 1 &&
        !UNREAD.has(child.nodeName) &&
        !pageHides(child as Element)
      ) {
        walk(child);
      }
    }
  };
  walk(element);
  return parts.join("").replace(/\s+/g, " ").trim();
}

const UNREAD = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

/** The entities that matter to words, and to undoing a second escape. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * A JSON-LD string as text. The Atlantic escapes the markup in its headlines,
 * sometimes twice — `&amp;lt;em&amp;gt;Don’t Write With AI&amp;lt;/em&amp;gt;`
 * — so each pass decodes and then drops whatever tags that exposed. An entity
 * this does not know is left as written, which can only make a claim fail to
 * match: the safe direction, since a claim that matches nothing changes
 * nothing.
 */
export function plainText(value: string): string {
  let text = value;
  for (let pass = 0; pass < 2; pass++) {
    text = text
      .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, ref: string) => {
        if (ref.startsWith("#")) {
          const code =
            ref[1] === "x" || ref[1] === "X"
              ? Number.parseInt(ref.slice(2), 16)
              : Number.parseInt(ref.slice(1), 10);
          return code > 0 && code <= 0x10ffff
            ? String.fromCodePoint(code)
            : " ";
        }
        return NAMED[ref.toLowerCase()] ?? entity;
      })
      .replace(/<[^>]*>/g, "");
  }
  return text;
}

export function wordsOf(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
