import { describe, expect, test } from "bun:test";
import { parseArticle, slugForUrl } from "@tiro/shared";
import { commitClip } from "../src/clip-commit.ts";
import { GitHubHttpError } from "../src/github.ts";
import type { TiroExtensionConfig } from "../src/storage.ts";
import { fakeGitHub } from "./fake-github.ts";

const config: TiroExtensionConfig = {
  owner: "o",
  repo: "r",
  branch: "main",
  token: "t",
};

const URL_ = "https://precision.example/how-machines/";
const clip = {
  url: URL_,
  title: "How Machines Learned Precision",
  markdown:
    "Prose.\n\n[![A lathe.](./assets/3f9a0c1b2d4e.webp)](https://precision.example/how-machines)  \nSlower than life.",
  clippedAt: "2026-10-08T10:00:00.000Z",
  clipperVersion: "0.17.0",
};
const LATHE = { id: "3f9a0c1b2d4e", bytes: new Uint8Array([82, 73, 70, 70]) };
const GEARS = { id: "0123456789ab", bytes: new Uint8Array([1, 2, 3]) };

/** An article already in the vault, with a flag a re-clip has to carry. */
function existing(slug: string, unlisted: boolean): Record<string, string> {
  return {
    [`articles/${slug}/index.md`]: `---\nurl: https://precision.example/how-machines\ntitle: Old\ndomain: precision.example\nclipped_at: 2026-10-01T00:00:00.000Z\n${unlisted ? "unlisted: true\n" : ""}tiro:\n  schema: 1\n---\n\nOld body.\n`,
  };
}

describe("commitClip", () => {
  test("without snapshots it is the one Contents API PUT it always was", async () => {
    const gh = fakeGitHub({});
    const slug = await slugForUrl(URL_);
    const { file, updated } = await commitClip(config, clip, {}, gh.fetch);
    expect(updated).toBe(false);
    expect(file.path).toBe(`articles/${slug}/index.md`);
    expect(gh.requests.filter((r) => !r.startsWith("GET"))).toEqual([
      `PUT /contents/articles/${slug}/index.md`,
    ]);
    expect(gh.log()).toEqual(["root", `clip: ${clip.title}`]);
  });

  test("with snapshots, the body and its pictures land as one commit", async () => {
    const gh = fakeGitHub({ "articles/other/index.md": "kept" });
    const slug = await slugForUrl(URL_);
    const progress: string[] = [];
    const { file, updated } = await commitClip(
      config,
      clip,
      {
        snapshots: [LATHE, GEARS],
        onUpload: (done, total) => progress.push(`${done}/${total}`),
      },
      gh.fetch,
    );
    expect(updated).toBe(false);
    expect(gh.log()).toEqual(["root", `clip: ${clip.title}`]);
    const files = gh.files();
    expect(files.get(file.path)).toBe(file.content);
    expect(files.get(`articles/${slug}/assets/3f9a0c1b2d4e.webp`)).toBe(
      `blob:${Buffer.from(LATHE.bytes).toString("base64")}`,
    );
    expect(files.get(`articles/${slug}/assets/0123456789ab.webp`)).toBe(
      `blob:${Buffer.from(GEARS.bytes).toString("base64")}`,
    );
    expect(files.get("articles/other/index.md")).toBe("kept");
    expect(progress).toEqual(["1/2", "2/2"]);
    // No one-file PUT: that would be a second commit, a second push and a
    // second processing run.
    expect(gh.requests.some((r) => r.startsWith("PUT"))).toBe(false);
  });

  test("a re-clip keeps the article unlisted, whichever path it takes", async () => {
    const slug = await slugForUrl(URL_);
    for (const snapshots of [[], [LATHE]]) {
      const gh = fakeGitHub(existing(slug, true));
      const { file, updated } = await commitClip(
        config,
        clip,
        { snapshots },
        gh.fetch,
      );
      expect(updated).toBe(true);
      expect(parseArticle(file.content).frontmatter.unlisted).toBe(true);
      expect(gh.files().get(file.path)).toBe(file.content);
    }
  });

  test("a head that moves mid-commit is rebuilt on, and nothing is uploaded twice", async () => {
    const slug = await slugForUrl(URL_);
    const gh = fakeGitHub(existing(slug, false));
    let landed = false;
    gh.onBeforePatch = () => {
      if (landed) return;
      landed = true;
      // Someone hides the article between the build and the ref update.
      gh.commitDirect(existing(slug, true), "hide it");
    };
    const { file } = await commitClip(
      config,
      clip,
      { snapshots: [LATHE] },
      gh.fetch,
    );
    expect(gh.log()).toEqual(["root", "hide it", `clip: ${clip.title}`]);
    // Built again on the commit that hid it, so the flag survives.
    expect(parseArticle(file.content).frontmatter.unlisted).toBe(true);
    expect(gh.requests.filter((r) => r === "POST /git/blobs")).toHaveLength(1);
  });

  test("a stub carries the body already there, with snapshots or without", async () => {
    // Not a combination the popup produces — a PDF has no figures — but the
    // rule that keeps a converted body is the commit's, not the caller's.
    const slug = await slugForUrl(URL_);
    const gh = fakeGitHub(existing(slug, false));
    const { file } = await commitClip(
      config,
      { ...clip, markdown: "", sourceMedia: "pdf" },
      { snapshots: [LATHE] },
      gh.fetch,
    );
    expect(parseArticle(file.content).body.trim()).toBe("Old body.");
  });

  test("an id that is not a snapshot's never becomes a path", async () => {
    const gh = fakeGitHub({});
    await expect(
      commitClip(
        config,
        clip,
        { snapshots: [{ id: "../../x", bytes: LATHE.bytes }] },
        gh.fetch,
      ),
    ).rejects.toThrow("not a snapshot id");
    expect(gh.requests).toEqual([]);
  });

  test("a failed upload fails the clip, and commits nothing", async () => {
    const gh = fakeGitHub({});
    const failing: typeof gh.fetch = async (input, init) =>
      String(input).endsWith("/git/blobs")
        ? new Response("{}", { status: 500 })
        : gh.fetch(input, init);
    await expect(
      commitClip(config, clip, { snapshots: [LATHE] }, failing),
    ).rejects.toBeInstanceOf(GitHubHttpError);
    expect(gh.log()).toEqual(["root"]);
  });
});
