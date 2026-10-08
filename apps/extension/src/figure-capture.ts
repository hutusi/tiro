/**
 * The popup's half of capturing interactive figures (ADR 0039): frame each
 * figure in the tab, take the visible tab, crop it to the figure, and encode
 * the crop as the snapshot the article will show.
 *
 * Popup-only. `captureVisibleTab` rides the activeTab grant the toolbar click
 * gave, and the crop needs `createImageBitmap` and `OffscreenCanvas`; nothing
 * here may reach the service worker. The loop takes its effects as arguments,
 * so the rules it keeps — one figure's failure is that figure's alone, the
 * scroll always goes back, the capture rate and the byte budget hold — are
 * tested without a browser.
 */
import type { FrameResult, ScoutRect } from "./figure-scout.ts";

/** Widest a snapshot is stored. A figure is read in a column, and twice the
 * column's width is sharp on any screen the site is read on. */
export const SNAPSHOT_MAX_WIDTH = 1600;
/** Largest one snapshot may be. A figure that cannot be encoded under it at
 * the lower quality is left as its link. */
export const SNAPSHOT_MAX_BYTES = 1.5 * 1024 * 1024;
/** Largest all of a clip's snapshots may be together — the size of the
 * commit, and of the article's share of the site's deploy. */
export const SNAPSHOTS_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** Chrome allows two `captureVisibleTab` calls a second; spaced past that, a
 * capture is never the one refused. */
export const CAPTURE_SPACING_MS = 550;

/** How long the scout waits for a figure to draw, and then to settle. The
 * settle is measured: an intro animation on the article that prompted this was
 * still moving 1.5 s after its figure mounted, and most had stopped by 1 s. */
export const FRAME_OPTIONS = {
  scroll: true,
  waitMs: 3000,
  settleMs: 1200,
  watchdogMs: 8000,
} as const;

/** Where in the visible tab's image a figure is, in image pixels — or null
 * when the figure's rectangle does not fit inside it. */
export function cropBox(
  rect: ScoutRect,
  innerWidth: number,
  image: { width: number; height: number },
): { sx: number; sy: number; sw: number; sh: number } | null {
  if (innerWidth <= 0) return null;
  // The image covers the viewport, so its width over the viewport's is the
  // scale. Read off the image rather than trusted from devicePixelRatio, so a
  // zoomed page — whose ratio also folds in the zoom — scales the same way.
  const scale = image.width / innerWidth;
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.min(image.width - sx, Math.round(rect.width * scale));
  const sh = Math.min(image.height - sy, Math.round(rect.height * scale));
  return sw > 0 && sh > 0 ? { sx, sy, sw, sh } : null;
}

/** A crop's stored size: its own, or scaled down to `SNAPSHOT_MAX_WIDTH`. */
export function outputSize(
  sw: number,
  sh: number,
): { width: number; height: number } {
  if (sw <= SNAPSHOT_MAX_WIDTH) return { width: sw, height: sh };
  return {
    width: SNAPSHOT_MAX_WIDTH,
    height: Math.max(1, Math.round((sh * SNAPSHOT_MAX_WIDTH) / sw)),
  };
}

/** How far a pixel may stray from the first and the crop still read as one
 * flat colour: the noise of the resize, no more. The capture is a lossless
 * PNG, so a drawn line differs by far more than this. */
const BLANK_TOLERANCE = 3;

/**
 * True when RGBA pixels are, to the eye, one colour: a picture with nothing
 * in it, which would publish an empty box and report the figure captured.
 */
export function looksBlank(pixels: Uint8ClampedArray): boolean {
  const [r, g, b, a] = [pixels[0], pixels[1], pixels[2], pixels[3]];
  if (
    r === undefined ||
    g === undefined ||
    b === undefined ||
    a === undefined
  ) {
    return true;
  }
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (
      Math.abs((pixels[i] ?? 0) - r) > BLANK_TOLERANCE ||
      Math.abs((pixels[i + 1] ?? 0) - g) > BLANK_TOLERANCE ||
      Math.abs((pixels[i + 2] ?? 0) - b) > BLANK_TOLERANCE ||
      Math.abs((pixels[i + 3] ?? 0) - a) > BLANK_TOLERANCE
    ) {
      return false;
    }
  }
  return true;
}

/** A snapshot's id: the first 12 hex digits of its bytes' SHA-256. */
export async function snapshotId(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest).slice(0, 6), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Crop the visible tab's image to a figure and encode it as WebP — at a lower
 * quality if the first try is too large, and not at all if that is too.
 */
export async function cropAndEncode(
  dataUrl: string,
  framed: { rect: ScoutRect; innerWidth: number },
): Promise<Uint8Array | null> {
  const source = await (await fetch(dataUrl)).blob();
  const whole = await createImageBitmap(source);
  const box = cropBox(framed.rect, framed.innerWidth, whole);
  whole.close();
  if (box === null) return null;
  const size = outputSize(box.sw, box.sh);
  const bitmap = await createImageBitmap(
    source,
    box.sx,
    box.sy,
    box.sw,
    box.sh,
    {
      resizeWidth: size.width,
      resizeHeight: size.height,
      resizeQuality: "high",
    },
  );
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  // A canvas that has mounted but not painted is laid out, so the scout takes
  // it — and the picture is its background. Judged at full size: a downscale
  // samples rather than averages, and stepped over a one-pixel line, so a plot
  // of thin lines was refused as blank. The scan stops at the first pixel that
  // differs, so a real figure costs a few rows; only a blank one is read whole.
  if (looksBlank(context.getImageData(0, 0, size.width, size.height).data)) {
    return null;
  }
  for (const quality of [0.85, 0.7]) {
    const blob = await canvas.convertToBlob({ type: "image/webp", quality });
    // A browser that cannot encode WebP answers with PNG instead, which the
    // `.webp` name would then misdescribe.
    if (blob.type !== "image/webp") return null;
    if (blob.size <= SNAPSHOT_MAX_BYTES) {
      return new Uint8Array(await blob.arrayBuffer());
    }
  }
  return null;
}

/** Where a body was read from: the page's address, and the document's id. */
export interface BodyOrigin {
  url: string;
  documentId: string | undefined;
}

/**
 * Whether a capture's clip may take the place of the body on screen.
 *
 * Only if it was read from the same document at the same address. The page
 * can move while the capture runs — a link, a redirect, an infinite scroll
 * that swaps the address as it loads the next story — and the clip would then
 * be of another article, saved under the reader's Clip as if it were this one.
 * The document id catches a navigation, even to the same address; the address
 * catches a page that rewrote it without one. No id means no proof, and no.
 */
export function isSameBody(onScreen: BodyOrigin, arrived: BodyOrigin): boolean {
  return (
    onScreen.documentId !== undefined &&
    onScreen.documentId === arrived.documentId &&
    onScreen.url === arrived.url
  );
}

/**
 * How many captured figures the re-clipped article shows by their picture —
 * the count the reader is told.
 *
 * Counted by figure, not by file: two figures whose pictures came out
 * identical share one file, and counting files said "1 of 2 captured; the
 * rest stay as links" when both were in. A figure the re-clip could not find
 * again (its page re-rendered it) has its picture shown by nothing, and is
 * not counted.
 */
export function figuresShown(
  taken: Iterable<{ id: string }>,
  shown: readonly string[] | undefined,
): number {
  const files = new Set(shown ?? []);
  let count = 0;
  for (const { id } of taken) if (files.has(id)) count += 1;
  return count;
}

/** What the capture loop needs from the world. */
export interface CaptureEffects {
  /** Save the scroll and arm the watchdog; false when no clip has run. */
  begin(): Promise<boolean>;
  frame(index: number): Promise<FrameResult>;
  /** The figure's rectangle again, without scrolling, after the picture. */
  measure(index: number): Promise<FrameResult>;
  end(): Promise<void>;
  /** The visible tab, as a data URL — or null when the tab is no longer the
   * one the popup opened on, so a picture would be of something else. */
  captureTab(): Promise<string | null>;
  encode(
    dataUrl: string,
    framed: { rect: ScoutRect; innerWidth: number },
  ): Promise<Uint8Array | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface CaptureOutcome {
  /** Figure index to its snapshot. */
  snapshots: Map<number, { id: string; bytes: Uint8Array }>;
  /** Figures tried and not captured, for the note after. */
  skipped: number;
  /** The reader stopped it, or the tab changed under it. */
  stopped: boolean;
}

/** A rectangle moved by more than this between the picture and the check
 * after it — the page reflowed while it was taken. */
const SHIFT_TOLERANCE_PX = 2;

function moved(a: ScoutRect, b: ScoutRect): boolean {
  return (
    Math.abs(a.x - b.x) > SHIFT_TOLERANCE_PX ||
    Math.abs(a.y - b.y) > SHIFT_TOLERANCE_PX ||
    Math.abs(a.width - b.width) > SHIFT_TOLERANCE_PX ||
    Math.abs(a.height - b.height) > SHIFT_TOLERANCE_PX
  );
}

/**
 * Capture each figure in turn. A figure that cannot be framed, pictured or
 * encoded is skipped and stays a link; the scroll goes back whatever happens.
 */
export async function captureFigures(
  figures: readonly number[],
  effects: CaptureEffects,
  options: {
    onProgress?: (at: number, total: number) => void;
    stopped?: () => boolean;
  } = {},
): Promise<CaptureOutcome> {
  const outcome: CaptureOutcome = {
    snapshots: new Map(),
    skipped: 0,
    stopped: false,
  };
  if (!(await effects.begin())) {
    outcome.skipped = figures.length;
    return outcome;
  }
  let lastCapture = Number.NEGATIVE_INFINITY;
  let total = 0;
  try {
    for (const [position, index] of figures.entries()) {
      if (options.stopped?.() === true) {
        outcome.stopped = true;
        outcome.skipped += figures.length - position;
        break;
      }
      options.onProgress?.(position + 1, figures.length);
      let taken: { id: string; bytes: Uint8Array } | null = null;
      try {
        // One retry, for a page that reflowed while the picture was taken.
        for (let attempt = 0; attempt < 2 && taken === null; attempt++) {
          const framed = await effects.frame(index);
          if (!framed.ok) break;
          const wait = lastCapture + CAPTURE_SPACING_MS - effects.now();
          if (wait > 0) await effects.sleep(wait);
          const dataUrl = await effects.captureTab();
          lastCapture = effects.now();
          if (dataUrl === null) {
            outcome.stopped = true;
            break;
          }
          const after = await effects.measure(index);
          if (!after.ok || moved(framed.rect, after.rect)) continue;
          const bytes = await effects.encode(dataUrl, framed);
          if (bytes === null) break;
          taken = { id: await snapshotId(bytes), bytes };
        }
      } catch (error) {
        // An image the browser could not decode or encode costs this figure
        // its picture, not the capture its other figures.
        console.error("capturing a figure failed:", error);
        taken = null;
      }
      if (outcome.stopped) {
        outcome.skipped += figures.length - position;
        break;
      }
      if (taken === null) {
        outcome.skipped += 1;
        continue;
      }
      if (total + taken.bytes.length > SNAPSHOTS_MAX_TOTAL_BYTES) {
        // The budget is spent; the rest stay links.
        outcome.skipped += figures.length - position;
        break;
      }
      total += taken.bytes.length;
      outcome.snapshots.set(index, taken);
    }
  } finally {
    await effects.end();
  }
  return outcome;
}
