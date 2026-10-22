import { followableUrl, pageHides } from "./dom-prepare.ts";

/**
 * The pictures of a page that is nothing but pictures — a photo essay, a
 * gallery with no prose — in place of what Readability made of it.
 *
 * Readability finds an article by its text, and a picture essay has none.
 * Ways of Seeing's wordless chapters are a `<main>` of photographs whose only
 * words are the chapter number and "Next Chapter"; with nothing there to
 * score, Readability settled on the next most text-like thing on the page,
 * the site header, and each clip kept "Ways of Seeing / John Berger" and none
 * of the 10, 36 and 34 pictures the chapters are.
 *
 * So when what Readability chose holds no picture and almost no text, the
 * page's main landmark is asked instead, and if it holds pictures they are the
 * article: each image in the page's order, a `<figure>` whole so its caption
 * comes with it. Every other word in the landmark is left behind — a chapter
 * number, a next link — which is the furniture Readability strips from a text
 * article too. An image's `alt` and `title` stay on it, so a gallery that
 * names each picture keeps the names.
 *
 * Narrow on purpose, both ways. Readability's choice stands whenever it kept a
 * picture or real text, because overruling it wrongly replaces an article
 * with its illustrations. The landmark must be one the page names — `<main>`,
 * `role="main"`, `<article>` — because the whole body would bring the logo and
 * every icon with it; an essay laid out without one is still lost, as before.
 * And the landmark must be as wordless as Readability's choice, captions
 * apart: one with prose in it is an article Readability failed to read, not
 * an essay. That is not hypothetical — under happy-dom, Developers Digest's
 * `<article>` of 9,494 letters lost to its own nav menu, and taking its
 * pictures would have thrown the 9,494 letters away. Text is counted in
 * letters rather than words throughout, since Chinese prose has no spaces to
 * count by.
 *
 * Reads the prepared body as it stood before Readability consumed it, and
 * returns article HTML for the passes after Readability, or `null` to keep
 * Readability's.
 */
export function pictureEssayIn(
  chosen: string,
  preparedBody: string,
  doc: Document,
  pageUrl?: string,
): string | null {
  const scratch = doc.implementation.createHTMLDocument("");
  scratch.body.innerHTML = chosen;
  if (scratch.body.querySelector("img") !== null) return null;
  if (lettersIn(scratch.body.textContent ?? "") >= MAX_LETTERS) return null;

  scratch.body.innerHTML = preparedBody;
  dropHidden(scratch.body);
  // The base `videosAsPostersIn` resolves against, for the same reasons.
  const base = /^https?:/i.test(doc.baseURI) ? doc.baseURI : (pageUrl ?? "");
  let best: Picture[] = [];
  for (const landmark of Array.from(
    scratch.body.querySelectorAll('main, [role="main"], article'),
  )) {
    if (uncaptionedLetters(landmark) >= MAX_LETTERS) continue;
    const pictures = picturesIn(landmark, base);
    // On a tie the later landmark wins: nested in the earlier one, it is the
    // tighter frame around the same pictures.
    if (imagesIn(pictures) >= imagesIn(best)) best = pictures;
  }
  if (imagesIn(best) < MIN_PICTURES) return null;
  return best
    .map(({ element }) => {
      if (element.tagName !== "FIGURE") return `<p>${element.outerHTML}</p>`;
      resolveLinksIn(element, base);
      return element.outerHTML;
    })
    .join("");
}

/**
 * Point the links a figure keeps — round its picture, in its caption — at the
 * page they came from. Readability does this for the article it returns, and
 * nothing after it does it for an essay, so `/artists/0` would be published
 * as a link into Tiro. An in-page `#anchor` stays as it is, as Readability
 * leaves it, and so does anything that names its own scheme.
 */
function resolveLinksIn(figure: Element, base: string): void {
  for (const link of Array.from(figure.querySelectorAll("a[href]"))) {
    const href = (link.getAttribute("href") ?? "").trim();
    if (href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const absolute = followableUrl(href, base);
    if (absolute !== null) link.setAttribute("href", absolute);
  }
}

/** What the article is made of: an image, or a figure and how many of its
 * images are pictures — counted, because a figure of three photographs is
 * three pictures, not one. */
interface Picture {
  element: Element;
  images: number;
}

function imagesIn(pictures: Picture[]): number {
  return pictures.reduce((sum, picture) => sum + picture.images, 0);
}

/** Fewer letters than this is a site header or a stray label, not an article:
 * the header Readability chose on Ways of Seeing has 22, and the essay's own
 * words — "2", "Next Chapter" — 11. */
const MAX_LETTERS = 100;

/** Fewer pictures than this is not an essay: a page with nothing to read and
 * one or two images is an error page or a shell as often as it is content. */
const MIN_PICTURES = 3;

/** An image declared smaller than this on either side is an icon. */
const ICON_PX = 48;

/**
 * Remove what the page hides, by the test the clipper's other passes ask
 * (`pageHides`). Readability never reads a hidden subtree, but this reads the
 * page as it stood before Readability, and a picture the page did not show —
 * a `<main hidden>`, a lightbox's `display: none` copies, a carousel's
 * `aria-hidden` clones — must not be published on the essay's behalf, which
 * is the ADR 0011 failure again.
 *
 * Strict where the page is ambiguous, as `pageHides` is: `hidden md:block`
 * counts as hidden. Dropping a picture wrongly loses one the clip was losing
 * anyway; keeping one wrongly publishes what the page hid.
 */
function dropHidden(body: Element): void {
  for (const element of Array.from(body.querySelectorAll("*"))) {
    if (pageHides(element)) element.remove();
  }
}

function lettersIn(text: string): number {
  return text.match(/\p{L}/gu)?.length ?? 0;
}

/** The landmark's letters outside its captions: a captioned essay is still an
 * essay, however much its captions say. */
function uncaptionedLetters(landmark: Element): number {
  let letters = lettersIn(landmark.textContent ?? "");
  for (const caption of Array.from(landmark.querySelectorAll("figcaption"))) {
    letters -= lettersIn(caption.textContent ?? "");
  }
  return letters;
}

/**
 * The landmark's pictures in the page's order, addresses resolved: each
 * `<figure>` holding one, whole, and each image outside a figure. An image
 * with no address a reader can follow, or declared icon-sized, is not one —
 * nor does it ride along inside a figure that has a picture: a zoom icon or a
 * placeholder nobody resolved is removed, and the caption stays.
 *
 * Removes from the landmark as it goes. The rejection is the same whichever
 * landmark asks, so a landmark nested in this one finds the same pictures.
 */
function picturesIn(landmark: Element, base: string): Picture[] {
  const pictures: Picture[] = [];
  for (const element of Array.from(landmark.querySelectorAll("figure, img"))) {
    if (pictures.some((kept) => kept.element.contains(element))) continue;
    if (element.tagName === "IMG") {
      if (resolvePicture(element, base)) pictures.push({ element, images: 1 });
      continue;
    }
    let images = 0;
    for (const image of Array.from(element.querySelectorAll("img"))) {
      if (resolvePicture(image, base)) images++;
      else image.remove();
    }
    if (images > 0) pictures.push({ element, images });
  }
  return pictures;
}

/** Point `image` at an absolute address, and say whether it is a picture.
 *
 * A lazy loader's `data-src` comes first. Below the fold its `src` is still a
 * placeholder — a `data:` pixel, or as often an ordinary address like
 * `/img/blank.gif` that nothing about it marks as a stand-in — and once the
 * picture loads, the loader copies `data-src` into `src`, so the two agree. A
 * long essay is mostly below the fold. */
function resolvePicture(image: Element, base: string): boolean {
  if (declaredPx(image, "width") < ICON_PX) return false;
  if (declaredPx(image, "height") < ICON_PX) return false;
  const src =
    followableUrl(image.getAttribute("data-src"), base) ??
    followableUrl(image.getAttribute("src"), base);
  if (src === null) return false;
  image.setAttribute("src", src);
  return true;
}

/** The size the markup declares, or Infinity when it declares none. */
function declaredPx(image: Element, side: "width" | "height"): number {
  const px = Number.parseInt(image.getAttribute(side) ?? "", 10);
  return Number.isNaN(px) ? Number.POSITIVE_INFINITY : px;
}
