import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexPath, parseArticle, slugForUrl } from "@tiro/shared";
import { drainInbox, firstLink } from "../src/inbox.ts";

const fixtureVault = join(import.meta.dir, "../../../fixtures/vault");
const now = () => new Date("2026-09-26T08:00:00.000Z");

function vaultWithInbox(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tiro-inbox-"));
  cpSync(fixtureVault, dir, { recursive: true });
  mkdirSync(join(dir, "inbox"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, "inbox", name), text);
  }
  return dir;
}

const inboxFiles = (vault: string) => readdirSync(join(vault, "inbox")).sort();

describe("firstLink", () => {
  test("takes a file that is only a URL exactly as written", () => {
    for (const url of [
      "https://en.wikipedia.org/wiki/Function_(mathematics)",
      "https://example.net/a.",
      "https://example.net/q?x=[1]",
    ]) {
      expect(firstLink(`  ${url}\n`)).toBe(url);
    }
  });

  test("trims the sentence around a link in prose", () => {
    expect(firstLink("Read https://example.net/essay. Later.")).toBe(
      "https://example.net/essay",
    );
    expect(firstLink("(from https://example.net/post)")).toBe(
      "https://example.net/post",
    );
  });

  test("keeps a bracket the link itself opened, even in prose", () => {
    expect(
      firstLink("(see https://en.wikipedia.org/wiki/Function_(mathematics))."),
    ).toBe("https://en.wikipedia.org/wiki/Function_(mathematics)");
  });

  test("finds nothing where there is no http(s) link", () => {
    expect(firstLink("just words")).toBeNull();
    expect(firstLink("ftp://example.net/file")).toBeNull();
  });
});

describe("drainInbox", () => {
  test("turns a saved link into a stub, and consumes the file", async () => {
    const vault = vaultWithInbox({
      "20260926-080000-1234.url":
        "https://example.net/posts/new-idea?utm_source=ios\n",
    });
    const report = await drainInbox(vault, { now, clipperCommit: "abc1234" });

    const url = "https://example.net/posts/new-idea";
    const slug = await slugForUrl(url);
    expect(report.saved).toEqual([
      { file: "inbox/20260926-080000-1234.url", slug, url },
    ]);
    const { frontmatter, body } = parseArticle(
      readFileSync(join(vault, indexPath(slug)), "utf8"),
    );
    expect(frontmatter.url).toBe(url);
    expect(frontmatter.title).toBe("example.net");
    expect(frontmatter.domain).toBe("example.net");
    expect(frontmatter.clipped_at).toBe("2026-09-26T08:00:00.000Z");
    expect(frontmatter.tiro).toEqual({
      schema: 1,
      clipper_commit: "abc1234",
      capture: "link",
    });
    expect(body).toBe("");
    expect(inboxFiles(vault)).toEqual([]);
  });

  test("reads the link out of text a share sheet put around it", async () => {
    const vault = vaultWithInbox({
      a: "Worth reading: https://example.net/essay?utm_medium=share. Later.",
    });
    const report = await drainInbox(vault, { now });
    expect(report.saved[0]?.url).toBe("https://example.net/essay");
  });

  test("keeps a URL that ends in a bracket of its own", async () => {
    // The shortcut writes the URL alone; trimming it as if it ended a sentence
    // saved a different page under a different slug, and consumed the file.
    const vault = vaultWithInbox({
      a: "https://en.wikipedia.org/wiki/Function_(mathematics)\n",
    });
    const report = await drainInbox(vault, { now });
    expect(report.saved[0]?.url).toBe(
      "https://en.wikipedia.org/wiki/Function_(mathematics)",
    );
  });

  test("files a versioned arXiv link under the paper, and keeps the version to read", async () => {
    // Identity is the paper; the body is the revision that was saved. Without
    // source_url, the link stage asked for the latest one.
    const vault = vaultWithInbox({
      a: "https://arxiv.org/html/2404.19756v1\n",
    });
    const report = await drainInbox(vault, { now });
    expect(report.saved[0]?.url).toBe("https://arxiv.org/abs/2404.19756");
    const { frontmatter } = parseArticle(
      readFileSync(join(vault, indexPath(report.saved[0]?.slug ?? "")), "utf8"),
    );
    expect(frontmatter.tiro.source_url).toBe(
      "https://arxiv.org/html/2404.19756v1",
    );
  });

  test("an ordinary link records no separate source", async () => {
    const vault = vaultWithInbox({
      a: "https://example.net/post?utm_source=x",
    });
    const report = await drainInbox(vault, { now });
    const { frontmatter } = parseArticle(
      readFileSync(join(vault, indexPath(report.saved[0]?.slug ?? "")), "utf8"),
    );
    expect(frontmatter.tiro.source_url).toBeUndefined();
  });

  test("never overwrites an article that is already there", async () => {
    // A browser clip is always the better body; saving its URL again from a
    // phone must not replace it with a stub.
    const vault = vaultWithInbox({
      a: "https://example.com/posts/hello-ai",
    });
    const slug = "example-com-posts-hello-ai-e8446b12";
    const before = readFileSync(join(vault, indexPath(slug)), "utf8");
    const report = await drainInbox(vault, { now });
    expect(report.existing).toEqual([{ file: "inbox/a", slug }]);
    expect(report.saved).toEqual([]);
    expect(readFileSync(join(vault, indexPath(slug)), "utf8")).toBe(before);
    expect(inboxFiles(vault)).toEqual([]);
  });

  test("the same link saved twice becomes one article", async () => {
    const vault = vaultWithInbox({
      a: "https://example.net/twice",
      b: "https://example.net/twice/?utm_source=x",
    });
    const report = await drainInbox(vault, { now });
    expect(report.saved).toHaveLength(1);
    expect(report.existing).toHaveLength(1);
    expect(inboxFiles(vault)).toEqual([]);
  });

  test("rejects, and consumes, a file with no usable link", async () => {
    const vault = vaultWithInbox({
      a: "just some words",
      b: "ftp://example.net/file",
      c: "x".repeat(70 * 1024),
    });
    const report = await drainInbox(vault, { now });
    expect(report.rejected.map((r) => r.file)).toEqual([
      "inbox/a",
      "inbox/b",
      "inbox/c",
    ]);
    expect(report.rejected[2]?.reason).toContain("more than a saved link");
    expect(inboxFiles(vault)).toEqual([]);
  });

  test("leaves dotfiles alone", async () => {
    // Finder litters a local clone with them; they are nobody's save.
    const vault = vaultWithInbox({ ".DS_Store": "junk" });
    const report = await drainInbox(vault, { now });
    expect(report).toEqual({ saved: [], existing: [], rejected: [] });
    expect(inboxFiles(vault)).toEqual([".DS_Store"]);
  });

  test("a dry run reports and changes nothing", async () => {
    const vault = vaultWithInbox({
      a: "https://example.net/dry",
      b: "no link",
    });
    const report = await drainInbox(vault, { now, dryRun: true });
    expect(report.saved).toHaveLength(1);
    expect(report.rejected).toHaveLength(1);
    expect(inboxFiles(vault)).toEqual(["a", "b"]);
    const slug = await slugForUrl("https://example.net/dry");
    expect(existsSync(join(vault, indexPath(slug)))).toBe(false);
  });

  test("a vault with no inbox has nothing to drain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tiro-inbox-"));
    cpSync(fixtureVault, dir, { recursive: true });
    expect(await drainInbox(dir, { now })).toEqual({
      saved: [],
      existing: [],
      rejected: [],
    });
  });
});
