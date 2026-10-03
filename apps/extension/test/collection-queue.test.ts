import { describe, expect, test } from "bun:test";
import {
  effectiveMembership,
  enqueue,
  pendingOps,
  pruneSent,
  type QueuedOp,
  SENT_OVERLAY_MS,
  settleFlush,
} from "../src/collection-queue.ts";

const T = "2026-09-22T10:00:00.000Z";
let n = 0;
function toggle(
  action: "add" | "remove",
  collection = "favorites",
  slug = "a",
) {
  n += 1;
  return { id: `op${n}`, collection, slug, action, at: T };
}

describe("enqueue", () => {
  test("a toggle away from the page is queued", () => {
    const q = enqueue([], toggle("add"), false);
    expect(pendingOps(q)).toHaveLength(1);
  });

  test("toggling back cancels it instead of queuing a second op", () => {
    let q = enqueue([], toggle("add"), false);
    q = enqueue(q, toggle("remove"), false);
    expect(q).toEqual([]);
  });

  test("a toggle that matches the page is not a change", () => {
    expect(enqueue([], toggle("add"), true)).toEqual([]);
  });

  test("one entry per pair — the latest toggle replaces the earlier", () => {
    let q = enqueue([], toggle("add"), false);
    q = enqueue(q, toggle("add", "reading"), false);
    q = enqueue(q, toggle("remove"), false);
    expect(q.map((op) => op.collection)).toEqual(["reading"]);
  });

  // After a flush the page is stale until the deploy finishes. The sent op is
  // what the vault holds, so undoing it must be a real change — judged
  // against the vault, not against the page that has not caught up.
  test("undoing a sent op is a change even while the page is stale", () => {
    const sent = settleFlush(
      enqueue([], toggle("add"), false),
      new Set(["op" + n]),
      new Set(),
      T,
    );
    const q = enqueue(sent, toggle("remove"), false);
    expect(pendingOps(q)).toEqual([
      expect.objectContaining({ action: "remove" }),
    ]);
  });

  test("re-toggling to what a sent op already holds keeps the overlay", () => {
    const sent = settleFlush(
      enqueue([], toggle("add"), false),
      new Set(["op" + n]),
      new Set(),
      T,
    );
    const q = enqueue(sent, toggle("add"), false);
    expect(q).toEqual(sent);
  });

  // The owner's repro on PR #68: save Favorites, re-clip before the deploy,
  // untick and re-tick under the clip. The page there is the vault, which
  // already agrees with the re-tick, so cancelling the edit dropped the saved
  // op along with it — and a stale Tiro page lost the tick.
  test("cancelling an edit of a sent op puts the sent op back", () => {
    const sent = settleFlush(
      enqueue([], toggle("add"), false),
      new Set([`op${n}`]),
      new Set(),
      T,
    );
    const saved = sent[0];
    // Drawn from the vault (after a clip) or from a stale site: either way the
    // sent op, not the page, says what the vault holds.
    for (const published of [true, false]) {
      const edited = enqueue(sent, toggle("remove"), published);
      expect(pendingOps(edited)).toEqual([
        expect.objectContaining({ action: "remove", replaced: saved }),
      ]);
      expect(enqueue(edited, toggle("add"), published)).toEqual(sent);
    }
  });

  test("a sent op leaves behind nothing it displaced", () => {
    const first = settleFlush(
      enqueue([], toggle("add"), false),
      new Set([`op${n}`]),
      new Set(),
      T,
    );
    const edited = enqueue(first, toggle("remove"), true);
    const [removal] = pendingOps(edited);
    if (removal === undefined) throw new Error("no pending removal");
    const landed = settleFlush(
      edited,
      new Set([removal.id]),
      new Set(),
      "2026-09-23T10:00:00.000Z",
    );
    expect(landed).toEqual([
      {
        id: removal.id,
        collection: "favorites",
        slug: "a",
        action: "remove",
        at: T,
        state: "sent",
        sentAt: "2026-09-23T10:00:00.000Z",
      },
    ]);
  });
});

describe("effectiveMembership", () => {
  test("lays every op for the article over the page", () => {
    let q: QueuedOp[] = [];
    q = enqueue(q, toggle("add", "reading"), false);
    q = enqueue(q, toggle("remove", "favorites"), true);
    q = enqueue(q, toggle("add", "other", "b"), false);
    expect([...effectiveMembership(["favorites"], q, "a")].sort()).toEqual([
      "reading",
    ]);
  });
});

describe("settleFlush", () => {
  test("marks what it sent, drops what it refused, leaves the rest pending", () => {
    let q: QueuedOp[] = [];
    q = enqueue(q, toggle("add", "favorites", "a"), false);
    const sentId = `op${n}`;
    q = enqueue(q, toggle("add", "favorites", "gone"), false);
    const refusedId = `op${n}`;
    q = enqueue(q, toggle("add", "reading", "a"), false);
    const lateId = `op${n}`;
    const settled = settleFlush(q, new Set([sentId]), new Set([refusedId]), T);
    expect(settled.map((op) => [op.id, op.state])).toEqual([
      [sentId, "sent"],
      [lateId, "pending"],
    ]);
  });
});

describe("pruneSent", () => {
  const now = Date.parse(T);
  function sentOp(action: "add" | "remove", sentAt = T): QueuedOp {
    return { ...toggle(action), state: "sent", sentAt };
  }

  test("drops a sent op once the page agrees with it", () => {
    expect(
      pruneSent([sentOp("add")], { slug: "a", member: ["favorites"] }, now),
    ).toEqual([]);
    expect(
      pruneSent([sentOp("remove")], { slug: "a", member: [] }, now),
    ).toEqual([]);
  });

  test("keeps it while the page still disagrees", () => {
    const op = sentOp("add");
    expect(pruneSent([op], { slug: "a", member: [] }, now)).toEqual([op]);
  });

  test("ages it out after a week regardless", () => {
    const old = sentOp(
      "add",
      new Date(now - SENT_OVERLAY_MS - 1).toISOString(),
    );
    expect(pruneSent([old], null, now)).toEqual([]);
  });

  test("never prunes a pending op", () => {
    const q = enqueue([], toggle("add"), false);
    expect(
      pruneSent(
        q,
        { slug: "a", member: ["favorites"] },
        now + SENT_OVERLAY_MS * 2,
      ),
    ).toEqual(q);
  });
});
