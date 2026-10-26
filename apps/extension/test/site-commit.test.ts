import { describe, expect, test } from "bun:test";
import { parseCollection, parseSite, slugForUrl } from "@tiro/shared";
import {
  buildSiteFile,
  commitSite,
  lookupSite,
  samePage,
} from "../src/site-commit.ts";
import type { TiroExtensionConfig } from "../src/storage.ts";
import { fakeGitHub } from "./fake-github.ts";

/** ADR 0055: saving a page as a site. */

const config: TiroExtensionConfig = {
  owner: "o",
  repo: "r",
  branch: "main",
  token: "t",
};

const TAB = "https://maps.example.org/roman-battles/?utm_source=x#year=-216";
const site = {
  url: TAB,
  title: "  Battles of the Roman Republic  ",
  description: "An interactive\n map.",
  note: "Drag it slowly.\nThen faster.",
  markdown: "509 BC — 27 BC\n",
  clippedAt: "2026-10-26T10:00:00.000Z",
  clipperVersion: "0.19.0",
  clipperCommit: "ext-v0.18.0-12-gabcdef0",
};
const SHOT = { id: "54ea819b7af4", bytes: new Uint8Array([82, 73, 70, 70]) };

describe("buildSiteFile", () => {
  test("files the site under the page's normalized URL, keeping the exact one", async () => {
    const file = await buildSiteFile({ ...site, shotId: SHOT.id });
    const slug = await slugForUrl(TAB);
    expect(file.path).toBe(`sites/${slug}/index.md`);
    const { frontmatter, body } = parseSite(file.content);
    expect(frontmatter.url).toBe("https://maps.example.org/roman-battles");
    // The view's fragment is what the identity dropped, and what "open" uses.
    expect(frontmatter.tiro.source_url).toBe(TAB);
    expect(frontmatter.title).toBe("Battles of the Roman Republic");
    expect(frontmatter.description).toBe("An interactive map.");
    // The reader's line breaks are theirs.
    expect(frontmatter.note).toBe("Drag it slowly.\nThen faster.");
    expect(frontmatter.preview).toBe("./assets/54ea819b7af4.webp");
    expect(frontmatter.tiro.clipper_commit).toBe(site.clipperCommit);
    expect(body).toBe("509 BC — 27 BC\n");
  });

  test("an empty note, title or description is left out, not written blank", async () => {
    const file = await buildSiteFile({
      ...site,
      url: "https://maps.example.org/",
      title: " ",
      description: "  ",
      note: " \n ",
      shotId: SHOT.id,
    });
    const { frontmatter } = parseSite(file.content);
    expect(frontmatter.title).toBe("maps.example.org");
    expect("description" in frontmatter).toBe(false);
    expect("note" in frontmatter).toBe(false);
    expect("source_url" in frontmatter.tiro).toBe(false);
  });

  test("refuses a screenshot id that is not a snapshot's", async () => {
    await expect(
      buildSiteFile({ ...site, shotId: "../../x" }),
    ).rejects.toThrow();
  });
});

describe("commitSite", () => {
  test("the page and its screenshot land as one commit, beside the article of the same page", async () => {
    const slug = await slugForUrl(TAB);
    const article = `articles/${slug}/index.md`;
    const gh = fakeGitHub({ [article]: "the article, untouched" });
    const { file, updated } = await commitSite(config, site, SHOT, gh.fetch);
    expect(updated).toBe(false);
    expect(gh.log()).toEqual(["root", "site: Battles of the Roman Republic"]);
    const files = gh.files();
    expect(files.get(article)).toBe("the article, untouched");
    expect(files.get(file.path)).toBe(file.content);
    expect(files.get(`sites/${slug}/assets/54ea819b7af4.webp`)).toStartWith(
      "blob:",
    );
  });

  test("a re-save keeps the site hidden if it was, and says it updated", async () => {
    const slug = await slugForUrl(TAB);
    const gh = fakeGitHub({
      [`sites/${slug}/index.md`]:
        '---\nurl: "https://maps.example.org/roman-battles"\ntitle: Old\ndomain: maps.example.org\nclipped_at: 2026-10-01T00:00:00.000Z\nunlisted: true\ntiro:\n  schema: 1\n---\n',
    });
    const { file, updated } = await commitSite(config, site, SHOT, gh.fetch);
    expect(updated).toBe(true);
    expect(parseSite(file.content).frontmatter.unlisted).toBe(true);
  });

  // A commit landing between the read and the ref update — the processor
  // introducing this very site — makes the save rebuild on the new head.
  test("rebuilds against a head that moved, keeping a flag set meanwhile", async () => {
    const slug = await slugForUrl(TAB);
    const gh = fakeGitHub({});
    let moved = false;
    gh.onBeforePatch = () => {
      if (moved) return;
      moved = true;
      gh.commitDirect({
        [`sites/${slug}/index.md`]:
          '---\nurl: "https://maps.example.org/roman-battles"\ntitle: Old\ndomain: maps.example.org\nclipped_at: 2026-10-01T00:00:00.000Z\nunlisted: true\ntiro:\n  schema: 1\n---\n',
      });
    };
    const { file, updated } = await commitSite(config, site, SHOT, gh.fetch);
    expect(updated).toBe(true);
    expect(parseSite(file.content).frontmatter.unlisted).toBe(true);
  });
});

describe("lookupSite", () => {
  test("finds a saved site's note, to offer it again", async () => {
    const slug = await slugForUrl(TAB);
    const gh = fakeGitHub({
      [`sites/${slug}/index.md`]:
        '---\nurl: "https://maps.example.org/roman-battles"\ntitle: Old\ndomain: maps.example.org\nclipped_at: 2026-10-01T00:00:00.000Z\nnote: "Slowly."\ntiro:\n  schema: 1\n---\n',
    });
    expect(await lookupSite(config, TAB, gh.fetch)).toEqual({
      note: "Slowly.",
    });
  });

  test("no site is null, whatever the article of the page", async () => {
    const slug = await slugForUrl(TAB);
    const gh = fakeGitHub({ [`articles/${slug}/index.md`]: "an article" });
    expect(await lookupSite(config, TAB, gh.fetch)).toBeNull();
  });

  test("a site whose frontmatter cannot be read stops the save", async () => {
    const slug = await slugForUrl(TAB);
    const gh = fakeGitHub({
      [`sites/${slug}/index.md`]: "---\nnote: [unclosed\n---\n",
    });
    await expect(lookupSite(config, TAB, gh.fetch)).rejects.toThrow(
      /cannot read/,
    );
  });
});

describe("commitSite, and a cover that is the site's picture", () => {
  // The processor prunes the old picture once nothing names it, so a cover
  // left naming it would point at a file that is gone after nearly every
  // re-save — a new picture is a new name.
  test("a re-save moves the cover to the new picture, in the same commit", async () => {
    const slug = await slugForUrl(TAB);
    const old = `sites/${slug}/assets/0123456789ab.webp`;
    const gh = fakeGitHub({
      [`sites/${slug}/index.md`]:
        '---\nurl: "https://maps.example.org/roman-battles"\ntitle: Old\ndomain: maps.example.org\nclipped_at: 2026-10-01T00:00:00.000Z\npreview: "./assets/0123456789ab.webp"\ntiro:\n  schema: 1\n---\n',
      [old]: "old picture",
      "collections/maps.md": `---\ntitle: Maps\ncover: "${old}"\nitems:\n  - slug: "sites/${slug}"\ntiro:\n  schema: 1\n---\n`,
      "collections/other.md":
        '---\ntitle: Other\ncover: "articles/a-1234abcd/assets/c.png"\nitems: []\ntiro:\n  schema: 1\n---\n',
    });
    await commitSite(config, site, SHOT, gh.fetch);
    expect(gh.log()).toHaveLength(2);
    const files = gh.files();
    expect(
      parseCollection("maps", files.get("collections/maps.md") ?? "")
        .frontmatter.cover,
    ).toBe(`sites/${slug}/assets/54ea819b7af4.webp`);
    expect(
      parseCollection("other", files.get("collections/other.md") ?? "")
        .frontmatter.cover,
    ).toBe("articles/a-1234abcd/assets/c.png");
    expect(gh.log().at(-1)).toContain("covers moved to the new picture: maps");
  });

  test("the same picture again touches no collection", async () => {
    const slug = await slugForUrl(TAB);
    const same = `sites/${slug}/assets/54ea819b7af4.webp`;
    const collection = `---\ntitle: Maps\ncover: "${same}"\nitems: []\ntiro:\n  schema: 1\n---\n`;
    const gh = fakeGitHub({
      [`sites/${slug}/index.md`]:
        '---\nurl: "https://maps.example.org/roman-battles"\ntitle: Old\ndomain: maps.example.org\nclipped_at: 2026-10-01T00:00:00.000Z\npreview: "./assets/54ea819b7af4.webp"\ntiro:\n  schema: 1\n---\n',
      "collections/maps.md": collection,
    });
    await commitSite(config, site, SHOT, gh.fetch);
    expect(gh.files().get("collections/maps.md")).toBe(collection);
  });
});

describe("samePage", () => {
  // A map writes its view into the address as it is used; that is the same
  // page, and the picture may be filed under the address as it is now.
  test("a moved fragment, a tracking parameter or a trailing slash is the same page", () => {
    const read = "https://maps.example.org/roman-battles";
    expect(samePage(read, `${read}/#year=-216`)).toBe(true);
    expect(samePage(read, `${read}?utm_source=x`)).toBe(true);
  });

  // A redirect or a single-page app's navigation while the popup was open:
  // saving would put one page's title and text under the other's URL.
  test("another path or host is another page", () => {
    const read = "https://maps.example.org/old-page";
    expect(samePage(read, "https://maps.example.org/new-page")).toBe(false);
    expect(samePage(read, "https://other.example.org/old-page")).toBe(false);
    expect(samePage(read, "not a url")).toBe(false);
  });

  // A paper's forms are one identity (ADR 0013), so a body fetched from its
  // HTML full text still matches the tab on its abstract or PDF.
  test("follows the publisher's identity rule", () => {
    expect(
      samePage(
        "https://arxiv.org/html/2404.19756v1",
        "https://arxiv.org/abs/2404.19756",
      ),
    ).toBe(true);
  });
});
