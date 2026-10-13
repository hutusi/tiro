import { describe, expect, test } from "bun:test";
import { Readability } from "@mozilla/readability";
import { Window } from "happy-dom";
import { clipPage } from "../src/clip-page.ts";
import { chooseTitle, readTitleEvidence } from "../src/title.ts";

/**
 * A scoped window rather than happy-dom's global registrator, for the reason
 * given in dom-prepare.test.ts: bun runs every test file in one process.
 */
function pageFrom(head: string, body: string): Document {
  const window = new Window({ url: "https://news.example/2023/04/story/1/" });
  window.document.head.innerHTML = head;
  window.document.body.innerHTML = body;
  return window.document as unknown as Document;
}

const URL = "https://news.example/2023/04/story/1/";

/** Enough prose for Readability to take the article and leave the masthead. */
const ARTICLE = `<article>${Array.from(
  { length: 6 },
  (_, i) =>
    `<p>Paragraph ${i + 1} of the story, long enough that Readability scores it as the article's body rather than as page furniture around it, with a comma, and another.</p>`,
).join("")}</article>`;

function jsonLd(value: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

const SEO = "I’m 53 years old. I’m 36 in my head.";
const DISPLAY =
  "The Puzzling Gap Between How Old You Are and How Old You Think You Are";

/** What Readability alone files the page under — main's title, before ADR 0042. */
function readabilityTitle(doc: Document): string {
  const clone = doc.cloneNode(true) as Document;
  return new Readability(clone).parse()?.title ?? "";
}

describe("clipPage titles an article with the headline it displays", () => {
  /**
   * The Atlantic's shape, and the reason for all of this: the search headline
   * in `<title>` and JSON-LD `headline`, the displayed one in the `<h1>`,
   * `og:title` and `alternativeHeadline`.
   */
  test("the <h1> wins over a JSON-LD headline written for search", () => {
    const head = `<title>${SEO} - The Atlantic</title>
      <meta property="og:title" content="${DISPLAY}">
      ${jsonLd({
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        headline: SEO,
        alternativeHeadline: DISPLAY,
      })}`;
    const body = `<header><h1>${DISPLAY}</h1></header>${ARTICLE}`;
    // The fixture has to reproduce the defect, or the assertion below proves
    // nothing about it.
    expect(readabilityTitle(pageFrom(head, body))).toBe(SEO);
    expect(clipPage(pageFrom(head, body), URL).title).toBe(DISPLAY);
  });

  /**
   * "Masters of Love": `og:title` is the search headline too, so ranking
   * `og:title` above JSON-LD would not have fixed it. Only
   * `alternativeHeadline` names the `<h1>`.
   */
  test("alternativeHeadline alone can confirm the <h1>", () => {
    const head = `<meta property="og:title" content="The Secret to Love Is Just Kindness">
      ${jsonLd({
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        headline: "The Secret to Love Is Just Kindness",
        alternativeHeadline: "Masters of Love",
      })}`;
    const body = `<header><h1>Masters of Love</h1></header>${ARTICLE}`;
    expect(clipPage(pageFrom(head, body), URL).title).toBe("Masters of Love");
  });

  /**
   * `&#151;` is a Windows-1252 em dash to a browser and U+0097 to Readability.
   * The `<h1>` is the same words, spelled the way the page shows them.
   */
  test("a title Readability mis-decoded gives way to the <h1>", () => {
    const shown = "How Google—and 104 Other Companies—Are Tracking Me";
    const head = `<meta property="og:title" content="I'm Being Followed">
      ${jsonLd({
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        headline:
          "How Google&#151;and 104 Other Companies&#151;Are Tracking Me",
      })}`;
    const body = `<header><h1>${shown}</h1></header>${ARTICLE}`;
    expect(readabilityTitle(pageFrom(head, body))).toContain("\u0097");
    expect(clipPage(pageFrom(head, body), URL).title).toBe(shown);
  });

  test("an <h1> no metadata names is not the headline", () => {
    const head = `<meta property="og:title" content="The Real Story">
      ${jsonLd([
        {
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "Masthead",
        },
        {
          "@context": "https://schema.org",
          "@type": "NewsArticle",
          headline: "The Real Story",
        },
      ])}`;
    // The site's own name is in its WebSite node — which must not count, or
    // the logo would be confirmed as the headline.
    const body = `<header><h1>Masthead</h1></header>${ARTICLE}`;
    expect(clipPage(pageFrom(head, body), URL).title).toBe("The Real Story");
  });

  test("a page with no <h1> keeps Readability's title", () => {
    const head = `<meta property="og:title" content="Only Metadata">`;
    expect(clipPage(pageFrom(head, ARTICLE), URL).title).toBe("Only Metadata");
  });

  /**
   * Both headings are confirmed, the hidden one by `alternativeHeadline` and
   * the shown one by `og:title`, and the hidden one comes first. Taking the
   * first confirmed `<h1>` would file the article under a heading nobody saw.
   */
  test.each([
    ["the hidden attribute", "<h1 hidden>Sticky Copy</h1>"],
    ["an inline display: none", '<h1 style="display: none">Sticky Copy</h1>'],
    ["aria-hidden", '<h1 aria-hidden="true">Sticky Copy</h1>'],
    ["a hiding class", '<h1 class="sr-only">Sticky Copy</h1>'],
    [
      "a hidden ancestor",
      "<div hidden><header><h1>Sticky Copy</h1></header></div>",
    ],
  ])("an <h1> hidden by %s is passed over", (_, hidden) => {
    const head = `<meta property="og:title" content="Shown Headline">
      ${jsonLd({
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        headline: "Search Headline",
        alternativeHeadline: "Sticky Copy",
      })}`;
    const body = `${hidden}<header><h1>Shown Headline</h1></header>${ARTICLE}`;
    expect(clipPage(pageFrom(head, body), URL).title).toBe("Shown Headline");
  });

  test("a hidden <h1> alone leaves Readability's title standing", () => {
    const head = `<meta property="og:title" content="Sticky Copy">
      ${jsonLd({
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        headline: "Search Headline",
      })}`;
    const body = `<h1 hidden>Sticky Copy</h1>${ARTICLE}`;
    expect(clipPage(pageFrom(head, body), URL).title).toBe("Search Headline");
  });
});

describe("chooseTitle", () => {
  test("a title matching an <h1> word for word is kept as written", () => {
    // Six corpus pages differ from their `<h1>` only like this; a re-clip
    // should not rewrite them.
    expect(
      chooseTitle("You don't need to work on hard problems", {
        headlines: ["You don’t need to work on hard problems"],
        claims: ["You don't need to work on hard problems"],
      }),
    ).toBe("You don't need to work on hard problems");
  });

  test("a site-name suffix gives way to the <h1> og:title confirms", () => {
    expect(
      chooseTitle("Introducing Delta - Zed Blog", {
        headlines: ["Introducing Delta"],
        claims: ["Introducing Delta"],
      }),
    ).toBe("Introducing Delta");
  });

  test("an empty title is filled from a confirmed <h1>", () => {
    expect(
      chooseTitle("", {
        headlines: ["How to keep enjoying programming"],
        claims: ["How to keep enjoying programming"],
      }),
    ).toBe("How to keep enjoying programming");
  });

  test("with no confirmed <h1>, Readability's title stands", () => {
    expect(
      chooseTitle("Readability's Pick", {
        headlines: ["Section Name", "Another Heading"],
        claims: ["Something Else"],
      }),
    ).toBe("Readability's Pick");
  });

  test("the first confirmed <h1> wins", () => {
    expect(
      chooseTitle("Search Headline", {
        headlines: ["Masthead", "Shown Headline", "Also Claimed"],
        claims: ["Search Headline", "Also Claimed", "Shown Headline"],
      }),
    ).toBe("Shown Headline");
  });
});

describe("readTitleEvidence", () => {
  /**
   * An icon the page marks `aria-hidden` has no letters, so words would still
   * match and the icon would lead the title. Screen-reader text has letters,
   * and would keep the `<h1>` from matching any claim at all.
   */
  test("reads only the parts of an <h1> the page shows", () => {
    const doc = pageFrom(
      "",
      '<h1><span aria-hidden="true">★ </span>The Story<span class="visually-hidden"> (opens in a new tab)</span><span hidden> draft</span></h1>',
    );
    expect(readTitleEvidence(doc).headlines).toEqual(["The Story"]);
  });

  test("reads an <h1> as it reads, a <br> as a space", () => {
    const doc = pageFrom(
      "",
      "<h1>Title<br>of the <em>Story</em> </h1><h1> </h1>",
    );
    expect(readTitleEvidence(doc).headlines).toEqual(["Title of the Story"]);
  });

  /**
   * The Atlantic escapes the markup in its JSON-LD headlines, sometimes twice.
   * Left as written, `<em>` would read as the words "lt em gt" and the claim
   * could never match.
   */
  test("unescapes JSON-LD strings, twice, and drops the markup", () => {
    const doc = pageFrom(
      jsonLd({
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        headline: "&lt;em&gt;Once&lt;/em&gt; Escaped",
        alternativeHeadline:
          "&amp;lt;em&amp;gt;Don’t Write With AI&amp;lt;/em&amp;gt;, Say People",
      }),
      "",
    );
    expect(readTitleEvidence(doc).claims).toEqual([
      "Once Escaped",
      "Don’t Write With AI, Say People",
    ]);
  });

  test("finds articles in @graph and under a list of types", () => {
    const doc = pageFrom(
      jsonLd({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Publisher" },
          { "@type": ["Article", "BlogPosting"], headline: "In the Graph" },
        ],
      }),
      "",
    );
    expect(readTitleEvidence(doc).claims).toEqual(["In the Graph"]);
  });

  test("knows an article type written as its full IRI", () => {
    const doc = pageFrom(
      jsonLd([
        { "@type": "https://schema.org/NewsArticle", headline: "Absolute" },
        { "@type": "http://schema.org/BlogPosting", headline: "Insecure" },
        { "@type": "schema:Article", headline: "Compact" },
        { "@type": "https://schema.org/Organization", name: "Publisher" },
        { "@type": "https://example.com/Article", headline: "Elsewhere" },
      ]),
      "",
    );
    expect(readTitleEvidence(doc).claims).toEqual([
      "Absolute",
      "Insecure",
      "Compact",
    ]);
  });

  test("reads og:title and twitter:title, by property or by name", () => {
    const doc = pageFrom(
      `<meta property="og:title" content="Open Graph">
       <meta name="twitter:title" content="Twitter Card">`,
      "",
    );
    expect(readTitleEvidence(doc).claims).toEqual([
      "Open Graph",
      "Twitter Card",
    ]);
  });

  test("skips JSON-LD that does not parse", () => {
    const doc = pageFrom(
      `<script type="application/ld+json">{ not json</script>
       <meta property="og:title" content="Still Read">`,
      "",
    );
    expect(readTitleEvidence(doc).claims).toEqual(["Still Read"]);
  });

  test("leaves the document as it found it", () => {
    const doc = pageFrom(
      `<meta property="og:title" content="A">`,
      `<h1>A<br>B</h1>${ARTICLE}`,
    );
    const before = doc.documentElement.outerHTML;
    readTitleEvidence(doc);
    expect(doc.documentElement.outerHTML).toBe(before);
  });
});
