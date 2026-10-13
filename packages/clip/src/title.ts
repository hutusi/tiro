/**
 * An article's title: the headline the page displays (ADR 0042).
 *
 * Readability takes the title from the first source that has one, and JSON-LD
 * comes first. A publisher that writes one headline for search engines and
 * another for readers puts the search one there: The Atlantic's JSON-LD
 * `headline` and `<title>` say "I'm 53 years old. I'm 36 in my head." over an
 * article whose `<h1>`, `og:title` and `alternativeHeadline` all say "The
 * Puzzling Gap Between How Old You Are and How Old You Think You Are". 44 of
 * the vault's 97 Atlantic articles were filed under the headline nobody saw.
 *
 * The fix is not a better-ranked source. `og:title` is right for 40 of those
 * 44, but for "Masters of Love" it is the search headline too, and elsewhere
 * it carries a "| Site" suffix. Nor is it the `<h1>` alone: plenty of pages
 * spend theirs on a logo or a section name. It is the two together — an `<h1>`
 * the page's own metadata names as its headline, which neither a logo nor a
 * search headline can be.
 */

import { pageHides } from "./dom-prepare.ts";

/** What a page says its title is, read before Readability consumes it. */
export interface TitleEvidence {
  /** Every non-empty `<h1>` the page shows, as the reader saw its text. */
  headlines: string[];
  /** The page's metadata titles, as plain text: `og:title`, `twitter:title`,
   * and every JSON-LD article's `headline`, `name` and `alternativeHeadline`.
   * Evidence only — never the title itself, since JSON-LD strings arrive with
   * their markup still in them. */
  claims: string[];
}

/**
 * The JSON-LD types that describe an article. Readability's own list, anchored:
 * a `WebSite` or `Organization` node is named after the publisher, and letting
 * its `name` count would confirm an `<h1>` that holds the logo.
 */
const ARTICLE_TYPE =
  /^(?:Article|AdvertiserContentArticle|NewsArticle|AnalysisNewsArticle|AskPublicNewsArticle|BackgroundNewsArticle|BlogPosting|DiscussionForumPosting|LiveBlogPosting|OpinionNewsArticle|ReportageNewsArticle|ReviewNewsArticle|Report|SatiricalArticle|ScholarlyArticle|MedicalScholarlyArticle|SocialMediaPosting|TechArticle)$/;

/**
 * A type may be written as its full IRI — `https://schema.org/NewsArticle` —
 * which JSON-LD allows and the bare-name list above would refuse. That node's
 * `alternativeHeadline` can be the only claim that names the `<h1>`.
 */
const SCHEMA_IRI = /^(?:https?:\/\/schema\.org\/|schema:)/;

const TITLE_KEYS = ["headline", "name", "alternativeHeadline"] as const;

/**
 * A C1 control character: what Readability makes of a numeric reference into
 * the Windows-1252 range. It decodes `&#151;` with `fromCharCode`, where a
 * browser maps it to an em dash, so "How Google—and 104 Other Companies—Are"
 * was filed with U+0097 in place of each dash. No title means one.
 */
const C1 = /[\u0080-\u009f]/;

export function readTitleEvidence(doc: Document): TitleEvidence {
  const headlines: string[] = [];
  for (const h1 of Array.from(doc.querySelectorAll("h1"))) {
    // A hidden `<h1>` is not the headline the page displays, even when its
    // metadata names it: a sticky header's copy, a screen-reader-only heading,
    // or one of two responsive heroes. Taken, it could also win over the
    // visible one just by coming first.
    if (hiddenWithin(h1)) continue;
    const text = headlineText(h1);
    if (text !== "") headlines.push(text);
  }

  const claims: string[] = [];
  for (const key of ["og:title", "twitter:title"]) {
    for (const meta of Array.from(
      doc.querySelectorAll(`meta[property="${key}"], meta[name="${key}"]`),
    )) {
      const content = meta.getAttribute("content");
      if (content !== null) claims.push(content);
    }
  }
  for (const script of Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      // A page's broken JSON-LD is a fact about the page, not a reason to
      // lose the rest of the evidence.
      continue;
    }
    collectArticleTitles(parsed, claims);
  }
  return { headlines, claims: claims.map(plainText) };
}

/**
 * The title to file the article under: Readability's, unless the page shows a
 * headline its own metadata confirms and Readability's does not match it.
 *
 * Matching is by words — letters and digits, case-folded — so "Don't" and
 * "Don’t" are one headline. That is also why a title already matching an
 * `<h1>` is kept as it is rather than swapped for the `<h1>`'s text: six
 * corpus pages differ from their `<h1>` only in quote curl or case, and a re-clip
 * should not rewrite those for nothing. A title carrying a C1 character is the
 * exception, because there the `<h1>` is the same words spelled correctly.
 */
export function chooseTitle(title: string, evidence: TitleEvidence): string {
  const own = wordsOf(title);
  if (
    own !== "" &&
    !C1.test(title) &&
    evidence.headlines.some((headline) => wordsOf(headline) === own)
  ) {
    return title;
  }
  const claimed = new Set(
    [own, ...evidence.claims.map(wordsOf)].filter((words) => words !== ""),
  );
  return (
    evidence.headlines.find((headline) => claimed.has(wordsOf(headline))) ??
    title
  );
}

/** How X labels an Article's headline, the view that shows one in full, and
 * its text. */
const X_ARTICLE_TITLE = '[data-testid="twitter-article-title"]';
const X_ARTICLE_VIEW = '[data-testid="twitterArticleReadView"]';
const X_ARTICLE_TEXT = '[data-testid="twitterArticleRichTextView"]';

/**
 * An X Article's headline, taken out of the page so the body does not open by
 * repeating it (ADR 0043).
 *
 * X fits neither half of the rule above. Its headline is a `<div>`, not an
 * `<h1>` — the article's own section headings are the `<h1>`s — and the page a
 * browser renders carries no `og:title` and no JSON-LD, which X serves only to
 * crawlers. With nothing to confirm, Readability's title stands, and that is
 * the tab's: `(5) X` on an Article's own URL, the reader's unread count and the
 * site's name. All three X clips in the vault were filed under a tab title.
 *
 * X does label the headline, on `/article/` and `/status/` URLs alike. This
 * keys on that label rather than on the host, the way a Hacker News thread is
 * recognised (ADR 0038), so a page without it is untouched. Two guards:
 *
 * - **The label must sit in the view showing that Article's text**, as it did
 *   on all three pages measured. A post quoting an Article may preview it in
 *   a card, and that Article's title is not the post's.
 * - **Exactly one may be shown.** A page with several has no single headline.
 *
 * Removed, not just read: one of the three clips arrived with the headline as
 * its body's first paragraph, under the same words as the title above it.
 */
export function takeXArticleTitle(doc: Document): string | undefined {
  const shown = Array.from(doc.querySelectorAll(X_ARTICLE_TITLE)).filter(
    (element) =>
      element.closest(X_ARTICLE_VIEW)?.querySelector(X_ARTICLE_TEXT) != null &&
      !hiddenWithin(element),
  );
  const [only] = shown;
  if (only === undefined || shown.length > 1) return undefined;
  const text = headlineText(only);
  if (text === "") return undefined;
  only.remove();
  return text;
}

/** Whether `element` or anything around it is hidden by the page. */
function hiddenWithin(element: Element): boolean {
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
function headlineText(element: Element): string {
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

function collectArticleTitles(node: unknown, into: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectArticleTitles(item, into);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (Array.isArray(record["@graph"])) {
    collectArticleTitles(record["@graph"], into);
  }
  const type = record["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (
    !types.some(
      (t) =>
        typeof t === "string" && ARTICLE_TYPE.test(t.replace(SCHEMA_IRI, "")),
    )
  ) {
    return;
  }
  for (const key of TITLE_KEYS) {
    const value = record[key];
    if (typeof value === "string") into.push(value);
  }
}

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
function plainText(value: string): string {
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

function wordsOf(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
