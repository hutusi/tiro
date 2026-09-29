import { describe, expect, test } from "bun:test";
import {
  commitFiles,
  type FetchLike,
  GitHubHttpError,
  readAtHead,
} from "../src/github.ts";
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

describe("commitFiles deletions (ADR 0036)", () => {
  test("deletes and writes in one commit, and leaves the rest alone", async () => {
    const gh = fakeGitHub({
      "articles/a-1234abcd/index.md": "A",
      "articles/a-1234abcd/assets/f.png": "png",
      "articles/b-1234abcd/index.md": "B",
      "collections/favorites.md": "v1",
    });
    const bodies: { tree: Record<string, unknown>[] }[] = [];
    const spy: typeof gh.fetch = async (input, init) => {
      if (init?.method === "POST" && String(input).endsWith("/git/trees")) {
        bodies.push(JSON.parse(String(init.body)));
      }
      return gh.fetch(input, init);
    };
    const result = await commitFiles(
      config,
      {
        build: async () => ({
          message: "remove: a-1234abcd",
          files: [
            { path: "articles/a-1234abcd/assets/f.png", delete: true },
            { path: "articles/a-1234abcd/index.md", delete: true },
            { path: "collections/favorites.md", content: "v2" },
          ],
        }),
      },
      spy,
    );
    expect(result.committed).not.toBeNull();
    expect(gh.log()).toEqual(["root", "remove: a-1234abcd"]);
    expect([...gh.files().keys()].sort()).toEqual([
      "articles/b-1234abcd/index.md",
      "collections/favorites.md",
    ]);
    expect(gh.files().get("collections/favorites.md")).toBe("v2");
    // The documented shape, and no content riding along with it.
    expect(bodies[0]?.tree[0]).toEqual({
      path: "articles/a-1234abcd/assets/f.png",
      mode: "100644",
      type: "blob",
      sha: null,
    });
  });

  test("a deletion of a file the head lacks is refused, not ignored", async () => {
    const gh = fakeGitHub({ "articles/b-1234abcd/index.md": "B" });
    const run = commitFiles(
      config,
      {
        build: async () => ({
          message: "m",
          files: [{ path: "articles/a-1234abcd/index.md", delete: true }],
        }),
      },
      gh.fetch,
    );
    await expect(run).rejects.toBeInstanceOf(GitHubHttpError);
    expect(gh.log()).toEqual(["root"]);
  });

  test("one path twice in a commit is a builder bug, refused before any write", async () => {
    const gh = fakeGitHub({ x: "1" });
    const run = commitFiles(
      config,
      {
        build: async () => ({
          message: "m",
          files: [
            { path: "x", content: "2" },
            { path: "x", delete: true },
          ],
        }),
      },
      gh.fetch,
    );
    await expect(run).rejects.toThrow("appears twice");
    expect(gh.requests.some((r) => r.startsWith("POST"))).toBe(false);
  });
});

describe("TreeReader.files", () => {
  test("lists every file under a directory, dotfiles and assets included", async () => {
    const gh = fakeGitHub({
      "articles/a-1234abcd/index.md": "A",
      "articles/a-1234abcd/zh.md": "Z",
      "articles/a-1234abcd/.tiro-zh-cache.json": "{}",
      "articles/a-1234abcd/assets/1.png": "p",
      "articles/a-1234abcd/assets/2.png": "p",
      "articles/a-1234abcd-other/index.md": "not this one",
    });
    let listed: string[] = [];
    let missing = null as string[] | null;
    await commitFiles(
      config,
      {
        build: async (reader) => {
          listed = await reader.files("articles/a-1234abcd");
          missing = await reader.files("articles/gone-1234abcd");
          return null;
        },
      },
      gh.fetch,
    );
    expect(listed).toEqual([
      "articles/a-1234abcd/.tiro-zh-cache.json",
      "articles/a-1234abcd/assets/1.png",
      "articles/a-1234abcd/assets/2.png",
      "articles/a-1234abcd/index.md",
      "articles/a-1234abcd/zh.md",
    ]);
    expect(missing).toEqual([]);
  });

  /** A repository whose one directory lists as `entries`. */
  function listingOnly(entries: unknown[]): FetchLike {
    return async (input) => {
      const url = String(input);
      if (url.includes("/git/ref/")) {
        return new Response(JSON.stringify({ object: { sha: "c1" } }));
      }
      if (url.includes("/git/commits/")) {
        return new Response(JSON.stringify({ tree: { sha: "t1" } }));
      }
      return new Response(JSON.stringify(entries));
    };
  }

  async function filesOf(entries: unknown[]): Promise<string[]> {
    let out: string[] = [];
    await commitFiles(
      config,
      {
        build: async (reader) => {
          out = await reader.files("articles/a-1234abcd");
          return null;
        },
      },
      listingOnly(entries),
    );
    return out;
  }

  test("refuses a listing that may have been cut off at the API's cap", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({
      name: `${i}.png`,
      type: "file",
    }));
    await expect(filesOf(full)).rejects.toThrow("the most GitHub returns");
    expect(await filesOf(full.slice(1))).toHaveLength(999);
  });

  test("refuses what the pipeline never writes: a symlink, a submodule", async () => {
    await expect(
      filesOf([{ name: "index.md", type: "symlink" }]),
    ).rejects.toThrow("is a symlink");
    await expect(
      filesOf([{ name: "vendor", type: "submodule" }]),
    ).rejects.toThrow("is a submodule");
  });
});

describe("readAtHead", () => {
  test("reads a file at the head, and says which commit that was", async () => {
    const gh = fakeGitHub({ "articles/a-1234abcd/index.md": "A" });
    const found = await readAtHead(
      config,
      "articles/a-1234abcd/index.md",
      gh.fetch,
    );
    expect(found.text).toBe("A");
    expect(found.commit).toMatch(/^c/);
    const absent = await readAtHead(config, "articles/gone/index.md", gh.fetch);
    expect(absent.text).toBeNull();
  });

  // The Contents API says 404 for a missing file and for a repository the
  // token cannot see. Only the first may read as "not there".
  test("a repository it cannot reach throws, never reads as absent", async () => {
    const unreachable: FetchLike = async () =>
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const read = readAtHead(config, "articles/a/index.md", unreachable);
    await expect(read).rejects.toBeInstanceOf(GitHubHttpError);
    await expect(read).rejects.toMatchObject({ status: 404 });
  });
});
