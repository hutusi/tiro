import { describe, expect, test } from "bun:test";
import {
  type CollectionFrontmatter,
  parseCollection,
  stringifyCollection,
} from "@tiro/shared/documents";
import type { FetchLike } from "../src/github.ts";
import {
  lookupArticle,
  removeArticle,
  UnreadableCollectionError,
} from "../src/remove-article.ts";
import type { TiroExtensionConfig } from "../src/storage.ts";
import { fakeGitHub } from "./fake-github.ts";

const config: TiroExtensionConfig = {
  owner: "o",
  repo: "r",
  branch: "main",
  token: "t",
};
const A = "example-com-a-1234abcd";
const B = "example-com-b-5678abcd";

function collectionFile(
  items: string[],
  extra: Partial<CollectionFrontmatter> = {},
): string {
  return stringifyCollection(
    {
      title: "T",
      updated_at: "2026-09-20T10:00:00.000Z",
      ...extra,
      items: items.map((slug) => ({ slug })),
      tiro: { schema: 1 },
    },
    "",
  );
}

const ARTICLE_A = {
  [`articles/${A}/index.md`]:
    '---\ntitle: "An article"\ntitle_zh: "一篇文章"\n---\n\nBody.\n',
  [`articles/${A}/zh.md`]: "译文。\n",
  [`articles/${A}/.tiro-zh-cache.json`]: "{}",
  [`articles/${A}/assets/1.png`]: "png",
  [`articles/${A}/assets/2.png`]: "png",
};

function vault(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...ARTICLE_A,
    [`articles/${B}/index.md`]: "---\ntitle: B\n---\n\nB.\n",
    "collections/favorites.md": collectionFile([A, B]),
    "collections/reading.md": collectionFile([B], {
      cover: `articles/${A}/assets/1.png`,
    }),
    "collections/other.md": collectionFile([B]),
    ...extra,
  };
}

const under = (files: Map<string, string>, slug: string) =>
  [...files.keys()].filter((path) => path.startsWith(`articles/${slug}/`));

const members = (files: Map<string, string>, id: string) =>
  parseCollection(
    id,
    files.get(`collections/${id}.md`) ?? "",
  ).frontmatter.items.map((item) => item.slug);

describe("removeArticle", () => {
  test("deletes every file of the article and its collection entries in one commit", async () => {
    const gh = fakeGitHub(vault());
    const before = gh.files();
    const outcome = await removeArticle(
      config,
      A,
      { title: "An article" },
      gh.fetch,
    );
    expect(outcome).toEqual({
      kind: "removed",
      commit: expect.any(String),
      files: 5,
      collections: ["favorites", "reading"],
    });
    const files = gh.files();
    expect(under(files, A)).toEqual([]);
    expect(files.get(`articles/${B}/index.md`)).toBe(
      before.get(`articles/${B}/index.md`),
    );
    expect(members(files, "favorites")).toEqual([B]);
    const reading = parseCollection(
      "reading",
      files.get("collections/reading.md") ?? "",
    );
    expect(reading.frontmatter.items).toEqual([{ slug: B }]);
    expect(reading.frontmatter.cover).toBeUndefined();
    // A removal is not the owner deciding anything about the shelf.
    expect(reading.frontmatter.updated_at).toBe("2026-09-20T10:00:00.000Z");
    // Untouched collections are not rewritten at all.
    expect(files.get("collections/other.md")).toBe(
      before.get("collections/other.md"),
    );
    expect(gh.log()).toEqual([
      "root",
      [
        "remove: An article",
        "",
        `articles/${A}/ (5 files)`,
        "collections: favorites −1, reading (cover unpinned)",
      ].join("\n"),
    ]);
  });

  test("names the slug when it has no title, and says nothing of collections it left alone", async () => {
    const gh = fakeGitHub({ ...ARTICLE_A });
    await removeArticle(config, A, {}, gh.fetch);
    expect(gh.log()[1]).toBe(`remove: ${A}\n\narticles/${A}/ (5 files)`);
  });

  test("an article that is not there is gone, and nothing is written", async () => {
    const gh = fakeGitHub(vault());
    expect(
      await removeArticle(config, B.replace("b", "c"), {}, gh.fetch),
    ).toEqual({
      kind: "gone",
    });
    // A directory without an index.md is not an article either.
    const orphan = fakeGitHub({ [`articles/${A}/zh.md`]: "译文。\n" });
    expect(await removeArticle(config, A, {}, orphan.fetch)).toEqual({
      kind: "gone",
    });
    for (const g of [gh, orphan]) {
      expect(g.requests.some((r) => r.startsWith("POST"))).toBe(false);
      expect(g.log()).toEqual(["root"]);
    }
  });

  // The likeliest removal: the clip was a mistake, and the run its push
  // started finishes the article between this build and its ref update.
  test("files the processing run adds meanwhile are deleted too", async () => {
    const gh = fakeGitHub(vault());
    let raced = false;
    gh.onBeforePatch = () => {
      if (raced) return;
      raced = true;
      gh.commitDirect(
        {
          [`articles/${A}/index.md`]: "---\ntitle: An article\n---\n\nDone.\n",
          [`articles/${A}/assets/3.png`]: "png",
        },
        "process: summarize and translate new articles",
      );
    };
    const outcome = await removeArticle(config, A, {}, gh.fetch);
    expect(outcome).toMatchObject({ kind: "removed", files: 6 });
    expect(under(gh.files(), A)).toEqual([]);
    expect(gh.log().slice(1, 2)).toEqual([
      "process: summarize and translate new articles",
    ]);
  });

  test("an article removed elsewhere meanwhile is gone, not an error", async () => {
    const gh = fakeGitHub(vault());
    let raced = false;
    gh.onBeforePatch = () => {
      if (raced) return;
      raced = true;
      gh.commitDirect(
        Object.fromEntries(Object.keys(ARTICLE_A).map((path) => [path, null])),
        "removed on another machine",
      );
    };
    expect(await removeArticle(config, A, {}, gh.fetch)).toEqual({
      kind: "gone",
    });
    expect(gh.log()).toEqual(["root", "removed on another machine"]);
  });

  test("a broken collection that names the article stops the removal, naming the file", async () => {
    const broken = `---\ntitle: [unclosed\nitems:\n  - slug: ${A}\n---\n`;
    const gh = fakeGitHub(vault({ "collections/broken.md": broken }));
    const run = removeArticle(config, A, {}, gh.fetch);
    await expect(run).rejects.toBeInstanceOf(UnreadableCollectionError);
    await expect(run).rejects.toMatchObject({ path: "collections/broken.md" });
    expect(gh.log()).toEqual(["root"]);
    expect(under(gh.files(), A)).toHaveLength(5);
  });

  test("a broken collection that does not name it is none of this removal's business", async () => {
    const broken = "---\ntitle: [unclosed\n---\n";
    const gh = fakeGitHub(vault({ "collections/broken.md": broken }));
    expect(await removeArticle(config, A, {}, gh.fetch)).toMatchObject({
      kind: "removed",
    });
    expect(gh.files().get("collections/broken.md")).toBe(broken);
  });

  test("a file under collections/ with no usable id is judged the same way", async () => {
    const stray = collectionFile([A]);
    const gh = fakeGitHub(vault({ "collections/Not An Id.md": stray }));
    await expect(removeArticle(config, A, {}, gh.fetch)).rejects.toMatchObject({
      path: "collections/Not An Id.md",
    });
    expect(gh.log()).toEqual(["root"]);
  });

  // GitHub lists at most 1,000 entries of a directory and says nothing when it
  // stops. A removal that trusted such a listing would report success and
  // leave the article in every collection past the cut.
  test("a collections listing that may be cut off stops the removal", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      many[`collections/c${String(i).padStart(4, "0")}.md`] = collectionFile([
        B,
      ]);
    }
    // Sorts last, so a truncated listing is the one that leaves it out.
    many["collections/zz-last.md"] = collectionFile([A]);
    const gh = fakeGitHub(vault(many));
    await expect(removeArticle(config, A, {}, gh.fetch)).rejects.toThrow(
      "the most GitHub returns",
    );
    expect(gh.log()).toEqual(["root"]);
    expect(members(gh.files(), "zz-last")).toEqual([A]);
  });

  test("a slug that is not a path segment is refused before any request", async () => {
    const gh = fakeGitHub(vault());
    for (const bad of ["../config", "a/b", "", "UPPER"]) {
      await expect(removeArticle(config, bad, {}, gh.fetch)).rejects.toThrow(
        "is not an article slug",
      );
      await expect(lookupArticle(config, bad, gh.fetch)).rejects.toThrow(
        "is not an article slug",
      );
    }
    expect(gh.requests).toEqual([]);
  });
});

describe("lookupArticle", () => {
  test("names the article the way the vault has it", async () => {
    const gh = fakeGitHub(vault());
    expect(await lookupArticle(config, A, gh.fetch)).toEqual({
      title: "An article",
      titleZh: "一篇文章",
    });
    expect(await lookupArticle(config, B, gh.fetch)).toEqual({
      title: "B",
      titleZh: null,
    });
  });

  test("an article whose frontmatter is broken is still there, untitled", async () => {
    const gh = fakeGitHub({
      [`articles/${A}/index.md`]: "---\ntitle: [unclosed\n---\n\nBody.\n",
    });
    expect(await lookupArticle(config, A, gh.fetch)).toEqual({
      title: null,
      titleZh: null,
    });
  });

  test("an article that is not there is null", async () => {
    const gh = fakeGitHub(vault());
    expect(
      await lookupArticle(config, "example-com-c-1234abcd", gh.fetch),
    ).toBeNull();
  });

  // Read alone, the Contents API's 404 would make a vault the token cannot
  // see look empty — and the popup would forget clips that are still there.
  test("a vault it cannot reach throws rather than reading as empty", async () => {
    const unreachable: FetchLike = async () =>
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    await expect(lookupArticle(config, A, unreachable)).rejects.toMatchObject({
      status: 404,
    });
  });
});
