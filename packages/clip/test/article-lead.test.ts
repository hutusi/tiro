import { describe, expect, test } from "bun:test";
import { imageOffsets } from "@tiro/shared";
import { Window } from "happy-dom";
import { imageKey, readLeadEvidence } from "../src/article-lead.ts";
import { clipPage } from "../src/clip-page.ts";
import type { ClipOptions } from "../src/dom-prepare.ts";

const PAGE = "https://magazine.example/archive/1875/01/old-times/537825/";

/** The whole clip, as the extension runs it, on a page at `PAGE`. A scoped
 * window, as in dom-prepare.test.ts: bun runs every test file in one
 * process. */
function clipOf(body: string, head = "", options: ClipOptions = {}) {
  const window = new Window({ url: PAGE });
  window.document.head.innerHTML = head;
  window.document.body.innerHTML = body;
  return clipPage(window.document as unknown as Document, PAGE, options);
}

function docOf(head: string, body = ""): Document {
  const window = new Window({ url: PAGE });
  window.document.head.innerHTML = head;
  window.document.body.innerHTML = body;
  return window.document as unknown as Document;
}

const HEADLINE = "Old Times on the River";
const DEK =
  "The first installment in a series about the author’s youthful training as a riverboat pilot";
const CDN = "https://cdn.magazine.example/thumbor";
/** The lead picture as the page sets it, and as its card names it: one
 * asset, two crops — what a thumbnail service serves. */
const LEAD_SRC = `${CDN}/aaa=/171x205:1399x896/960x540/media/img/2017/11/River-1/original.jpg`;
const CARD_SRC = `${CDN}/bbb=/170x217:1448x883/1200x625/media/img/2017/11/River-1/original.jpg`;

const head = (extra = "") =>
  `<title>${HEADLINE}</title><meta name="description" content="${DEK}"><meta property="og:image" content="${CARD_SRC}">${extra}`;

/** Prose enough for Readability to take the body as the article and leave
 * the header out: its sibling pass keeps a sibling scoring a fifth of the
 * body's, and below about sixteen paragraphs a header with a dek in it
 * scores that much. The Twain page's body outscores its header fifteenfold. */
const BODY = Array.from(
  { length: 20 },
  (_, i) =>
    `<p>Paragraph ${i + 1} of the installment, in which the boy watches the packet come in and decides, against every sensible counsel, that the river, wide and brown, is the only life worth living.</p>`,
).join("");

interface HeroParts {
  before?: string;
  dek?: string;
  figure?: string;
  after?: string;
}

const FIGURE = `<div class="ArticleLeadArt_root"><figure class="ArticleLeadFigure_root"><picture><source srcset="${LEAD_SRC} 960w"><img src="${LEAD_SRC}" width="960" height="540" alt=""></picture><figcaption class="ArticleLeadFigure_caption">Currier &amp; Ives / Library of Congress</figcaption></figure></div>`;

/** The Atlantic's article shape: a header beside the body, not inside it —
 * rubric, headline, dek, byline, lead figure, date, share — and the body in a
 * sibling `<section>`. */
function hero(parts: HeroParts = {}): string {
  const dek =
    parts.dek ??
    `<div class="ArticleHero_dek"><p class="ArticleDek_root">${DEK}</p></div>`;
  const figure = parts.figure ?? FIGURE;
  return `<header class="ArticleHero_root">${parts.before ?? ""}<div class="ArticleHero_rubric"><a href="/magazine/">Magazine</a></div><div class="ArticleHero_title"><h1>${HEADLINE}</h1></div>${dek}<div class="ArticleHero_byline"><address>By <a href="/author/mark-twain/">Mark Twain</a></address></div>${figure}<div class="ArticleHero_utility"><time datetime="1875-01-01">January 1875</time><div class="ArticleShare_root"><button>Share</button></div></div>${parts.after ?? ""}</header>`;
}

const atlantic = (header = hero(), body = BODY) =>
  `<main><article class="ArticleLayout_article">${header}<div><section class="ArticleBody_root">${body}</section></div></article></main>`;

describe("a header Readability left beside the body", () => {
  test("comes back as the dek and the captioned lead picture, before the body", () => {
    // The defect, reproduced: without the pass the clip opens on the body.
    const before = clipOf(atlantic(), head(), { recoverLead: false });
    expect(before.markdown).not.toContain(DEK);
    expect(imageOffsets(before.markdown)).toHaveLength(0);

    const md = clipOf(atlantic(), head()).markdown;
    expect(md.startsWith(`${DEK}\n\n![](${LEAD_SRC})`)).toBe(true);
    expect(md).toContain("Currier & Ives / Library of Congress");
    expect(md.indexOf("Library of Congress")).toBeLessThan(
      md.indexOf("Paragraph 1"),
    );
  });

  test("leaves the rest of the header behind", () => {
    const clip = clipOf(atlantic(), head());
    expect(clip.markdown).not.toContain("Mark Twain");
    expect(clip.markdown).not.toContain("Magazine](");
    expect(clip.markdown).not.toContain("January 1875");
    expect(clip.markdown).not.toContain("Share");
  });

  test("reports the lead on its own, exactly as the clip begins", () => {
    const clip = clipOf(atlantic(), head());
    const without = clipOf(atlantic(), head(), { recoverLead: false });
    expect(clip.lead).toBe(
      `${DEK}\n\n![](${LEAD_SRC})  \nCurrier & Ives / Library of Congress`,
    );
    expect(clip.markdown).toBe(`${clip.lead}\n\n${without.markdown}`);
  });

  test("keeps the excerpt as it was", () => {
    const clip = clipOf(atlantic(), head());
    const without = clipOf(atlantic(), head(), { recoverLead: false });
    expect(clip.excerpt).toBe(without.excerpt);
  });

  test("turns a subtitle heading into a paragraph", () => {
    // Substack's shape: the subtitle is an `<h3>` under the title.
    const subtitle =
      "Meta and Google have been stacking pull requests for a decade";
    const page = `<article><div class="post-header"><h1 class="post-title">${HEADLINE}</h1><h3 class="subtitle">${subtitle}</h3><div class="byline-wrapper"><a href="/@writer">The Writer</a></div></div><div class="available-content"><div class="body markup">${BODY}</div></div></article>`;
    const md = clipOf(
      page,
      `<title>${HEADLINE}</title><meta property="og:description" content="${subtitle}">`,
    ).markdown;
    expect(md.startsWith(`${subtitle}\n\n`)).toBe(true);
    expect(md).not.toContain("###");
  });

  test("finds a headline whose title carries the site's name", () => {
    // Quanta's shape: every title the page names carries the suffix, so
    // the clip's title does too, and only the `<h1>` stops short of it.
    const suffixed = `${HEADLINE} | The Magazine`;
    const ld = `<script type="application/ld+json">${JSON.stringify({ "@type": "Article", headline: suffixed })}</script>`;
    const titled = head().replace(
      `<title>${HEADLINE}</title>`,
      `<title>${suffixed}</title><meta property="og:title" content="${suffixed}">${ld}`,
    );
    const clip = clipOf(atlantic(), titled);
    expect(clip.title).toBe(suffixed);
    expect(clip.markdown.startsWith(DEK)).toBe(true);
  });

  test("never takes the site's name for the headline", () => {
    // A logo `<h1>` reads as the short part of a suffixed title; the header
    // it would open runs from the logo to the body.
    const suffixed = `${HEADLINE} | The Magazine`;
    const page = atlantic(
      hero({ before: `<div class="logo"><h1>The Magazine</h1></div>` }),
    ).replace(`<h1>${HEADLINE}</h1>`, `<h2>${HEADLINE}</h2>`);
    const ld = `<script type="application/ld+json">${JSON.stringify({ "@type": "Article", headline: suffixed })}</script>`;
    const md = clipOf(
      page,
      head().replace(
        `<title>${HEADLINE}</title>`,
        `<title>${suffixed}</title>${ld}`,
      ),
    ).markdown;
    expect(md).not.toContain(DEK);
  });

  test("takes a picture before the headline, in the page's order", () => {
    const page = atlantic(hero({ before: FIGURE, figure: "" }));
    const md = clipOf(page, head()).markdown;
    expect(md.startsWith(`![](${LEAD_SRC})`)).toBe(true);
    expect(md.indexOf("Library of Congress")).toBeLessThan(md.indexOf(DEK));
  });

  test("never takes a dek from before the headline", () => {
    const early = `<p class="kicker">${DEK}</p>`;
    const page = atlantic(hero({ before: early, dek: "" }));
    const md = clipOf(page, head()).markdown;
    expect(md).not.toContain(DEK);
  });

  test("confirms a dek by the article's JSON-LD alone", () => {
    const ld = `<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", description: DEK })}</script>`;
    const md = clipOf(atlantic(), `<title>${HEADLINE}</title>${ld}`).markdown;
    expect(md.startsWith(DEK)).toBe(true);
  });

  test("confirms a Chinese dek by its Chinese description", () => {
    const title = "河上旧时光";
    const dek = "作者回忆少年时代在密西西比河上学习驾驶汽船的经历";
    const body = Array.from(
      { length: 20 },
      (_, i) =>
        `<p>第${i + 1}段：小镇的男孩们只有一个永久的志向，那就是成为汽船上的人。每当汽船靠岸，沉睡的小镇便一下子醒来，人们从四面八方涌向码头。</p>`,
    ).join("");
    const page = `<main><article><header><h1>${title}</h1><p class="dek">${dek}</p></header><div><section>${body}</section></div></article></main>`;
    const md = clipOf(
      page,
      `<title>${title}</title><meta name="description" content="作者回忆少年时代在密西西比河上学习驾驶汽船的经历。">`,
    ).markdown;
    expect(md.startsWith(dek)).toBe(true);
  });

  test("resolves a relative link in the dek, and drops a script link", () => {
    const dek = `The first installment in a <a href="/series/river">series</a> about the author’s youthful <a href="javascript:void(0)">training</a> as a riverboat pilot`;
    const page = atlantic(hero({ dek: `<p class="dek">${dek}</p>` }));
    const md = clipOf(page, head()).markdown;
    expect(md).toContain("[series](https://magazine.example/series/river)");
    expect(md).not.toContain("javascript");
    expect(md).toContain("youthful training as");
  });
});

describe("the lead picture", () => {
  const card = (src: string) => `<meta property="og:image" content="${src}">`;
  const bare = (img: string) =>
    atlantic(hero({ figure: `<div class="lead">${img}</div>` }));
  const titleOnly = `<title>${HEADLINE}</title>`;

  test("matches its card across a CMS size suffix", () => {
    const src =
      "https://magazine.example/wp-content/uploads/2026/09/spaceweather-1152x648.jpg";
    const md = clipOf(
      bare(`<img src="${src}" width="1152" height="648" alt="A magnetogram">`),
      titleOnly +
        card(
          "https://magazine.example/wp-content/uploads/2026/09/spaceweather.jpg",
        ),
    ).markdown;
    expect(md.startsWith(`![A magnetogram](${src})`)).toBe(true);
  });

  test("is not every picture behind the same image proxy", () => {
    const proxied = (path: string) =>
      `/_next/image?url=${encodeURIComponent(`https://images.example${path}`)}&w=1080`;
    const md = clipOf(
      bare(
        `<img src="${proxied("/other.png")}" width="800" height="400" alt="Unrelated">`,
      ),
      titleOnly + card("https://images.example/hero.png"),
    ).markdown;
    expect(imageOffsets(md)).toHaveLength(0);
    const hit = clipOf(
      bare(
        `<img src="${proxied("/hero.png")}" width="800" height="400" alt="Hero">`,
      ),
      titleOnly + card("https://images.example/hero.png"),
    ).markdown;
    expect(hit.startsWith("![Hero](")).toBe(true);
  });

  test("is taken from a figure the card does not name", () => {
    const md = clipOf(atlantic(), titleOnly).markdown;
    expect(md.startsWith(`![](${LEAD_SRC})`)).toBe(true);
  });

  test("keeps a caption the page boxes in blocks as the picture's caption", () => {
    // Quanta's shape: the credit three boxes and a paragraph deep.
    const figure = `<figure><img src="${LEAD_SRC}" width="960" height="540" alt=""><figcaption><section><div><div class="credit"><p>Mark Belan/<em>The Magazine</em></p></div></div></section></figcaption></figure>`;
    const md = clipOf(atlantic(hero({ figure })), head()).markdown;
    expect(md).toContain(`![](${LEAD_SRC})  \nMark Belan/*The Magazine*\n\n`);
  });

  test("reads a lazy loader's address over its placeholder", () => {
    const md = clipOf(
      bare(
        `<img src="data:image/gif;base64,R0lGOD" data-src="${LEAD_SRC}" width="960" height="540" alt="">`,
      ),
      head(),
    ).markdown;
    expect(md).toContain(`![](${LEAD_SRC})`);
    expect(md).not.toContain("data:image");
  });

  test("reads every lazy loader's address over an ordinary placeholder", () => {
    // `/img/blank.gif` is as followable as the picture; the picture was
    // confirmed by its lazy address, and is what must be shown.
    for (const lazy of [
      `data-lazy-src="${LEAD_SRC}"`,
      `data-original="${LEAD_SRC}"`,
      `data-srcset="${LEAD_SRC} 960w"`,
    ]) {
      const md = clipOf(
        bare(
          `<img src="/img/blank.gif" ${lazy} width="960" height="540" alt="">`,
        ),
        head(),
      ).markdown;
      expect(md).toContain(`![](${LEAD_SRC})`);
      expect(md).not.toContain("blank.gif");
    }
  });

  test("takes the largest candidate of a srcset with no src", () => {
    const small = `${CDN}/s=/0x0:1x1/480x270/media/img/2017/11/River-1/original.jpg`;
    const md = clipOf(
      bare(
        `<img srcset="${small} 480w, ${LEAD_SRC} 960w" width="960" height="540" alt="">`,
      ),
      head(),
    ).markdown;
    expect(md).toContain(`![](${LEAD_SRC})`);
  });

  test("resolves a relative address", () => {
    const md = clipOf(
      bare(
        `<img src="/media/img/2017/11/River-1/original.jpg" width="960" height="540" alt="">`,
      ),
      head(),
    ).markdown;
    expect(md).toContain(
      "![](https://magazine.example/media/img/2017/11/River-1/original.jpg)",
    );
  });

  test("counts a lazy picture and its noscript copy once", () => {
    const md = clipOf(
      bare(
        `<img class="lazy" src="data:image/gif;base64,R0lGOD" width="960" height="540" alt=""><noscript><img src="${LEAD_SRC}" width="960" height="540" alt=""></noscript>`,
      ),
      head(),
    ).markdown;
    expect(imageOffsets(md)).toHaveLength(1);
    expect(md).toContain(`![](${LEAD_SRC})`);
  });
});

describe("no lead is added", () => {
  const unchanged = (body: string, headHtml = head()) =>
    expect(clipOf(body, headHtml).markdown).toBe(
      clipOf(body, headHtml, { recoverLead: false }).markdown,
    );

  test("when Readability already read the header", () => {
    // One `<article>`: headline, dek, figure and paragraphs as siblings.
    unchanged(
      `<main><article><h1>${HEADLINE}</h1><p class="dek">${DEK}</p>${FIGURE}${BODY}</article></main>`,
    );
  });

  test("when Readability kept a dek too short to mark where the body begins", () => {
    // The article opens on the body's first paragraph, the dek above it is
    // Readability's already, and it must not be added a second time.
    const dek = "the question everyone is asking";
    unchanged(
      `<main><article><h1>${HEADLINE}</h1><p class="dek">${dek}</p>${BODY}</article></main>`,
      `<title>${HEADLINE}</title><meta name="description" content="${dek}">`,
    );
  });

  test("when the description is the body's first paragraph", () => {
    const first = BODY.match(/<p>(.*?)<\/p>/)?.[1] ?? "";
    unchanged(
      atlantic(hero({ dek: "", figure: "" })),
      `<title>${HEADLINE}</title><meta name="description" content="${first}">`,
    );
  });

  test("from what the page hides", () => {
    for (const hide of ['hidden=""', 'aria-hidden="true"', 'class="hidden"']) {
      const page = atlantic(
        hero({
          dek: `<p ${hide}>${DEK}</p>`,
          figure: `<figure ${hide}><img src="${LEAD_SRC}" width="960" height="540" alt=""><figcaption>Credit</figcaption></figure>`,
        }),
      );
      const md = clipOf(page, head()).markdown;
      expect(md).not.toContain(DEK);
      expect(imageOffsets(md)).toHaveLength(0);
    }
  });

  test("from an advertisement, a related story or an aside", () => {
    const other = `${CDN}/c=/0x0:1x1/960x540/media/img/2026/promo/original.jpg`;
    for (const figure of [
      `<div class="ad-slot"><img src="${other}" width="970" height="250" alt=""></div>`,
      `<div class="related-stories"><figure><img src="${other}" width="960" height="540" alt=""><figcaption>Read next</figcaption></figure></div>`,
      `<aside><figure><img src="${other}" width="960" height="540" alt=""><figcaption>Read next</figcaption></figure></aside>`,
    ]) {
      const md = clipOf(atlantic(hero({ figure })), head()).markdown;
      expect(imageOffsets(md)).toHaveLength(0);
      expect(md).not.toContain("Read next");
    }
  });

  test("from a tag line, a date line or a menu, however their words overlap", () => {
    const description =
      "A long description of the article about rivers boats pilots and training on the water";
    const lines = `<div class="post-tags">rivers boats pilots training</div><p class="meta">January 1875 · rivers · boats</p><nav><a href="/rivers">rivers boats pilots and training</a></nav>`;
    const md = clipOf(
      atlantic(hero({ dek: lines, figure: "" })),
      `<title>${HEADLINE}</title><meta name="description" content="${description}">`,
    ).markdown;
    expect(md).not.toContain("rivers boats");
    expect(md).not.toContain("January 1875");
  });

  test("from a byline, even with the author's picture in a figure", () => {
    const byline = `<div class="byline"><figure><img src="${LEAD_SRC}" width="400" height="400" alt="Mark Twain"><figcaption>${DEK}</figcaption></figure></div>`;
    const md = clipOf(
      atlantic(hero({ dek: byline, figure: "" })),
      head(),
    ).markdown;
    expect(imageOffsets(md)).toHaveLength(0);
    expect(md).not.toContain(DEK);
  });

  test("from a caption, even when it repeats the description", () => {
    const figure = `<figure><img src="${LEAD_SRC}" width="960" height="540" alt=""><figcaption><p>${DEK}</p></figcaption></figure>`;
    const md = clipOf(atlantic(hero({ dek: "", figure })), head()).markdown;
    expect(md.split(DEK)).toHaveLength(2);
    expect(md.startsWith(`![](${LEAD_SRC})`)).toBe(true);
  });

  test("from a logo, however large", () => {
    const figure = `<figure><img src="${LEAD_SRC}" width="960" height="540" alt="The Magazine logo"></figure>`;
    const md = clipOf(atlantic(hero({ figure })), head()).markdown;
    expect(imageOffsets(md)).toHaveLength(0);
  });

  test("from a picture declared smaller than a lead", () => {
    const figure = `<figure><img src="${LEAD_SRC}" width="120" height="80" alt=""><figcaption>Thumbnail</figcaption></figure>`;
    const md = clipOf(atlantic(hero({ figure })), head()).markdown;
    expect(imageOffsets(md)).toHaveLength(0);
  });

  test("from a label of a few words", () => {
    const label = "River pilot training";
    const md = clipOf(
      atlantic(hero({ dek: `<p class="dek">${label}</p>`, figure: "" })),
      `<title>${HEADLINE}</title><meta name="description" content="${label}">`,
    ).markdown;
    expect(md).not.toContain(label);
  });

  test("from a line that is all link", () => {
    const md = clipOf(
      atlantic(
        hero({
          dek: `<p class="dek"><a href="/series/river">${DEK}</a></p>`,
          figure: "",
        }),
      ),
      head(),
    ).markdown;
    expect(md).not.toContain(DEK);
  });

  test("to an article whose body is too short to be one", () => {
    // A header Readability marks down (`masthead`) never joins the body,
    // however short the body is — what a script-built page leaves.
    const page = `<main><article><header class="masthead"><h1>${HEADLINE}</h1><p class="dek">${DEK}</p></header><div><section><p>${"A short note about the river and the boats on it, and the town beside it. ".repeat(4)}</p></section></div></article></main>`;
    const md = clipOf(page, head()).markdown;
    expect(md).not.toContain(DEK);
  });

  test("from a picture the markup declares icon-sized", () => {
    const md = clipOf(
      atlantic(
        hero({
          figure: `<img src="${CARD_SRC}" width="40" height="40" alt="">`,
        }),
      ),
      head(),
    ).markdown;
    expect(imageOffsets(md)).toHaveLength(0);
  });

  test("without a headline the page's metadata confirms", () => {
    const page = atlantic().replace(
      `<h1>${HEADLINE}</h1>`,
      "<h1>The Magazine</h1>",
    );
    unchanged(page);
    unchanged(atlantic().replace(`<h1>${HEADLINE}</h1>`, ""));
  });

  test("twice: one dek, one picture", () => {
    const page = atlantic(
      hero({
        after: `<p class="dek">${DEK}</p>${FIGURE.replace("Currier", "Second")}`,
      }),
    );
    const md = clipOf(page, head()).markdown;
    expect(md.split(DEK)).toHaveLength(2);
    expect(imageOffsets(md)).toHaveLength(1);
    expect(md).not.toContain("Second");
  });

  test("when the body already shows the lead picture, under another crop", () => {
    const body = `<figure><img src="${CARD_SRC}" alt="The river"><figcaption>The river</figcaption></figure>${BODY}`;
    unchanged(atlantic(hero(), body));
  });

  test("when the space before the body is too large to be a header", () => {
    const sidebar = `<div class="column">${"Words about other things entirely. ".repeat(200)}</div>`;
    unchanged(atlantic(hero({ after: sidebar })));
  });
});

describe("readLeadEvidence", () => {
  test("reads descriptions and card images by property or by name", () => {
    const evidence = readLeadEvidence(
      docOf(
        `<meta name="description" content="One"><meta property="og:description" content="Two"><meta name="twitter:description" content="Three"><meta name="og:image" content="/a.jpg"><meta property="twitter:image:src" content="https://cdn.example/b.jpg">`,
      ),
      PAGE,
    );
    expect(evidence.descriptions).toEqual(["One", "Two", "Three"]);
    expect(evidence.images).toEqual([
      "https://magazine.example/a.jpg",
      "https://cdn.example/b.jpg",
    ]);
  });

  test("reads an article's JSON-LD and nothing else's", () => {
    const ld = (value: unknown) =>
      `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
    const evidence = readLeadEvidence(
      docOf(
        `${ld({
          "@graph": [
            {
              "@type": "ImageObject",
              description: "Illustration by someone",
              url: "https://cdn.example/credit.jpg",
            },
            {
              "@type": "https://schema.org/NewsArticle",
              description: "The &lt;em&gt;dek&lt;/em&gt;",
              image: [
                "https://cdn.example/1.jpg",
                { "@type": "ImageObject", url: "https://cdn.example/2.jpg" },
              ],
              thumbnailUrl: "https://cdn.example/3.jpg",
            },
          ],
        })}<script type="application/ld+json">{ broken</script>`,
      ),
      PAGE,
    );
    expect(evidence.descriptions).toEqual(["The dek"]);
    expect(evidence.images).toEqual([
      "https://cdn.example/1.jpg",
      "https://cdn.example/2.jpg",
      "https://cdn.example/3.jpg",
    ]);
  });
});

describe("imageKey", () => {
  test("names one picture alike across its crops and sizes", () => {
    expect(imageKey(LEAD_SRC)).toBe(imageKey(CARD_SRC));
    expect(imageKey("https://a.example/up/2026/09/photo-1152x648.jpg")).toBe(
      imageKey("https://a.example/up/2026/09/photo.jpg"),
    );
    expect(imageKey("https://a.example/up/2026/01/art-scaled.jpg")).toBe(
      imageKey("https://a.example/up/2026/01/art.jpg"),
    );
  });

  test("looks through an image proxy to the picture behind it", () => {
    const inner =
      "https://substack-post-media.s3.amazonaws.com/public/images/abc.png";
    expect(
      imageKey(
        `https://substackcdn.com/image/fetch/w_1456,c_limit/${encodeURIComponent(inner)}`,
      ),
    ).toBe(imageKey(inner));
    expect(
      imageKey(`https://dev.example/cdn-cgi/image/width=1000/${inner}`),
    ).toBe(imageKey(inner));
    expect(
      imageKey(
        "https://site.example/_next/image?url=%2Fimages%2Fhero.png&w=1080",
      ),
    ).toBe(imageKey("https://site.example/images/hero.png"));
    expect(
      imageKey(
        "https://site.example/_next/image?url=%2Fimages%2Fhero.png&w=1080",
      ),
    ).not.toBe(
      imageKey(
        "https://site.example/_next/image?url=%2Fimages%2Fother.png&w=1080",
      ),
    );
  });
});
