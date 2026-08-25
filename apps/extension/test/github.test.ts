import { describe, expect, test } from "bun:test";
import { encodeBase64Utf8, findExistingIndex, putFile } from "../src/github.ts";
import type { TiroExtensionConfig } from "../src/storage.ts";

const config: TiroExtensionConfig = {
  owner: "o",
  repo: "r",
  branch: "main",
  token: "t",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("encodeBase64Utf8", () => {
  test("matches Buffer's base64 for Chinese text", () => {
    const text = '---\ntitle: "实用指南 — with dashes"\n---\n\n中文正文。\n';
    expect(encodeBase64Utf8(text)).toBe(
      Buffer.from(text, "utf8").toString("base64"),
    );
  });

  test("handles input larger than one chunk", () => {
    const text = "中文".repeat(60_000);
    expect(encodeBase64Utf8(text)).toBe(
      Buffer.from(text, "utf8").toString("base64"),
    );
  });
});

describe("findExistingIndex", () => {
  test("returns null when the vault has no articles yet", async () => {
    const result = await findExistingIndex(config, "slug-a1b2c3d4", async () =>
      json(404, { message: "Not Found" }),
    );
    expect(result).toBeNull();
  });

  test("finds an existing clip with a single deterministic-path probe", async () => {
    const requested: string[] = [];
    const fetchImpl = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/contents/articles/slug-a1b2c3d4/index.md"))
        return json(200, { sha: "abc123" });
      return json(500, {});
    };
    const result = await findExistingIndex(config, "slug-a1b2c3d4", fetchImpl);
    expect(result).toEqual({
      path: "articles/slug-a1b2c3d4/index.md",
      sha: "abc123",
    });
    expect(requested).toHaveLength(1);
  });
});

describe("putFile", () => {
  test("creates a new file without a sha", async () => {
    const bodies: Record<string, unknown>[] = [];
    await putFile(
      config,
      {
        path: "articles/s/index.md",
        contentBase64: "QQ==",
        message: "clip: x",
      },
      async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json(201, {});
      },
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      message: "clip: x",
      content: "QQ==",
      branch: "main",
    });
  });

  test("retries once with a fresh sha on 409", async () => {
    const puts: Record<string, unknown>[] = [];
    let putCount = 0;
    const fetchImpl = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (init?.method === "PUT") {
        putCount += 1;
        puts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return putCount === 1 ? json(409, {}) : json(200, {});
      }
      return json(200, { sha: "fresh-sha" });
    };
    await putFile(
      config,
      {
        path: "p/index.md",
        contentBase64: "QQ==",
        message: "m",
        sha: "stale-sha",
      },
      fetchImpl,
    );
    expect(puts).toHaveLength(2);
    expect(puts[0]?.sha).toBe("stale-sha");
    expect(puts[1]?.sha).toBe("fresh-sha");
  });

  test("throws with status and body on persistent failure", async () => {
    await expect(
      putFile(
        config,
        { path: "p", contentBase64: "QQ==", message: "m" },
        async () => new Response("nope", { status: 403 }),
      ),
    ).rejects.toThrow("403");
  });
});
