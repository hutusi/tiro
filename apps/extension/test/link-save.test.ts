import { describe, expect, test } from "bun:test";
import { slugForUrl } from "@tiro/shared/documents";
import type { FetchLike } from "../src/github.ts";
import { inboxFileName, saveLink } from "../src/link-save.ts";
import type { TiroExtensionConfig } from "../src/storage.ts";

const config: TiroExtensionConfig = {
  owner: "o",
  repo: "vault",
  branch: "main",
  token: "t",
};

/** Answers the Contents API as a vault holding `articles`, and records every
 * write. */
function vault(articles: string[] = []) {
  const writes: { path: string; body: { message: string; content: string } }[] =
    [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(
      url.pathname.replace("/repos/o/vault/contents/", ""),
    );
    if (init?.method === "PUT") {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 201 });
    }
    const slug = path.replace(/^articles\//, "");
    if (articles.includes(slug)) {
      return Response.json([{ name: "index.md" }, { name: "zh.md" }]);
    }
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, writes };
}

const now = () => new Date("2026-09-26T08:00:05.000Z");
const random = () => 0.5;

describe("inboxFileName", () => {
  test("names a save by its UTC second and four random digits", () => {
    expect(inboxFileName(now(), 0)).toBe("20260926-080005-1000.url");
    expect(inboxFileName(now(), 0.9999)).toBe("20260926-080005-9999.url");
  });
});

describe("saveLink", () => {
  test("writes the link into the inbox, as the phone does", async () => {
    const { fetchImpl, writes } = vault();
    const outcome = await saveLink("https://example.net/post?x=1", {
      config,
      disclosed: true,
      fetchImpl,
      now,
      random,
    });
    expect(outcome).toEqual({
      kind: "saved",
      url: "https://example.net/post?x=1",
      path: "inbox/20260926-080005-5500.url",
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body.message).toBe("save: https://example.net/post?x=1");
    expect(atob(writes[0]?.body.content ?? "")).toBe(
      "https://example.net/post?x=1\n",
    );
  });

  test("says so, and writes nothing, when the article is already there", async () => {
    const slug = await slugForUrl("https://example.net/post");
    const { fetchImpl, writes } = vault([slug]);
    const outcome = await saveLink("https://example.net/post", {
      config,
      disclosed: true,
      fetchImpl,
    });
    expect(outcome).toEqual({
      kind: "exists",
      url: "https://example.net/post",
      slug,
    });
    expect(writes).toEqual([]);
  });

  test("an orphan directory is not an article", async () => {
    const slug = await slugForUrl("https://example.net/post");
    const { writes } = vault();
    const fetchImpl: FetchLike = async (input, init) => {
      if (init?.method === "PUT") {
        writes.push({ path: "", body: { message: "", content: "" } });
        return new Response("{}", { status: 201 });
      }
      return String(input).includes(slug)
        ? Response.json([{ name: "zh.md" }])
        : new Response("{}", { status: 404 });
    };
    const outcome = await saveLink("https://example.net/post", {
      config,
      disclosed: true,
      fetchImpl,
    });
    expect(outcome.kind).toBe("saved");
  });

  test("sends nothing before the disclosure is accepted", async () => {
    // The disclosure is the promise about what leaves the browser; a menu
    // item is no way around it.
    const { fetchImpl, writes } = vault();
    let asked = false;
    const outcome = await saveLink("https://example.net/post", {
      config,
      disclosed: false,
      fetchImpl: async (...args) => {
        asked = true;
        return fetchImpl(...args);
      },
    });
    expect(outcome).toEqual({ kind: "refused", reason: "no-disclosure" });
    expect(asked).toBe(false);
    expect(writes).toEqual([]);
  });

  test("refuses what is not an http(s) link, and a vault not set up", async () => {
    const { fetchImpl } = vault();
    expect(
      await saveLink("mailto:someone@example.net", {
        config,
        disclosed: true,
        fetchImpl,
      }),
    ).toEqual({ kind: "refused", reason: "not-a-link" });
    expect(
      await saveLink("https://example.net/post", {
        config: { ...config, token: "" },
        disclosed: true,
        fetchImpl,
      }),
    ).toEqual({ kind: "refused", reason: "unconfigured" });
  });

  test("a GitHub refusal comes back as a failure, not a throw", async () => {
    const outcome = await saveLink("https://example.net/post", {
      config,
      disclosed: true,
      fetchImpl: async (_input, init) =>
        init?.method === "PUT"
          ? new Response("Bad credentials", { status: 401 })
          : new Response("{}", { status: 404 }),
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.error).toContain("401");
  });
});
