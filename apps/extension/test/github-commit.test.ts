import { describe, expect, test } from "bun:test";
import { commitFiles, GitHubHttpError } from "../src/github.ts";
import type { TiroExtensionConfig } from "../src/storage.ts";
import { fakeGitHub } from "./fake-github.ts";

const config: TiroExtensionConfig = {
  owner: "o",
  repo: "r",
  branch: "main",
  token: "t",
};

describe("commitFiles", () => {
  test("writes several files as one commit", async () => {
    const gh = fakeGitHub({ "articles/a/index.md": "A" });
    const result = await commitFiles(
      config,
      {
        build: async () => ({
          message: "collections: 2 changes",
          files: [
            { path: "collections/favorites.md", content: "fav" },
            { path: "collections/reading.md", content: "read" },
          ],
        }),
      },
      gh.fetch,
    );
    expect(result.committed).not.toBeNull();
    expect(gh.log()).toEqual(["root", "collections: 2 changes"]);
    expect(gh.files().get("collections/favorites.md")).toBe("fav");
    expect(gh.files().get("collections/reading.md")).toBe("read");
    // Untouched files survive: the tree is built on the head's, not from scratch.
    expect(gh.files().get("articles/a/index.md")).toBe("A");
  });

  test("builds against the head it parents on", async () => {
    const gh = fakeGitHub({ "collections/favorites.md": "v1" });
    let seen = null as string | null;
    await commitFiles(
      config,
      {
        build: async (reader) => {
          seen = await reader.read("collections/favorites.md");
          return {
            message: "m",
            files: [{ path: "collections/favorites.md", content: `${seen}+` }],
          };
        },
      },
      gh.fetch,
    );
    expect(seen).toBe("v1");
    expect(gh.files().get("collections/favorites.md")).toBe("v1+");
  });

  test("nothing to write makes no commit at all", async () => {
    const gh = fakeGitHub({});
    const result = await commitFiles(
      config,
      { build: async () => null },
      gh.fetch,
    );
    expect(result.committed).toBeNull();
    expect(gh.log()).toEqual(["root"]);
    expect(gh.requests.some((r) => r.startsWith("POST"))).toBe(false);
  });

  // The processing workflow commits back on its own schedule. A write that
  // raced it must rebuild from what it left, not overwrite it with a tree
  // computed before it landed.
  test("rebuilds on the new head when another commit lands first", async () => {
    const gh = fakeGitHub({ "collections/favorites.md": "v1" });
    let raced = false;
    gh.onBeforePatch = () => {
      if (raced) return;
      raced = true;
      gh.commitDirect(
        { "collections/favorites.md": "v2", "articles/b/index.md": "B" },
        "processor",
      );
    };
    const builtFrom: (string | null)[] = [];
    await commitFiles(
      config,
      {
        build: async (reader) => {
          const current = await reader.read("collections/favorites.md");
          builtFrom.push(current);
          return {
            // Describes this attempt's files, so a rebuild must carry its own.
            message: `mine, on ${current}`,
            files: [
              { path: "collections/favorites.md", content: `${current}+` },
            ],
          };
        },
      },
      gh.fetch,
    );
    expect(builtFrom).toEqual(["v1", "v2"]);
    // The message of the attempt that landed, not of the one that was refused.
    expect(gh.log()).toEqual(["root", "processor", "mine, on v2"]);
    expect(gh.files().get("collections/favorites.md")).toBe("v2+");
    expect(gh.files().get("articles/b/index.md")).toBe("B");
  });

  test("an empty list is nothing to write, too", async () => {
    const gh = fakeGitHub({});
    const result = await commitFiles(
      config,
      { build: async () => ({ message: "m", files: [] }) },
      gh.fetch,
    );
    expect(result.committed).toBeNull();
    expect(gh.log()).toEqual(["root"]);
  });

  test("never forces the ref", async () => {
    const gh = fakeGitHub({});
    const bodies: unknown[] = [];
    const spy: typeof gh.fetch = async (input, init) => {
      if (init?.method === "PATCH") bodies.push(JSON.parse(String(init.body)));
      return gh.fetch(input, init);
    };
    await commitFiles(
      config,
      {
        build: async () => ({
          message: "m",
          files: [{ path: "x", content: "y" }],
        }),
      },
      spy,
    );
    expect(bodies).toEqual([expect.objectContaining({ force: false })]);
  });

  test("gives up on a branch that keeps moving, and says so", async () => {
    const gh = fakeGitHub({});
    gh.onBeforePatch = () => gh.commitDirect({ noise: String(Math.random()) });
    const run = commitFiles(
      config,
      {
        build: async () => ({
          message: "m",
          files: [{ path: "x", content: "y" }],
        }),
        attempts: 2,
      },
      gh.fetch,
    );
    await expect(run).rejects.toBeInstanceOf(GitHubHttpError);
    expect(gh.files().has("x")).toBe(false);
  });

  test("a missing file reads as null and a directory as existing", async () => {
    const gh = fakeGitHub({ "articles/a-1234abcd/index.md": "A" });
    await commitFiles(
      config,
      {
        build: async (reader) => {
          expect(await reader.read("collections/nope.md")).toBeNull();
          expect(await reader.exists("articles/a-1234abcd")).toBe(true);
          expect(await reader.exists("articles/gone-1234abcd")).toBe(false);
          expect(await reader.list("articles/a-1234abcd")).toEqual([
            "index.md",
          ]);
          expect(await reader.list("articles/gone-1234abcd")).toBeNull();
          // A file is not a directory.
          expect(await reader.list("articles/a-1234abcd/index.md")).toBeNull();
          return null;
        },
      },
      gh.fetch,
    );
  });

  test("a branch with a slash is addressed segment by segment", async () => {
    const gh = fakeGitHub({}, "feature/x");
    const result = await commitFiles(
      { ...config, branch: "feature/x" },
      {
        build: async () => ({
          message: "m",
          files: [{ path: "x", content: "y" }],
        }),
      },
      gh.fetch,
    );
    expect(result.committed).not.toBeNull();
  });
});
