import { describe, expect, test } from "bun:test";
import {
  beginCapture,
  type FigureScope,
  setSnapshotRequest,
} from "../src/figure-scout.ts";

/**
 * Run a scout function the way Chrome does: from its source, rebuilt into a
 * function with no module scope around it, against the page's globals. A
 * reference to anything outside its own body throws here.
 */
function inPage<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
  scope: FigureScope,
  window: object,
): (...args: Args) => Result {
  return (...args) =>
    new Function(
      "globalThis",
      "window",
      "args",
      `return (${fn.toString()})(...args);`,
    )(scope, window, args);
}

describe("setSnapshotRequest", () => {
  test("clears a request a closed popup left behind, and stores a new one", () => {
    const scope: FigureScope = {
      __tiroSnapshotRequest: { requestId: "old", figures: [[0, "abc"]] },
    };
    inPage(setSnapshotRequest, scope, {})(null);
    expect("__tiroSnapshotRequest" in scope).toBe(false);
    inPage(setSnapshotRequest, scope, {})({ requestId: "new", figures: [] });
    expect(scope.__tiroSnapshotRequest).toEqual({
      requestId: "new",
      figures: [],
    });
  });
});

describe("beginCapture", () => {
  function page(scrollY: number) {
    const timers: (() => void)[] = [];
    const scrolled: { top: number }[] = [];
    const window = {
      scrollX: 0,
      scrollY,
      setTimeout: (restore: () => void) => {
        timers.push(restore);
        return timers.length;
      },
      scrollTo: (to: { top: number }) => scrolled.push(to),
    };
    return { window, timers, scrolled };
  }

  test("keeps the scroll it finds, and its watchdog puts the reader back there", () => {
    const { window, timers, scrolled } = page(1000);
    const scope: FigureScope = { __tiroFigures: [] };
    expect(inPage(beginCapture, scope, window)(8000)).toBe(0);
    timers.at(-1)?.();
    expect(scrolled.at(-1)).toMatchObject({ top: 1000 });
  });

  test("while an abandoned capture is pending, keeps where the reader was before it", () => {
    // A popup closed mid-capture: it began at 1000 and left the page at a
    // figure at 4200, with its watchdog yet to fire.
    const { window, timers, scrolled } = page(4200);
    const scope: FigureScope = {
      __tiroFigures: [],
      __tiroCapture: { x: 0, y: 1000, timer: 0 },
    };
    inPage(beginCapture, scope, window)(8000);
    expect(scope.__tiroCapture).toMatchObject({ x: 0, y: 1000 });
    timers.at(-1)?.();
    expect(scrolled.at(-1)).toMatchObject({ top: 1000 });
  });

  test("with no clip run in the tab, there is nothing to capture", () => {
    expect(inPage(beginCapture, {}, page(0).window)(8000)).toBeNull();
  });
});
