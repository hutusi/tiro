import { beforeEach, describe, expect, test } from "bun:test";
import { parseCollection } from "@tiro/shared";
import { flushNow, recordToggle } from "../src/collections-worker.ts";
import type { FetchLike } from "../src/github.ts";
import {
  loadCollectionQueue,
  loadFlushStatus,
  type TiroExtensionConfig,
} from "../src/storage.ts";
import { fakeGitHub } from "./fake-github.ts";
import { installChromeStorage } from "./helpers.ts";

const config: TiroExtensionConfig = {
  owner: "o",
  repo: "r",
  branch: "main",
  token: "t",
};
const A = "example-com-a-1234abcd";
const vault = { [`articles/${A}/index.md`]: "A" };

let n = 0;
function toggle(action: "add" | "remove", slug = A, collection = "favorites") {
  n += 1;
  return {
    type: "tiro-collection-toggle" as const,
    op: {
      id: `op${n}`,
      collection,
      slug,
      action,
      at: new Date().toISOString(),
    },
    published: action === "remove",
    member: action === "remove" ? [collection] : [],
  };
}

beforeEach(async () => {
  const { local } = installChromeStorage();
  await local.set({ tiroConfig: config });
});

describe("the collection worker", () => {
  test("a toggle queues, and a flush commits it and keeps it as overlay", async () => {
    const gh = fakeGitHub(vault);
    await recordToggle(toggle("add"));
    expect((await loadCollectionQueue(config)).map((op) => op.state)).toEqual([
      "pending",
    ]);

    const report = await flushNow(gh.fetch);
    expect(report).toMatchObject({ pending: 1, ok: true, refused: 0 });
    expect(report.committed).not.toBeNull();
    const text = gh.files().get("collections/favorites.md") ?? "";
    expect(
      parseCollection("favorites", text).frontmatter.items.map((i) => i.slug),
    ).toEqual([A]);
    expect((await loadCollectionQueue(config)).map((op) => op.state)).toEqual([
      "sent",
    ]);
    expect(await loadFlushStatus(config)).toMatchObject({ ok: true });
  });

  test("a failed flush keeps the queue and records why", async () => {
    const denied: FetchLike = async () =>
      new Response("bad credentials", { status: 401 });
    await recordToggle(toggle("add"));
    const before = await loadCollectionQueue(config);

    const report = await flushNow(denied);
    expect(report.ok).toBe(false);
    expect(await loadCollectionQueue(config)).toEqual(before);
    expect(await loadFlushStatus(config)).toMatchObject({
      ok: false,
      httpStatus: 401,
    });
  });

  test("an add for an article the vault lacks is dropped and counted", async () => {
    const gh = fakeGitHub(vault);
    await recordToggle(toggle("add", "elsewhere-com-x-deadbeef"));
    const report = await flushNow(gh.fetch);
    expect(report.refused).toBe(1);
    expect(await loadCollectionQueue(config)).toEqual([]);
    expect(await loadFlushStatus(config)).toMatchObject({
      ok: true,
      refused: 1,
    });
  });

  // Two realms writing one key would lose one write. The worker is the only
  // writer and runs one thing at a time: a toggle made while a flush is on the
  // network waits, and neither is lost.
  test("a toggle during a slow flush is neither lost nor swallowed by it", async () => {
    const gh = fakeGitHub({
      ...vault,
      "articles/example-com-b-5678abcd/index.md": "B",
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: FetchLike = async (input, init) => {
      await gate;
      return gh.fetch(input, init);
    };
    await recordToggle(toggle("add"));
    const flushing = flushNow(slow);
    const late = recordToggle(toggle("add", "example-com-b-5678abcd"));
    release();
    await Promise.all([flushing, late]);

    const queue = await loadCollectionQueue(config);
    expect(queue.map((op) => [op.slug, op.state])).toEqual([
      [A, "sent"],
      ["example-com-b-5678abcd", "pending"],
    ]);
  });

  test("an unconfigured extension neither queues nor flushes", async () => {
    const { local } = installChromeStorage();
    await recordToggle(toggle("add"));
    expect(await local.get("tiroCollectionQueue")).toEqual({});
    const report = await flushNow(async () => {
      throw new Error("must not be called");
    });
    expect(report.pending).toBe(0);
  });
});
