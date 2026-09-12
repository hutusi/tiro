import { describe, expect, test } from "bun:test";
import { ArticleFrontmatterSchema, stringifyArticle } from "@tiro/shared";
import {
  encodeBase64Utf8,
  findExistingIndex,
  GitHubHttpError,
  putFile,
  testConnection,
} from "../src/github.ts";
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

describe("testConnection", () => {
  // Reasons, not prose: the options page phrases the outcome in the user's
  // language, so the result must stay structured.
  test("reports a reachable repository by its full name", async () => {
    expect(
      await testConnection(config, async () => json(200, { full_name: "o/r" })),
    ).toEqual({ ok: true, fullName: "o/r" });
  });

  test("falls back to the configured name when the body has none", async () => {
    expect(await testConnection(config, async () => json(200, {}))).toEqual({
      ok: true,
      fullName: "o/r",
    });
  });

  test("distinguishes not-found, bad token, and other statuses", async () => {
    expect(await testConnection(config, async () => json(404, {}))).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await testConnection(config, async () => json(401, {}))).toEqual({
      ok: false,
      reason: "unauthorized",
    });
    expect(await testConnection(config, async () => json(500, {}))).toEqual({
      ok: false,
      reason: "http",
      status: 500,
    });
  });

  test("a thrown fetch reads as a network failure with its detail", async () => {
    const result = await testConnection(config, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(result).toEqual({
      ok: false,
      reason: "network",
      detail: "TypeError: Failed to fetch",
    });
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
        return json(200, {
          sha: "abc123",
          encoding: "base64",
          content: base64(article({})),
        });
      return json(500, {});
    };
    const result = await findExistingIndex(config, "slug-a1b2c3d4", fetchImpl);
    expect(result).toEqual({
      path: "articles/slug-a1b2c3d4/index.md",
      sha: "abc123",
      unlisted: false,
    });
    expect(requested).toHaveLength(1);
  });

  test("reports the unlisted flag of the article being overwritten", async () => {
    // A re-clip rebuilds index.md from scratch, so this lookup is the only
    // chance to notice that the article it overwrites was hidden on purpose.
    const result = await findExistingIndex(config, "slug-a1b2c3d4", async () =>
      json(200, {
        sha: "abc123",
        encoding: "base64",
        content: base64(article({ unlisted: true })),
      }),
    );
    expect(result?.unlisted).toBe(true);
  });

  test("reads the flag off frontmatter the contract would reject", async () => {
    // Deliberately lenient. The flag is hand-set, so the same hand can leave a
    // neighbouring field invalid — and a stricter read would take "this article
    // does not validate" for "this article is not hidden" and republish it.
    const broken = [
      "---",
      'url: "https://example.com/posts/hello"',
      "title: 42",
      "clipped_at: not-a-timestamp",
      "unlisted: true",
      "tiro:",
      "  schema: 9",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    const result = await findExistingIndex(config, "slug-a1b2c3d4", async () =>
      json(200, { sha: "abc123", encoding: "base64", content: base64(broken) }),
    );
    expect(result?.unlisted).toBe(true);
  });

  test("refuses to overwrite frontmatter it cannot parse", async () => {
    // A block this cannot read is exactly where a hand-set flag hides: behind
    // a typo one line above it, or a truncated file. Answering "listed" would
    // republish it; the clip stops instead.
    const unparseable = [
      "---",
      'url: "https://example.com/posts/hello"',
      "unlisted: true # keep this one private",
      "  : : :",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    const truncated = [
      "---",
      'url: "https://example.com/posts/hello"',
      "unlisted: true",
      "",
      "Body.",
      "",
    ].join("\n");
    for (const content of [unparseable, truncated]) {
      await expect(
        findExistingIndex(config, "slug-a1b2c3d4", async () =>
          json(200, {
            sha: "abc123",
            encoding: "base64",
            content: base64(content),
          }),
        ),
      ).rejects.toThrow(/refusing to overwrite/);
    }
  });

  test("reads a flag that carries a trailing comment", async () => {
    // The line the refusal above is protecting, once its block parses.
    const commented = [
      "---",
      'url: "https://example.com/posts/hello"',
      "unlisted: true # keep this one private",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    const result = await findExistingIndex(config, "slug-a1b2c3d4", async () =>
      json(200, {
        sha: "abc123",
        encoding: "base64",
        content: base64(commented),
      }),
    );
    expect(result?.unlisted).toBe(true);
  });

  test("reads the blob when the file is too large to inline", async () => {
    // Over 1MB the Contents API answers with an empty body and
    // `encoding: "none"`. Assuming "not unlisted" there would republish the
    // article; the blob carries the same content up to 100MB.
    const requested: string[] = [];
    const fetchImpl = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/git/blobs/abc123"))
        return json(200, {
          encoding: "base64",
          content: base64(article({ unlisted: true })),
        });
      return json(200, { sha: "abc123", encoding: "none", content: "" });
    };
    const result = await findExistingIndex(config, "slug-a1b2c3d4", fetchImpl);
    expect(result?.unlisted).toBe(true);
    expect(requested).toHaveLength(2);
  });

  test("fails the clip rather than guess when the content cannot be read", async () => {
    // The one outcome worth failing for: overwriting an article whose
    // visibility is unknown. The popup surfaces it and the clip can be retried.
    const fetchImpl = async (
      input: string | URL | Request,
    ): Promise<Response> =>
      String(input).includes("/git/blobs/")
        ? json(500, {})
        : json(200, { sha: "abc123", encoding: "none", content: "" });
    await expect(
      findExistingIndex(config, "slug-a1b2c3d4", fetchImpl),
    ).rejects.toThrow(GitHubHttpError);
  });

  test("treats a file with no frontmatter as not unlisted", async () => {
    const result = await findExistingIndex(config, "slug-a1b2c3d4", async () =>
      json(200, {
        sha: "abc123",
        encoding: "base64",
        content: base64("just a body\n"),
      }),
    );
    expect(result?.unlisted).toBe(false);
  });
});

/** A minimal contract-valid index.md, as the Contents API would hold it. */
function article(extra: Record<string, unknown>): string {
  return stringifyArticle(
    ArticleFrontmatterSchema.parse({
      url: "https://example.com/posts/hello",
      title: "Hello",
      domain: "example.com",
      clipped_at: "2026-09-12T09:00:00.000Z",
      ...extra,
      tiro: { schema: 1 },
    }),
    "Body.\n",
  );
}

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

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

  test("rebuilds the payload on 409 when the caller supplies a resolver", async () => {
    // The race this closes: a hand-edit hides the article between the clip's
    // lookup and its PUT. Retrying the bytes already built would overwrite the
    // flag with listed content, and nothing would say so (ADR 0017).
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
        resolveConflict: async () => ({
          sha: "resolved-sha",
          contentBase64: "Qg==",
        }),
      },
      fetchImpl,
    );
    expect(puts).toHaveLength(2);
    expect(puts[1]).toMatchObject({ sha: "resolved-sha", content: "Qg==" });
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

  test("failures carry their HTTP status as a typed error", async () => {
    // The popup maps statuses to friendly messages; that needs the number,
    // not a string to parse back out of the message.
    try {
      await putFile(
        config,
        { path: "p", contentBase64: "QQ==", message: "m" },
        async () => new Response("bad credentials", { status: 401 }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubHttpError);
      expect((error as GitHubHttpError).status).toBe(401);
    }
  });
});
