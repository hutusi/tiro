import { describe, expect, test } from "bun:test";
import { imageOffsets } from "@tiro/shared";
import { Window } from "happy-dom";
import { clipPage } from "../src/clip-page.ts";
import { pictureEssayIn } from "../src/picture-essay.ts";

const PAGE = "https://www.ways-of-seeing.example/ch2";

/** The whole clip, as the extension runs it, on a page at `PAGE`. */
function clipOf(body: string, head = "") {
  const window = new Window({ url: PAGE });
  window.document.head.innerHTML = head;
  window.document.body.innerHTML = body;
  return clipPage(window.document as unknown as Document, PAGE);
}

function clip(body: string): string {
  return clipOf(body).markdown;
}

/** The shape Ways of Seeing serves its wordless chapters in: a header naming
 * the book, then a `<main>` of photographs in pairs, a chapter number and a
 * link on. Relative addresses, as the page writes them. */
const header = `<header><a href="/"><div class="book-header"><h3 class="book-title">Ways of Seeing</h3><h5 class="book-author">John Berger</h5></div></a><nav class="chapters"><a href="/ch1">1</a><a href="/ch2">2</a><a href="/ch3">3</a></nav></header>`;
const pair = (a: number, b: number, alt = "") =>
  `<div class="img-container"><img class="two" src="images/ch2_${a}.jpg" alt="${alt}"><img class="two" src="images/ch2_${b}.jpg" alt="${alt}"></div>`;
const essay = (pictures: string) =>
  `${header}<main class="photo-essay"><h1 class="chapter">2</h1>${pictures}<div class="next-chapter"><a href="/ch3">Next Chapter</a></div></main>`;
const prose = (letters: string) => `<p>${letters}</p>`;

describe("a page that is nothing but pictures", () => {
  test("clips as its pictures, in the page's order, with absolute addresses", () => {
    // Before: Readability scored the header as the article, and the clip was
    // "Ways of Seeing / John Berger" with none of the ten pictures.
    const md = clip(essay(pair(0, 1) + pair(2, 3) + pair(4, 5)));
    expect(imageOffsets(md)).toHaveLength(6);
    for (let n = 0; n <= 5; n++) {
      expect(md).toContain(
        `(https://www.ways-of-seeing.example/images/ch2_${n}.jpg)`,
      );
    }
    expect(md.indexOf("ch2_0.jpg")).toBeLessThan(md.indexOf("ch2_5.jpg"));
  });

  test("leaves the page's furniture behind", () => {
    const md = clip(essay(pair(0, 1) + pair(2, 3)));
    expect(md).not.toContain("Ways of Seeing");
    expect(md).not.toContain("John Berger");
    expect(md).not.toContain("Next Chapter");
  });

  test("keeps each picture's name", () => {
    const md = clip(essay(pair(0, 1, "Pity by William Blake") + pair(2, 3)));
    expect(md).toContain("![Pity by William Blake](");
  });

  test("keeps a figure whole, so its caption comes with it", () => {
    // Captions long enough together to pass for prose if they were counted:
    // a captioned essay is still an essay.
    const figure = (n: number) =>
      `<figure><img src="images/f${n}.jpg" alt=""><figcaption>Plate ${n}: an oil painting of a woman reading by a window</figcaption></figure>`;
    const md = clip(essay(figure(1) + figure(2) + figure(3)));
    expect(imageOffsets(md)).toHaveLength(3);
    for (const n of [1, 2, 3]) expect(md).toContain(`Plate ${n}:`);
  });

  test("points a figure's links at the page they came from", () => {
    // Left relative, both would be published as links into Tiro.
    const figure = (n: number) =>
      `<figure><a href="/full/${n}.jpg"><img src="images/f${n}.jpg" alt=""></a><figcaption>By <a href="/artists/${n}">the artist</a></figcaption></figure>`;
    const md = clip(essay(figure(1) + figure(2) + figure(3)));
    expect(imageOffsets(md)).toHaveLength(3);
    expect(md).toContain("(https://www.ways-of-seeing.example/full/1.jpg)");
    expect(md).toContain("(https://www.ways-of-seeing.example/artists/1)");
    expect(md).not.toMatch(/\]\(\//);
  });

  test("counts each picture in a figure, not each figure", () => {
    // One plate of three photographs is three pictures, enough for an essay.
    const md = clip(
      essay(
        `<figure><img src="images/p1.jpg" alt=""><img src="images/p2.jpg" alt=""><img src="images/p3.jpg" alt=""><figcaption>Plate 1</figcaption></figure>`,
      ),
    );
    expect(imageOffsets(md)).toHaveLength(3);
    expect(md).toContain("Plate 1");
  });

  test("leaves an icon out of the figure it sits in, and keeps the caption", () => {
    const figure = (n: number) =>
      `<figure><img src="images/f${n}.jpg" alt=""><img src="icons/zoom.svg" width="16" height="16" alt="Zoom"><figcaption>Plate ${n}</figcaption></figure>`;
    const md = clip(essay(figure(1) + figure(2) + figure(3)));
    expect(imageOffsets(md)).toHaveLength(3);
    expect(md).not.toContain("zoom.svg");
    for (const n of [1, 2, 3]) expect(md).toContain(`Plate ${n}`);
  });

  test("takes a lazy loader's address over its placeholder", () => {
    const lazy = (n: number) =>
      `<img src="data:image/gif;base64,R0lGOD" data-src="images/lazy${n}.jpg" alt="">`;
    const md = clip(essay(lazy(1) + lazy(2) + lazy(3)));
    expect(md).toContain(
      "(https://www.ways-of-seeing.example/images/lazy1.jpg)",
    );
    expect(md).not.toContain("data:image");
  });

  test("takes a lazy loader's address over a placeholder that is an ordinary file", () => {
    // `/img/blank.gif` is as followable as the picture is, so only the order
    // the two are asked in tells them apart.
    const lazy = (n: number) =>
      `<img src="/img/blank.gif" data-src="images/lazy${n}.jpg" alt="">`;
    const md = clip(essay(lazy(1) + lazy(2) + lazy(3)));
    expect(md).toContain(
      "(https://www.ways-of-seeing.example/images/lazy1.jpg)",
    );
    expect(md).not.toContain("blank.gif");
  });

  test("counts a lazy picture and its <noscript> copy once", () => {
    // The copy wins, as in Readability: it had to work with no script.
    const lazy = (n: number, alt = "") =>
      `<img class="lazy" src="data:image/gif;base64,R0lGOD" data-src="images/lazy${n}.jpg" alt="${alt}"><noscript><img src="images/full${n}.jpg"></noscript>`;
    const three = clip(
      essay(lazy(1, "Pity by William Blake") + lazy(2) + lazy(3)),
    );
    expect(imageOffsets(three)).toHaveLength(3);
    expect(three).not.toContain("images/lazy");
    expect(three).toContain(
      "![Pity by William Blake](https://www.ways-of-seeing.example/images/full1.jpg)",
    );
    // Two pictures are two, whatever the markup repeats: not an essay.
    expect(imageOffsets(clip(essay(lazy(1) + lazy(2))))).toHaveLength(0);
  });

  test("keeps the copy of a placeholder hidden until it loads", () => {
    const lazy = (n: number) =>
      `<img class="lazy" style="display: none" data-src="images/lazy${n}.jpg" alt=""><noscript><img src="images/full${n}.jpg"></noscript>`;
    const md = clip(essay(lazy(1) + lazy(2) + lazy(3)));
    expect(imageOffsets(md)).toHaveLength(3);
    expect(md).toContain("images/full3.jpg");
  });

  test("keeps the link round a lazy picture when its copy takes over", () => {
    // A thumbnail linking to the full-size picture, the copy linked the same
    // way or not at all: the link is what the reader saw either way.
    const linked = (n: number, copy: string) =>
      `<figure><a href="/full/${n}.jpg"><img class="lazy" src="data:image/gif;base64,R0lGOD" data-src="images/t${n}.jpg" alt=""></a><noscript>${copy}</noscript><figcaption>Plate ${n}</figcaption></figure>`;
    const both = (n: number) =>
      linked(n, `<a href="/full/${n}.jpg"><img src="images/t${n}.jpg"></a>`);
    const lazyOnly = (n: number) => linked(n, `<img src="images/t${n}.jpg">`);
    for (const figure of [both, lazyOnly]) {
      const md = clip(essay(figure(1) + figure(2) + figure(3)));
      expect(imageOffsets(md)).toHaveLength(3);
      expect(md).toContain(
        "[![](https://www.ways-of-seeing.example/images/t1.jpg)](https://www.ways-of-seeing.example/full/1.jpg)",
      );
    }
  });

  test("keeps the link when what the page hides is a wrapper, not the image", () => {
    // The copy cannot go inside the hidden wrapper — it would be dropped with
    // it — so it takes the wrapper's place, under the link.
    const lazy = (n: number) =>
      `<figure><a href="/full/${n}.jpg"><span class="hidden"><img class="lazy" data-src="images/t${n}.jpg" alt=""></span></a><noscript><img src="images/t${n}.jpg"></noscript></figure>`;
    const md = clip(essay(lazy(1) + lazy(2) + lazy(3)));
    expect(imageOffsets(md)).toHaveLength(3);
    expect(md).toContain(
      "[![](https://www.ways-of-seeing.example/images/t3.jpg)](https://www.ways-of-seeing.example/full/3.jpg)",
    );
  });

  test("does not take a tracking pixel for a picture's copy", () => {
    // The commonest image in a <noscript>. Swapped in, it would be dropped as
    // an icon or as hidden, and the picture before it with it. Facebook's is
    // both; Google Ads' only declares its size; some beacons only hide.
    const pixels = [
      `<img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1&amp;ev=PageView&amp;noscript=1">`,
      `<div style="display:inline;"><img height="1" width="1" style="border-style:none;" alt="" src="https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/"></div>`,
      `<img style="display:none" alt="" src="https://beacon.example/p.gif">`,
    ];
    for (const pixel of pixels) {
      const after = (n: number) =>
        `<img src="images/r${n}.jpg" alt=""><noscript>${pixel}</noscript>`;
      const md = clip(essay(after(1) + after(2) + after(3)));
      expect(imageOffsets(md)).toHaveLength(3);
      expect(md).toContain("images/r3.jpg");
    }
  });

  test("does not count icons as pictures", () => {
    const icon = (n: number) =>
      `<img src="icons/${n}.svg" width="24" height="24" alt="">`;
    const md = clip(essay(icon(1) + icon(2) + icon(3) + icon(4)));
    expect(imageOffsets(md)).toHaveLength(0);
  });

  test("leaves out the pictures the page hides", () => {
    // Each way a detached copy can still tell: the attribute, an inline
    // style, a carousel's clones, a framework's class.
    const hidden = [
      `<figure hidden><img src="images/h1.jpg" alt=""></figure>`,
      `<div class="lightbox" style="display: none"><img src="images/h2.jpg" alt=""></div>`,
      `<div aria-hidden="true"><img src="images/h3.jpg" alt=""></div>`,
      `<div class="hidden"><img src="images/h4.jpg" alt=""></div>`,
    ].join("");
    const md = clip(essay(pair(0, 1) + hidden + pair(2, 3)));
    expect(imageOffsets(md)).toHaveLength(4);
    expect(md).not.toContain("images/h");
  });

  test("is not found in a landmark the page hides", () => {
    const md = clip(
      essay(pair(0, 1) + pair(2, 3)).replace(
        '<main class="photo-essay">',
        '<main class="photo-essay" hidden>',
      ),
    );
    expect(imageOffsets(md)).toHaveLength(0);
  });
});

describe("a picture essay's excerpt", () => {
  // A tagline in the header Readability chooses: with no description in the
  // page's metadata, its excerpt is that paragraph.
  const tagline = "Essays on art and the ways we look at it";
  const withTagline = (pictures: string) =>
    essay(pictures).replace("</h5>", `</h5><p class="tagline">${tagline}</p>`);

  test("is not read out of the header the essay replaced", () => {
    const page = clipOf(withTagline(pair(0, 1) + pair(2, 3)));
    expect(imageOffsets(page.markdown)).toHaveLength(4);
    expect(page.excerpt).toBe("");
  });

  test("is the page's own description when it has one", () => {
    const page = clipOf(
      withTagline(pair(0, 1) + pair(2, 3)),
      `<meta name="description" content="A pictorial essay on women in art.">`,
    );
    expect(page.excerpt).toBe("A pictorial essay on women in art.");
  });
});

describe("what a picture essay must never replace", () => {
  test("an article Readability found, with its own pictures", () => {
    const words = "A sentence long enough to read as prose to Readability. ";
    const md = clip(
      `${header}<main><article><h1>Essay</h1>${prose(words.repeat(12))}<img src="images/a.jpg" alt="">${prose(words.repeat(12))}</article><div class="gallery">${pair(1, 2)}${pair(3, 4)}</div></main>`,
    );
    expect(md).toContain("A sentence long enough");
  });

  test("a choice that kept a picture, however little text it has", () => {
    // A photo with a one-line caption, and a strip of other pictures beside
    // it: what Readability chose has a picture, so it is not an empty choice.
    const md = clip(
      `<main><article><h1>Photo of the day</h1><p><img src="images/day.jpg" alt=""></p><p>A heron at dawn.</p></article><aside class="more">${pair(1, 2)}${pair(3, 4)}</aside></main>`,
    );
    expect(md).toContain("images/day.jpg");
    expect(md).not.toContain("images/ch2_1.jpg");
  });

  test("an article Readability failed to read, for the pictures in it", () => {
    // Under happy-dom, Developers Digest's <article> of 9,494 letters lost to
    // the site's nav menu. Its pictures are not the article; its text is.
    const words = "A sentence long enough to read as prose to Readability. ";
    const page = `<article>${prose(words.repeat(12))}${pair(1, 2)}${prose(words.repeat(12))}${pair(3, 4)}</article>`;
    const window = new Window({ url: PAGE });
    const essayHtml = pictureEssayIn(
      `<ul><li>Compare</li><li>Data</li></ul>`,
      page,
      window.document as unknown as Document,
      PAGE,
    );
    expect(essayHtml).toBeNull();
  });

  test("a short Chinese article, though it has no spaces to count words by", () => {
    // One "word" by whitespace, 120 letters: counting words would call this
    // empty and swap it for the gallery beside it.
    const md = clip(
      `<main><article>${prose("观看先于言语。".repeat(20))}</article><div class="gallery">${pair(1, 2)}${pair(3, 4)}</div></main>`,
    );
    expect(md).toContain("观看先于言语。");
  });

  test("a page with too few pictures to be an essay", () => {
    const md = clip(essay(pair(0, 1)));
    expect(imageOffsets(md)).toHaveLength(0);
  });

  test("pictures the page puts in no landmark", () => {
    const md = clip(
      `${header}<div class="photo-essay">${pair(0, 1)}${pair(2, 3)}</div>`,
    );
    expect(imageOffsets(md)).toHaveLength(0);
  });
});
