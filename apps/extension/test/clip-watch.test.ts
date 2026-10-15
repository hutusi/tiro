import { describe, expect, test } from "bun:test";
import { reportClip, type WatchPort, watchClip } from "../src/clip-watch.ts";
import type { ClipStage, ClipWatchMessage } from "../src/messages.ts";

/** Two ends of one port, as Chrome joins them: a message posted at one end
 * reaches the other's listeners, and a disconnect at one end fires only the
 * other's `onDisconnect`. */
function portPair(): { popup: WatchPort; worker: WatchPort } {
  const state = () => ({
    message: [] as ((message: unknown) => void)[],
    gone: [] as (() => void)[],
    open: true,
  });
  const end = (
    self: ReturnType<typeof state>,
    other: ReturnType<typeof state>,
  ): WatchPort => ({
    postMessage(message: ClipWatchMessage) {
      if (!self.open) throw new Error("disconnected port");
      for (const listener of other.message) listener(message);
    },
    disconnect() {
      if (!self.open) return;
      self.open = false;
      other.open = false;
      for (const listener of other.gone) listener();
    },
    onMessage: { addListener: (l) => self.message.push(l) },
    onDisconnect: { addListener: (l) => self.gone.push(l) },
  });
  const popup = state();
  const worker = state();
  return { popup: end(popup, worker), worker: end(worker, popup) };
}

/** A worker that watches every port the popup opens, and what it lost. The
 * popup closing is its end of a port disconnecting; the worker being stopped
 * is the worker's end going. */
function worker() {
  const lost: [number, ClipStage][] = [];
  const ports: { popup: WatchPort; worker: WatchPort }[] = [];
  const connect = (): WatchPort => {
    const pair = portPair();
    ports.push(pair);
    watchClip(pair.worker, (tabId, stage) => lost.push([tabId, stage]));
    return pair.popup;
  };
  /** The `at`th port the popup opened — failing the test if it never did. */
  const port = (at: number) => {
    const pair = ports[at];
    if (pair === undefined) throw new Error(`no port ${at}`);
    return pair;
  };
  return { lost, ports, connect, port };
}

describe("watching a clip (ADR 0045)", () => {
  test("a popup closed while taking pictures costs the clip, and says so", () => {
    const w = worker();
    reportClip(w.connect, 7).stage("capturing");
    w.port(0).popup.disconnect();
    expect(w.lost).toEqual([[7, "capturing"]]);
  });

  test("closing while committing says the clip may not have been saved", () => {
    const w = worker();
    const watch = reportClip(w.connect, 7);
    watch.stage("capturing");
    watch.stage("committing");
    w.port(0).popup.disconnect();
    expect(w.lost).toEqual([[7, "committing"]]);
    // One port for the whole clip, not one per stage.
    expect(w.ports).toHaveLength(1);
  });

  // Closing the popup aborts the commit's requests, and the clip's failure
  // path runs while the page unloads — before the port closes.
  test("a failure its popup did not outlive still costs the clip", () => {
    const w = worker();
    const watch = reportClip(w.connect, 7);
    watch.stage("committing");
    watch.failed();
    w.port(0).popup.disconnect();
    expect(w.lost).toEqual([[7, "committing"]]);
  });

  test("a failure the popup outlived costs nothing more", async () => {
    const w = worker();
    const watch = reportClip(w.connect, 7, { graceMs: 5 });
    watch.stage("committing");
    watch.failed();
    await Bun.sleep(20);
    w.port(0).popup.disconnect();
    expect(w.lost).toEqual([]);
  });

  test("a clip that finished costs nothing when its popup closes", () => {
    const w = worker();
    const watch = reportClip(w.connect, 7);
    watch.stage("committing");
    watch.saved();
    w.port(0).popup.disconnect();
    expect(w.lost).toEqual([]);
  });

  test("a port with nothing under way costs nothing", () => {
    const { popup, worker } = portPair();
    const lost: unknown[] = [];
    watchClip(worker, (...args) => lost.push(args));
    popup.disconnect();
    expect(lost).toEqual([]);
  });

  test("anything but the protocol is ignored", () => {
    const { popup, worker } = portPair();
    const lost: unknown[] = [];
    watchClip(worker, (...args) => lost.push(args));
    for (const message of [
      { type: "tiro-clip-stage", tabId: "7", stage: "capturing" },
      { type: "tiro-clip-stage", tabId: 7, stage: "reading" },
      { type: "tiro-collection-flush" },
    ]) {
      popup.postMessage(message as unknown as ClipWatchMessage);
    }
    popup.disconnect();
    expect(lost).toEqual([]);
  });

  test("a port the worker dropped is opened again, so the close is still heard", async () => {
    const w = worker();
    const watch = reportClip(w.connect, 7, { heartbeatMs: 5 });
    watch.stage("capturing");
    // The worker was stopped after all: its end goes, and its state with it.
    w.port(0).worker.disconnect();
    await Bun.sleep(20);
    // The heartbeat opened a new port and told it where the clip is.
    expect(w.ports).toHaveLength(2);
    w.port(1).popup.disconnect();
    expect(w.lost).toEqual([[7, "capturing"]]);
    watch.saved();
  });

  test("the heartbeat repeats the stage until the clip saves, then stops", async () => {
    const heard: unknown[] = [];
    const { popup, worker } = portPair();
    worker.onMessage.addListener((message) => heard.push(message));
    const watch = reportClip(() => popup, 7, { heartbeatMs: 5 });
    watch.stage("capturing");
    await Bun.sleep(30);
    const beats = heard.length;
    expect(beats).toBeGreaterThan(2);
    watch.saved();
    expect(heard.at(-1)).toEqual({ type: "tiro-clip-done" });
    await Bun.sleep(20);
    expect(heard).toHaveLength(beats + 1);
  });

  test("a watch never throws into the clip", () => {
    const watch = reportClip(() => {
      throw new Error("no worker");
    }, 7);
    expect(() => watch.stage("capturing")).not.toThrow();
    expect(() => watch.saved()).not.toThrow();
    expect(() => watch.failed()).not.toThrow();
  });
});
