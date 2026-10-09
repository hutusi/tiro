/**
 * The page's half of capturing interactive figures (ADR 0039).
 *
 * Every export here runs inside the tab through
 * `chrome.scripting.executeScript({ func })`, which serializes the function's
 * source and nothing around it — so each is self-contained, the way
 * `readTiroMarker` is: no imports, no helpers outside its own body. They run
 * in the extension's isolated world, the same one `clipper.js` runs in, and
 * share its globals; that is how the figures the clip found reach them.
 */

/** A rectangle in CSS pixels, relative to the viewport's top-left corner. */
export interface ScoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FrameResult =
  | {
      ok: true;
      rect: ScoutRect;
      /** `window.innerWidth`: the width `captureVisibleTab`'s image covers,
       * scrollbar included, which is what scales the rect into its pixels. */
      innerWidth: number;
    }
  | { ok: false; reason: "gone" | "empty" | "too-big" | "covered" };

/** What the clipper leaves in the isolated world, and the scout keeps there
 * between its calls. */
export interface FigureScope {
  /** The page's `<figure>`s as the last clip found them, in document order:
   * the list a payload's `scriptFigures` indexes. Set by `clipper.js`. */
  __tiroFigures?: Element[];
  /** Read and cleared by the next `clipper.js` run (`setSnapshotRequest`). */
  __tiroSnapshotRequest?: SnapshotRequest;
  __tiroCapture?: { x: number; y: number; timer: number };
  /** This document's id, made by the first clip of it. A navigation, even to
   * the same address, starts a new document and a new isolated world, so a
   * clip that reports another id came from another page. */
  __tiroDocument?: string;
}

/** The pictures a re-clip is to show: figure index (into the last clip's
 * `__tiroFigures`) to snapshot id. Echoed back by its `requestId`, so the popup
 * can tell this clip from any other. */
export interface SnapshotRequest {
  requestId: string;
  figures: [number, string][];
}

/**
 * Remember where the reader was, and promise to put them back there.
 *
 * The watchdog is that promise for the case nothing else can keep: the popup
 * closing mid-capture, which ends every call it would have made — including
 * `endCapture`. Each `frameFigure` re-arms it, so it fires only once the popup
 * has gone quiet. Answers how many figures the clip left to capture, or null
 * when no clip has run in this tab.
 */
export function beginCapture(watchdogMs: number): number | null {
  const scope = globalThis as unknown as FigureScope;
  const figures = scope.__tiroFigures;
  if (figures === undefined) return null;
  const previous = scope.__tiroCapture;
  if (previous !== undefined) clearTimeout(previous.timer);
  const x = window.scrollX;
  const y = window.scrollY;
  const restore = () => {
    window.scrollTo({ left: x, top: y, behavior: "instant" });
    delete scope.__tiroCapture;
  };
  scope.__tiroCapture = { x, y, timer: window.setTimeout(restore, watchdogMs) };
  return figures.length;
}

/**
 * Bring one figure into view, wait for its script to draw it, and say where
 * it is — or why it cannot be captured.
 *
 * Scrolled to the middle of the viewport with `behavior: "instant"`, so a page
 * that asks for smooth scrolling is not still moving when the picture is
 * taken. A figure mounts when it scrolls into view, so the wait is for
 * something laid out inside it — a canvas, an image, an svg — and then for the
 * settle, since the first frame a figure draws is often an intro still in
 * motion.
 *
 * Refused rather than taken badly: a figure taller or wider than the viewport
 * cannot be in one picture, and one with something else on top of it — a
 * sticky header, a cookie banner — would publish that instead. Its caption is
 * left out of the rectangle, since the article carries it as text, and so are
 * controls kept apart from the drawing.
 */
export async function frameFigure(
  index: number,
  options: {
    scroll: boolean;
    waitMs: number;
    settleMs: number;
    watchdogMs: number;
  },
): Promise<FrameResult> {
  const scope = globalThis as unknown as FigureScope;
  const state = scope.__tiroCapture;
  if (state !== undefined) {
    clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      window.scrollTo({ left: state.x, top: state.y, behavior: "instant" });
      delete scope.__tiroCapture;
    }, options.watchdogMs);
  }
  const figure = scope.__tiroFigures?.[index];
  if (figure === undefined || !figure.isConnected) {
    return { ok: false, reason: "gone" };
  }
  // A frame where the page can paint one, a timeout where it cannot — a tab
  // the browser has stopped painting must not hang the capture.
  const frame = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  const MEDIA = "canvas, img, svg, video, iframe";
  const isMedia = (element: Element) => element.matches(MEDIA);
  // The parts that hold the drawing, with whatever is laid over them — not a
  // row of controls beside it, which does nothing in a picture and can make a
  // figure too tall to fit the screen. A figure drawn some other way is taken
  // whole, less its caption.
  const parts = () => {
    const children = Array.from(figure.children).filter(
      (child) => child.tagName.toUpperCase() !== "FIGCAPTION",
    );
    const drawing = children.filter(
      (child) => isMedia(child) || child.querySelector(MEDIA) !== null,
    );
    return drawing.length > 0 ? drawing : children;
  };
  const drawn = () =>
    Array.from(figure.querySelectorAll(MEDIA)).some((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
  if (options.scroll) {
    figure.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "instant",
    });
    const until = Date.now() + options.waitMs;
    while (!drawn() && Date.now() < until) await frame();
    await sleep(options.settleMs);
    await frame();
    await frame();
  }
  // Nothing laid out to picture: a slot whose script never ran, or has not
  // yet. Its geometry alone would pass every check below and publish an empty
  // box as the figure; left uncaptured, it stays a described link.
  if (!drawn()) return { ok: false, reason: "empty" };
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const part of parts()) {
    const box = part.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.right);
    bottom = Math.max(bottom, box.bottom);
  }
  if (!(right - left >= 8 && bottom - top >= 8)) {
    return { ok: false, reason: "empty" };
  }
  // The viewport without its scrollbar: a figure under the scrollbar is not
  // all on screen.
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  if (left < -1 || top < -1 || right > width + 1 || bottom > height + 1) {
    return { ok: false, reason: "too-big" };
  }
  const inset = 6;
  const points: [number, number][] = [
    [(left + right) / 2, (top + bottom) / 2],
    [left + inset, top + inset],
    [right - inset, top + inset],
    [left + inset, bottom - inset],
    [right - inset, bottom - inset],
  ];
  for (const [x, y] of points) {
    const hit = document.elementFromPoint(x, y);
    if (hit !== null && hit !== figure && !figure.contains(hit)) {
      return { ok: false, reason: "covered" };
    }
  }
  return {
    ok: true,
    rect: { x: left, y: top, width: right - left, height: bottom - top },
    innerWidth: window.innerWidth,
  };
}

/** Put the reader back where they were, and stand the watchdog down. */
export function endCapture(): void {
  const scope = globalThis as unknown as FigureScope;
  const state = scope.__tiroCapture;
  if (state === undefined) return;
  clearTimeout(state.timer);
  window.scrollTo({ left: state.x, top: state.y, behavior: "instant" });
  delete scope.__tiroCapture;
}

/** Leave the next clip the pictures to show; `clipper.js` reads and clears it. */
export function setSnapshotRequest(request: SnapshotRequest): void {
  (globalThis as unknown as FigureScope).__tiroSnapshotRequest = request;
}
