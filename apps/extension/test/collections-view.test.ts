import { describe, expect, test } from "bun:test";
import {
  enqueue,
  type QueuedOp,
  settleFlush,
} from "../src/collection-queue.ts";
import { messages } from "../src/i18n.ts";
import {
  collectionsView,
  visibleQueue,
} from "../src/popup/collections-view.ts";
import type { TiroPage } from "../src/tiro-page.ts";

const m = messages("en");
const T = "2026-09-22T10:00:00.000Z";
const article: TiroPage = {
  kind: "article",
  slug: "a",
  member: ["reading"],
  catalog: [
    { id: "reading", title: "重读" },
    { id: "favorites", title: "收藏" },
  ],
};
const idle = { status: null, syncing: false, report: null };
let n = 0;
const toggle = (action: "add" | "remove", collection: string, extra = {}) => {
  n += 1;
  return { id: `op${n}`, collection, slug: "a", action, at: T, ...extra };
};

describe("collectionsView", () => {
  test("favorites leads, then the catalog, ticked from the page", () => {
    const view = collectionsView({ page: article, queue: [], ...idle }, m);
    expect(
      view.rows?.map((r) => [r.id, r.title, r.checked, r.favorite]),
    ).toEqual([
      ["favorites", "收藏", false, true],
      ["reading", "重读", true, false],
    ]);
    expect(view.footer).toBeNull();
  });

  test("favorites is offered before the vault has one", () => {
    const view = collectionsView(
      { page: { ...article, catalog: [], member: [] }, queue: [], ...idle },
      m,
    );
    expect(view.rows?.map((r) => [r.id, r.title])).toEqual([
      ["favorites", "Favorites"],
    ]);
  });

  test("a pending toggle shows as ticked and pending, and counts", () => {
    const queue = enqueue([], toggle("add", "favorites"), false);
    const view = collectionsView({ page: article, queue, ...idle }, m);
    expect(view.rows?.[0]).toMatchObject({
      id: "favorites",
      checked: true,
      pending: true,
    });
    expect(view.footer).toMatchObject({
      text: m.collectionsPending(1),
      sync: { enabled: true },
    });
  });

  // The window the overlay exists for: saved, deploy not finished, page stale.
  test("a sent toggle still shows as ticked while the page catches up", () => {
    const pending = enqueue([], toggle("add", "favorites"), false);
    const queue = settleFlush(pending, new Set([`op${n}`]), new Set(), T);
    const view = collectionsView({ page: article, queue, ...idle }, m);
    expect(view.rows?.[0]).toMatchObject({ checked: true, pending: false });
    expect(view.footer).toBeNull();
  });

  test("a collection created here is listed with the title it was given", () => {
    const queue = enqueue(
      [],
      toggle("add", "collection-1a2b3c4d", { title: "待读" }),
      false,
    );
    const view = collectionsView({ page: article, queue, ...idle }, m);
    expect(view.rows?.at(-1)).toMatchObject({
      id: "collection-1a2b3c4d",
      title: "待读",
      checked: true,
    });
  });

  test("a Tiro page that is not an article has nothing to toggle", () => {
    const view = collectionsView(
      { page: { kind: "site" }, queue: [], ...idle },
      m,
    );
    expect(view.rows).toBeNull();
    expect(view.intro).toBe(m.tiroSiteIntro);
  });
});

describe("the queue footer", () => {
  const pending: QueuedOp[] = enqueue([], toggle("add", "favorites"), false);

  test("a failure is shown while there is still something to retry", () => {
    const view = collectionsView(
      {
        page: article,
        queue: pending,
        status: { at: T, ok: false, httpStatus: 401 },
        syncing: false,
        report: null,
      },
      m,
    );
    expect(view.footer?.tone).toBe("error");
    expect(view.footer?.text).toContain(m.errTokenInvalid);
  });

  test("an old failure with nothing left to retry is not news", () => {
    const view = collectionsView(
      {
        page: article,
        queue: [],
        status: { at: T, ok: false, httpStatus: 401 },
        syncing: false,
        report: null,
      },
      m,
    );
    expect(view.footer).toBeNull();
  });

  test("saving disables the button; a finished save says so, or what it dropped", () => {
    expect(
      collectionsView(
        {
          page: article,
          queue: pending,
          status: null,
          syncing: true,
          report: null,
        },
        m,
      ).footer,
    ).toMatchObject({ text: m.collectionsSaving, sync: { enabled: false } });
    const done = { pending: 1, ok: true, committed: "c", refused: 0 };
    expect(
      collectionsView(
        {
          page: article,
          queue: [],
          status: null,
          syncing: false,
          report: done,
        },
        m,
      ).footer,
    ).toMatchObject({ text: m.collectionsSaved, tone: "ok" });
    expect(
      collectionsView(
        {
          page: article,
          queue: [],
          status: null,
          syncing: false,
          report: { ...done, refused: 2 },
        },
        m,
      ).footer,
    ).toMatchObject({ text: m.collectionsRefused(2), tone: "error" });
  });
});

describe("visibleQueue", () => {
  const now = Date.parse("2026-10-01T00:00:00.000Z");
  const sent = (daysAgo: number): QueuedOp => ({
    id: `s${daysAgo}`,
    collection: "favorites",
    slug: "a",
    action: "add",
    at: T,
    state: "sent",
    sentAt: new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  });

  // Codex's repro: the worker prunes only when it writes, so a popup that just
  // opened kept showing a week-old saved tick.
  test("a saved tick past the overlay window is no longer drawn", () => {
    const page = { ...article, member: [] };
    const queue = visibleQueue([sent(8)], page, now);
    expect(queue).toEqual([]);
    const view = collectionsView({ page, queue, ...idle }, m);
    expect(view.rows?.find((r) => r.id === "favorites")?.checked).toBe(false);
  });

  test("one inside the window is still drawn over a stale page", () => {
    const page = { ...article, member: [] };
    const queue = visibleQueue([sent(1)], page, now);
    expect(queue).toHaveLength(1);
    expect(
      collectionsView({ page, queue, ...idle }, m).rows?.find(
        (r) => r.id === "favorites",
      )?.checked,
    ).toBe(true);
  });
});
