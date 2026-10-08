import { describe, expect, test } from "bun:test";
import {
  CAPTURE_SPACING_MS,
  type CaptureEffects,
  captureFigures,
  cropBox,
  looksBlank,
  outputSize,
  SNAPSHOT_MAX_WIDTH,
  SNAPSHOTS_MAX_TOTAL_BYTES,
  snapshotId,
} from "../src/figure-capture.ts";
import type { FrameResult, ScoutRect } from "../src/figure-scout.ts";

describe("cropBox", () => {
  const rect: ScoutRect = { x: 10, y: 20, width: 100, height: 50 };

  test("scales a figure's CSS rectangle into the image's pixels", () => {
    // A 1280-wide viewport at a device pixel ratio of 2.
    expect(cropBox(rect, 1280, { width: 2560, height: 1600 })).toEqual({
      sx: 20,
      sy: 40,
      sw: 200,
      sh: 100,
    });
  });

  test("reads the scale off the image, so a zoomed page crops the same", () => {
    // At 150% zoom the viewport is fewer CSS pixels wide over the same image:
    // devicePixelRatio alone would have cropped at 2, not 3.
    expect(cropBox(rect, 2560 / 3, { width: 2560, height: 1600 })).toEqual({
      sx: 30,
      sy: 60,
      sw: 300,
      sh: 150,
    });
  });

  test("stays inside the image, and refuses a rectangle that is not in it", () => {
    expect(
      cropBox({ x: 1200, y: 0, width: 200, height: 50 }, 1280, {
        width: 1280,
        height: 800,
      }),
    ).toEqual({ sx: 1200, sy: 0, sw: 80, sh: 50 });
    expect(
      cropBox({ x: 2000, y: 0, width: 100, height: 50 }, 1280, {
        width: 1280,
        height: 800,
      }),
    ).toBeNull();
    expect(cropBox(rect, 0, { width: 1280, height: 800 })).toBeNull();
  });
});

describe("outputSize", () => {
  test("keeps a crop its own size, up to the stored width", () => {
    expect(outputSize(1200, 700)).toEqual({ width: 1200, height: 700 });
  });

  test("scales a wider crop down, keeping its shape", () => {
    expect(outputSize(2560, 1472)).toEqual({
      width: SNAPSHOT_MAX_WIDTH,
      height: 920,
    });
  });
});

describe("snapshotId", () => {
  test("is the first twelve hex digits of the bytes' SHA-256", async () => {
    // SHA-256("abc") = ba7816bf8f01cfea…
    expect(await snapshotId(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01",
    );
  });
});

/** A tab, a clock and a capture API, all in memory. */
function fakeTab(
  options: {
    frame?: (index: number, call: number) => FrameResult;
    measure?: (index: number, call: number) => FrameResult;
    capture?: (call: number) => string | null;
    encode?: (index: number) => Uint8Array | null;
    begin?: boolean;
    /** How long framing a figure takes on the fake clock. */
    frameMs?: number;
  } = {},
) {
  const rect: ScoutRect = { x: 0, y: 100, width: 600, height: 400 };
  const ok = (): FrameResult => ({ ok: true, rect, innerWidth: 1280 });
  let clock = 1_000;
  let current = -1;
  let lastFramed: FrameResult = ok();
  const frames = new Map<number, number>();
  const measures = new Map<number, number>();
  const log = {
    captures: [] as number[],
    ended: 0,
  };
  let captureCalls = 0;
  const effects: CaptureEffects = {
    begin: async () => options.begin ?? true,
    frame: async (index) => {
      current = index;
      const call = (frames.get(index) ?? 0) + 1;
      frames.set(index, call);
      clock += options.frameMs ?? 1_500;
      lastFramed = options.frame?.(index, call) ?? ok();
      return lastFramed;
    },
    measure: async (index) => {
      const call = (measures.get(index) ?? 0) + 1;
      measures.set(index, call);
      // Unless told otherwise, the figure is where the frame found it.
      return options.measure?.(index, call) ?? lastFramed;
    },
    end: async () => {
      log.ended += 1;
    },
    captureTab: async () => {
      captureCalls += 1;
      log.captures.push(clock);
      return options.capture === undefined
        ? `data:image/png;base64,${current}`
        : options.capture(captureCalls);
    },
    encode: async (dataUrl) => {
      const index = Number(dataUrl.split(",")[1]);
      // Null is an answer here — "could not encode" — so not `??`.
      return options.encode === undefined
        ? new Uint8Array([index, 1, 2, 3])
        : options.encode(index);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { effects, log };
}

describe("captureFigures", () => {
  test("captures each figure, says which it is on, and puts the scroll back", async () => {
    const { effects, log } = fakeTab();
    const progress: string[] = [];
    const outcome = await captureFigures([2, 5, 9], effects, {
      onProgress: (at, total) => progress.push(`${at}/${total}`),
    });
    expect([...outcome.snapshots.keys()]).toEqual([2, 5, 9]);
    expect(outcome.skipped).toBe(0);
    expect(outcome.stopped).toBe(false);
    expect(progress).toEqual(["1/3", "2/3", "3/3"]);
    expect(log.ended).toBe(1);
    // Each snapshot is named by its own bytes.
    const lathe = outcome.snapshots.get(2);
    expect(lathe?.id).toBe(await snapshotId(new Uint8Array([2, 1, 2, 3])));
  });

  test("a figure that cannot be framed or encoded is skipped, and the rest go on", async () => {
    const { effects } = fakeTab({
      frame: (index) =>
        index === 5
          ? { ok: false, reason: "too-big" }
          : {
              ok: true,
              rect: { x: 0, y: 0, width: 10, height: 10 },
              innerWidth: 1280,
            },
      encode: (index) => (index === 9 ? null : new Uint8Array([index])),
    });
    const outcome = await captureFigures([2, 5, 9, 11], effects);
    expect([...outcome.snapshots.keys()]).toEqual([2, 11]);
    expect(outcome.skipped).toBe(2);
  });

  test("one figure's thrown error costs that figure alone", async () => {
    const { effects, log } = fakeTab({
      encode: (index) => {
        if (index === 5) throw new Error("decode failed");
        return new Uint8Array([index]);
      },
    });
    const outcome = await captureFigures([2, 5, 9], effects);
    expect([...outcome.snapshots.keys()]).toEqual([2, 9]);
    expect(outcome.skipped).toBe(1);
    expect(log.ended).toBe(1);
  });

  test("a page that reflowed under the picture is taken once more, then left", async () => {
    const moved = (call: number): FrameResult => ({
      ok: true,
      rect: { x: 0, y: call === 1 ? 300 : 100, width: 600, height: 400 },
      innerWidth: 1280,
    });
    // Moved on the first try, still on the second.
    const settles = fakeTab({ measure: (_index, call) => moved(call) });
    expect([
      ...(await captureFigures([4], settles.effects)).snapshots.keys(),
    ]).toEqual([4]);
    const never = fakeTab({ measure: () => moved(1) });
    const outcome = await captureFigures([4], never.effects);
    expect(outcome.snapshots.size).toBe(0);
    expect(outcome.skipped).toBe(1);
  });

  test("pictures are spaced past Chrome's capture rate", async () => {
    // Frames that take no time, so only the spacing keeps captures apart.
    const { effects: quick, log } = fakeTab({ frameMs: 0 });
    await captureFigures([1, 2, 3], quick);
    expect(log.captures).toHaveLength(3);
    const gaps = log.captures
      .slice(1)
      .map((at, i) => at - (log.captures[i] ?? 0));
    expect(gaps.every((gap) => gap >= CAPTURE_SPACING_MS)).toBe(true);
  });

  test("Stop keeps what is taken and skips the rest", async () => {
    let stop = false;
    const { effects, log } = fakeTab();
    const outcome = await captureFigures([1, 2, 3, 4], effects, {
      onProgress: (at) => {
        if (at === 3) stop = true;
      },
      stopped: () => stop,
    });
    expect([...outcome.snapshots.keys()]).toEqual([1, 2, 3]);
    expect(outcome.stopped).toBe(true);
    expect(outcome.skipped).toBe(1);
    expect(log.ended).toBe(1);
  });

  test("a tab that is no longer the one the popup opened on ends the capture", async () => {
    const { effects, log } = fakeTab({
      capture: (call) => (call === 2 ? null : "data:image/png;base64,1"),
    });
    const outcome = await captureFigures([1, 2, 3], effects);
    expect(outcome.snapshots.size).toBe(1);
    expect(outcome.stopped).toBe(true);
    expect(outcome.skipped).toBe(2);
    expect(log.ended).toBe(1);
  });

  test("once the byte budget is spent, the rest stay links", async () => {
    const half = Math.floor(SNAPSHOTS_MAX_TOTAL_BYTES / 2) + 1;
    const { effects } = fakeTab({
      encode: (index) => {
        const bytes = new Uint8Array(half);
        bytes[0] = index;
        return bytes;
      },
    });
    const outcome = await captureFigures([1, 2, 3], effects);
    expect([...outcome.snapshots.keys()]).toEqual([1]);
    expect(outcome.skipped).toBe(2);
  });

  test("a tab no clip has run in captures nothing", async () => {
    const { effects, log } = fakeTab({ begin: false });
    const outcome = await captureFigures([1, 2], effects);
    expect(outcome.snapshots.size).toBe(0);
    expect(outcome.skipped).toBe(2);
    expect(log.captures).toEqual([]);
  });
});

describe("looksBlank", () => {
  const flat = (n: number, rgba: number[]) =>
    Uint8ClampedArray.from({ length: n * 4 }, (_, i) => rgba[i % 4] ?? 0);

  test("a crop of one colour is blank — an unpainted canvas, an empty slot", () => {
    expect(looksBlank(flat(64 * 64, [238, 238, 238, 255]))).toBe(true);
    expect(looksBlank(new Uint8ClampedArray(0))).toBe(true);
  });

  test("compression noise does not make a picture", () => {
    const pixels = flat(64 * 64, [244, 244, 244, 255]);
    pixels[400] = 246;
    pixels[801] = 241;
    expect(looksBlank(pixels)).toBe(true);
  });

  test("a faint line across the figure does", () => {
    // A one-pixel dark line over 600 pixels, averaged into a 64-pixel sample.
    const pixels = flat(64 * 64, [244, 244, 244, 255]);
    for (let x = 0; x < 64; x++) pixels[(32 * 64 + x) * 4] = 230;
    expect(looksBlank(pixels)).toBe(false);
  });
});
