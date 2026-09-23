import { describe, expect, test } from "bun:test";
import { enqueue, pendingOps, type QueuedOp } from "../src/collection-queue.ts";
import type { CollectionMessage } from "../src/messages.ts";
import { createRecorder, type ToggleEntry } from "../src/popup/recorder.ts";
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

describe("createRecorder", () => {
  function entry(action: "add" | "remove", id: string): ToggleEntry {
    return {
      op: { id, collection: "favorites", slug: "a", action, at: "t" },
      published: false,
      member: [],
    };
  }

  /** A worker that records the way the real one does — `enqueue`, in arrival
   * order — and whose first attempt at the add fails after a delay, the way a
   * transient storage failure does. */
  function fakeWorker() {
    let queue: QueuedOp[] = [];
    let addAttempts = 0;
    const arrivals: string[] = [];
    const send = async (message: CollectionMessage) => {
      if (message.type !== "tiro-collection-toggle") return { ok: true };
      if (message.op.action === "add" && addAttempts++ === 0) {
        await sleep(20);
        arrivals.push("add (failed)");
        return null;
      }
      arrivals.push(message.op.action);
      queue = enqueue(queue, message.op, message.published);
      return { ok: true };
    };
    return { send, arrivals, queue: () => queue };
  }

  // Codex's sequence: the add fails once, the reader unticks at once, and the
  // retried add must not land after the remove and undo it.
  test("a retried add cannot overtake the reader's later remove", async () => {
    const worker = fakeWorker();
    const record = createRecorder(worker.send);
    const add = record(entry("add", "1"));
    const remove = record(entry("remove", "2"));
    expect(await Promise.all([add, remove])).toEqual([true, true]);
    expect(worker.arrivals).toEqual(["add (failed)", "add", "remove"]);
    // Ticked then unticked: nothing left to save.
    expect(pendingOps(worker.queue())).toEqual([]);
  });

  test("retries once, and reports a toggle that failed twice", async () => {
    let calls = 0;
    const record = createRecorder(async () => {
      calls += 1;
      return null;
    });
    expect(await record(entry("add", "1"))).toBe(false);
    expect(calls).toBe(2);
  });
});
