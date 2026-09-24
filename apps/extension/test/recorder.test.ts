import { describe, expect, test } from "bun:test";
import { enqueue, pendingOps, type QueuedOp } from "../src/collection-queue.ts";
import type { CollectionMessage } from "../src/messages.ts";
import {
  createToggleChannel,
  type ToggleEntry,
} from "../src/popup/recorder.ts";
import { serializer } from "../src/serializer.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("serializer", () => {
  test("runs work in the order it was asked for, however long each takes", async () => {
    const inOrder = serializer();
    const seen: string[] = [];
    await Promise.all([
      inOrder(async () => {
        await sleep(20);
        seen.push("slow first");
      }),
      inOrder(async () => {
        seen.push("fast second");
      }),
    ]);
    expect(seen).toEqual(["slow first", "fast second"]);
  });

  test("a failure neither blocks nor reorders what follows", async () => {
    const inOrder = serializer();
    const failed = inOrder(async () => {
      throw new Error("boom");
    });
    const next = inOrder(async () => "ran");
    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("ran");
  });
});

describe("createToggleChannel", () => {
  let n = 0;
  function entry(
    action: "add" | "remove",
    collection = "favorites",
  ): ToggleEntry {
    n += 1;
    return {
      op: { id: `op${n}`, collection, slug: "a", action, at: "t" },
      published: false,
      member: [],
    };
  }

  /** A worker that records the way the real one does — `enqueue`, in arrival
   * order. `failAdds` of its add attempts fail, each after `failMs`. */
  function fakeWorker(
    opts: { failAdds?: number; failMs?: number; slowMs?: number } = {},
  ) {
    let queue: QueuedOp[] = [];
    let failures = opts.failAdds ?? 0;
    const arrivals: string[] = [];
    const send = async (message: CollectionMessage) => {
      if (message.type !== "tiro-collection-toggle") return { ok: true };
      const label = `${message.op.action} ${message.op.collection}`;
      if (message.op.action === "add" && failures > 0) {
        failures -= 1;
        await sleep(opts.failMs ?? 0);
        arrivals.push(`${label} (failed)`);
        return null;
      }
      await sleep(opts.slowMs ?? 0);
      arrivals.push(label);
      queue = enqueue(queue, message.op, message.published);
      return { ok: true };
    };
    return {
      send,
      arrivals,
      pending: () =>
        pendingOps(queue).map((op) => `${op.action} ${op.collection}`),
      stopFailing: () => {
        failures = 0;
      },
    };
  }

  // Round 1: a retried add sent on its own could land after the reader's later
  // remove and become the final state.
  test("a retried add cannot overtake the reader's later remove", async () => {
    const worker = fakeWorker({ failAdds: 1, failMs: 20 });
    const channel = createToggleChannel(worker.send);
    const add = channel.toggle(entry("add"));
    await sleep(5); // the reader unticks while the add's first attempt is out
    await Promise.all([add, channel.toggle(entry("remove"))]);
    // The remove arrived during the add's first attempt, so the add is not
    // retried at all: the newer click decides the pair.
    expect(worker.arrivals).toEqual([
      "add favorites (failed)",
      "remove favorites",
    ]);
    expect(worker.pending()).toEqual([]);
    expect(channel.unrecorded()).toEqual([]);
  });

  // Round 2, Codex's sequence: the add has failed twice and is held; the
  // reader unticks and presses Save now while the remove is still in flight.
  // Save now must not re-send the add behind it.
  test("Save now does not re-send an add the reader has since unticked", async () => {
    const worker = fakeWorker({ failAdds: 2, slowMs: 20 });
    const channel = createToggleChannel(worker.send);
    expect(await channel.toggle(entry("add"))).toBe(false);
    expect(channel.unrecorded()).toHaveLength(1);

    const remove = channel.toggle(entry("remove"));
    const saved = channel.retry();
    expect(await Promise.all([remove, saved])).toEqual([true, true]);

    expect(worker.arrivals).toEqual([
      "add favorites (failed)",
      "add favorites (failed)",
      "remove favorites",
    ]);
    expect(worker.pending()).toEqual([]);
    expect(channel.unrecorded()).toEqual([]);
  });

  // Held toggles are laid back over the queue the popup draws. One the reader
  // has since unticked must go at the click, or the box flips back to ticked.
  test("an untick releases the held add at once, without Save now", async () => {
    const worker = fakeWorker({ failAdds: 2 });
    const channel = createToggleChannel(worker.send);
    await channel.toggle(entry("add"));
    const remove = channel.toggle(entry("remove"));
    expect(channel.unrecorded()).toEqual([]);
    await remove;
    expect(channel.unrecorded()).toEqual([]);
  });

  // Save now must not report success while a toggle it has not waited for is
  // still in the line and about to fail.
  test("Save now waits for toggles already in flight", async () => {
    const worker = fakeWorker({ failAdds: 10, failMs: 20 });
    const channel = createToggleChannel(worker.send);
    const reading = channel.toggle(entry("add", "reading"));
    const saved = channel.retry();
    expect(await saved).toBe(false);
    await reading;
    expect(channel.unrecorded()).toHaveLength(1);
  });

  // The sibling: an older toggle whose failure comes back after a newer click
  // for the same pair must not be held.
  test("a failure that returns after a newer click is not held", async () => {
    const worker = fakeWorker({ failAdds: 2, failMs: 20 });
    const channel = createToggleChannel(worker.send);
    const add = channel.toggle(entry("add"));
    await sleep(5);
    const remove = channel.toggle(entry("remove"));
    await Promise.all([add, remove]);
    expect(channel.unrecorded()).toEqual([]);
    expect(worker.pending()).toEqual([]);
  });

  test("a toggle superseded before its turn is never sent", async () => {
    const worker = fakeWorker({ slowMs: 20 });
    const channel = createToggleChannel(worker.send);
    const other = channel.toggle(entry("add", "reading"));
    const add = channel.toggle(entry("add"));
    const remove = channel.toggle(entry("remove"));
    await Promise.all([other, add, remove]);
    expect(worker.arrivals).toEqual(["add reading", "remove favorites"]);
    expect(worker.pending()).toEqual(["add reading"]);
  });

  test("Save now re-sends a held toggle once the worker answers", async () => {
    const worker = fakeWorker({ failAdds: 2 });
    const channel = createToggleChannel(worker.send);
    expect(await channel.toggle(entry("add"))).toBe(false);
    worker.stopFailing();
    expect(await channel.retry()).toBe(true);
    expect(worker.pending()).toEqual(["add favorites"]);
    expect(channel.unrecorded()).toEqual([]);
  });

  test("a Save now that still fails keeps the toggle, once", async () => {
    const worker = fakeWorker({ failAdds: 10 });
    const channel = createToggleChannel(worker.send);
    await channel.toggle(entry("add"));
    expect(await channel.retry()).toBe(false);
    expect(await channel.retry()).toBe(false);
    expect(channel.unrecorded()).toHaveLength(1);
  });
});
