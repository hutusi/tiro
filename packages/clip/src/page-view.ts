import { followableUrl, pageHides } from "./dom-prepare.ts";

/**
 * The page as it stood before Readability consumed it, read again by a pass
 * that runs after Readability: the picture essay (ADR 0050) and the article's
 * lead (ADR 0052).
 *
 * Readability normalizes a page on the way in — it drops what the page hides,
 * puts a lazy picture's `<noscript>` copy in its place — and on the way out —
 * it resolves every relative address. A pass reading the prepared body instead
 * of Readability's article skips all of that, so it has to redo it, and doing
 * it in one place is what keeps two such passes from each rediscovering the
 * list one review at a time, which is how picture essays learned it.
 */

/**
 * The prepared body in a scratch document, normalized the way Readability
 * would have read it: `<noscript>` copies settled first, then everything the
 * page hides removed — in that order, because a lazy loader may hide its
 * placeholder until the picture loads, and the copy replacing it is not hidden.
 */
export function readPreparedBody(
  preparedBody: string,
  doc: Document,
): HTMLElement {
  const scratch = doc.implementation.createHTMLDocument("");
  scratch.body.innerHTML = preparedBody;
  settleNoscripts(scratch.body);
  dropHidden(scratch.body);
  return scratch.body;
}

/**
 * The address relative links on the page resolve against: the document's own,
 * when it has a real one, else the page's URL — the same base
 * `videosAsPostersIn` resolves against, for the same reasons.
 */
export function pageBase(doc: Document, pageUrl?: string): string {
  return /^https?:/i.test(doc.baseURI) ? doc.baseURI : (pageUrl ?? "");
}

/**
 * Point the links a figure keeps — round its picture, in its caption — at the
 * page they came from. Readability does this for the article it returns, and
 * nothing after it does it for an essay, so `/artists/0` would be published
 * as a link into Tiro. An in-page `#anchor` stays as it is, as Readability
 * leaves it, and so does anything that names its own scheme.
 */
export function resolveLinksIn(figure: Element, base: string): void {
  for (const link of Array.from(figure.querySelectorAll("a[href]"))) {
    const href = (link.getAttribute("href") ?? "").trim();
    if (href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const absolute = followableUrl(href, base);
    if (absolute !== null) link.setAttribute("href", absolute);
  }
}

/** An image declared smaller than this on either side is an icon. */
const ICON_PX = 48;

/**
 * A `<noscript>` copy of a lazy picture takes the lazy one's place, and every
 * other `<noscript>` goes — what Readability's `_unwrapNoscriptImages` and
 * `_removeScripts` do to a page before reading it, and why its articles never
 * show a picture twice. A scratch document parses with scripting off, so a
 * `<noscript>`'s markup is elements here: without this each lazy picture
 * counted twice, and two passed for the three an essay needs.
 *
 * The copy's image wins, as in Readability, because it had to work with no
 * script to load it. The lazy one's `alt` and `title` go with it when it has
 * none. Only the image is swapped, inside whatever the lazy one sat in: that
 * wrapper is what the reader saw, and it is usually a link to the full-size
 * picture, which the copy may not repeat. Readability puts the copy's whole
 * markup in the wrapper's place, which loses that link whenever it does not.
 * The exception is a wrapper the page hides until the picture loads: the copy
 * takes the place of the outermost one, so it is not dropped with it, and a
 * link round that stays.
 */
export function settleNoscripts(body: Element): void {
  for (const noscript of Array.from(body.querySelectorAll("noscript"))) {
    const copy = soleImage(noscript);
    const previous = noscript.previousElementSibling;
    const lazy = previous === null ? null : soleImage(previous);
    if (copy !== null && lazy !== null && isCopyOfAPicture(copy)) {
      for (const name of ["alt", "title"]) {
        const value = lazy.getAttribute(name) ?? "";
        if (value !== "" && (copy.getAttribute(name) ?? "") === "") {
          copy.setAttribute(name, value);
        }
      }
      let placeholder = lazy;
      for (let node: Element | null = lazy; node !== null; ) {
        if (pageHides(node)) placeholder = node;
        node = node === previous ? null : node.parentElement;
      }
      placeholder.replaceWith(copy);
    }
    noscript.remove();
  }
}

/** Whether a `<noscript>`'s image can be a picture's copy at all. A tracking
 * pixel is the commonest image in a `<noscript>` — `width="1" height="1"`,
 * often `display: none` as well — and one placed after a real picture would
 * take its place and then be dropped as an icon or as hidden, losing the
 * picture. Readability does not ask; before this pass existed the pixel was
 * an icon and the picture stood, so neither may this lose it. A beacon that
 * declares neither, placed straight after a picture, still takes its place,
 * as it would in Readability. */
function isCopyOfAPicture(copy: Element): boolean {
  return !iconSized(copy) && !pageHides(copy);
}

/** The image `element` is, or holds with nothing else around it: Readability's
 * `_isSingleImage`. */
function soleImage(element: Element): Element | null {
  for (let node: Element | undefined = element; node !== undefined; ) {
    if (node.tagName === "IMG") return node;
    if (node.children.length !== 1 || (node.textContent ?? "").trim() !== "") {
      return null;
    }
    node = node.children[0];
  }
  return null;
}

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
export function dropHidden(body: Element): void {
  for (const element of Array.from(body.querySelectorAll("*"))) {
    if (pageHides(element)) element.remove();
  }
}

export function lettersIn(text: string): number {
  return text.match(/\p{L}/gu)?.length ?? 0;
}

/** Point `image` at an absolute address, and say whether it is a picture.
 *
 * A lazy loader's `data-src` comes first. Below the fold its `src` is still a
 * placeholder — a `data:` pixel, or as often an ordinary address like
 * `/img/blank.gif` that nothing about it marks as a stand-in — and once the
 * picture loads, the loader copies `data-src` into `src`, so the two agree. A
 * long essay is mostly below the fold. */
export function resolvePicture(image: Element, base: string): boolean {
  if (iconSized(image)) return false;
  const src =
    followableUrl(image.getAttribute("data-src"), base) ??
    followableUrl(image.getAttribute("src"), base);
  if (src === null) return false;
  image.setAttribute("src", src);
  return true;
}

export function iconSized(image: Element): boolean {
  return (
    declaredPx(image, "width") < ICON_PX ||
    declaredPx(image, "height") < ICON_PX
  );
}

/** The size the markup declares, or Infinity when it declares none. */
function declaredPx(image: Element, side: "width" | "height"): number {
  const px = Number.parseInt(image.getAttribute(side) ?? "", 10);
  return Number.isNaN(px) ? Number.POSITIVE_INFINITY : px;
}
