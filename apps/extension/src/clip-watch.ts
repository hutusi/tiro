// A popup closed mid-clip takes the clip with it (ADR 0045 §5): the pictures
// live in the popup, and so does the commit. Nothing in the popup can say so
// — it is gone — so it tells the worker what the clip has reached, and the
// worker, on hearing the popup go before the clip was done, says so on the
// toolbar button of the tab it was for.
//
// Both halves are here, apart from `chrome`, so the protocol can be tested
// with fake ports. The worker imports this file: nothing in it may reach the
// DOM or the `@tiro/shared` root (invariant 6).
import {
  type ClipStage,
  type ClipWatchMessage,
  isClipWatchMessage,
} from "./messages.ts";

/** The parts of `chrome.runtime.Port` the watch uses. */
export interface WatchPort {
  postMessage(message: ClipWatchMessage): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

/** Well inside the 30 s an idle service worker is given before it is stopped
 * — a stopped worker drops the port, and with it the one listener that would
 * have heard the popup close. A message on a port is what keeps it awake. */
export const HEARTBEAT_MS = 10_000;

/** How long a popup must outlive its clip's failure for the failure to be
 * believed. A closing page runs no timers, so it never does. */
export const FAILURE_GRACE_MS = 1000;

/**
 * The popup's half: from the first `stage` until the clip has `saved` or
 * `failed`, a port that tells the worker what the clip has reached.
 * Best-effort throughout — a clip never waits on, or fails for, its own
 * watch. A port the worker dropped (it was stopped after all) is opened again
 * by the next message.
 */
export function reportClip(
  connect: () => WatchPort,
  tabId: number,
  {
    heartbeatMs = HEARTBEAT_MS,
    graceMs = FAILURE_GRACE_MS,
  }: { heartbeatMs?: number; graceMs?: number } = {},
): { stage(stage: ClipStage): void; saved(): void; failed(): void } {
  let current: ClipStage | null = null;
  let port: WatchPort | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const send = (): void => {
    if (current === null) return;
    try {
      if (port === null) {
        const opened = connect();
        opened.onDisconnect.addListener(() => {
          if (port === opened) port = null;
        });
        port = opened;
      }
      port.postMessage({ type: "tiro-clip-stage", tabId, stage: current });
    } catch {
      port = null;
    }
  };

  const done = (): void => {
    current = null;
    const closing = port;
    port = null;
    // Disconnecting straight after the post is safe: Chrome delivers a port's
    // messages before its disconnect. Measured from the real popup, 3000 times
    // in a row with the worker idle and with it blocked so both queued, and
    // never a false "!". An acknowledgement would add a round trip and still
    // leave a popup closed before it arrived to the same ordering.
    try {
      closing?.postMessage({ type: "tiro-clip-done" });
      closing?.disconnect();
    } catch {
      // The worker dropped it already; there is no one to tell.
    }
  };

  const settle = (): void => {
    clearInterval(heartbeat);
    heartbeat = undefined;
  };

  return {
    stage(stage) {
      current = stage;
      send();
      heartbeat ??= setInterval(send, heartbeatMs);
    },
    /** In the vault: nothing is lost, whatever happens to the popup next. */
    saved() {
      settle();
      done();
    },
    /**
     * The clip failed — or seemed to. Closing the popup aborts the commit's
     * requests, and the clip's failure path runs while the page unloads,
     * before its port closes (measured: between `beforeunload` and
     * `pagehide`). Told at once, the worker would hear a settled clip in the
     * very close it listens for. So it is told only once the popup has
     * outlived the failure, which a closing one never does.
     */
    failed() {
      settle();
      setTimeout(done, graceMs);
    },
  };
}

/**
 * The worker's half, for one port: the last stage it heard, and on the port
 * closing before `done`, `lost` with where the clip was. The popup closing is
 * the only thing that closes a port before `done`, since the worker is the
 * other end.
 */
export function watchClip(
  port: WatchPort,
  lost: (tabId: number, stage: ClipStage) => void,
): void {
  let under: { tabId: number; stage: ClipStage } | null = null;
  port.onMessage.addListener((message) => {
    if (!isClipWatchMessage(message)) return;
    under =
      message.type === "tiro-clip-done"
        ? null
        : { tabId: message.tabId, stage: message.stage };
  });
  port.onDisconnect.addListener(() => {
    if (under !== null) lost(under.tabId, under.stage);
  });
}
