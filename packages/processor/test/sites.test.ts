import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  needsProcessing,
  parseSite,
  type SiteFrontmatter,
  slugForUrl,
  stringifySite,
} from "@tiro/shared";
import { createDeadline } from "../src/deadline.ts";
import { discoverSites } from "../src/discover.ts";
import {
  ChatConnectionError,
  type ChatFn,
  type ChatRequest,
  type FetchLike,
} from "../src/llm/client.ts";
import { summarize } from "../src/llm/summarize.ts";
import { loadVaultConfig, runPipeline } from "../src/pipeline.ts";
import { validateVault } from "../src/validate.ts";
import { makeFakeChat } from "./helpers.ts";

/** ADR 0055: saved sites, through the processor and `validate`. */

const fixtureVault = join(import.meta.dir, "../../../fixtures/vault");
const FIXTURE_SITE = "maps-example-org-roman-battles-facc4f75";
const PREVIEW = "54ea819b7af4.webp";
const OLD_PREVIEW = "0123456789ab.webp";

const offlineFetch: FetchLike = async () =>
  new Response("offline", { status: 404 });

function freshVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "tiro-sites-"));
  cpSync(fixtureVault, dir, { recursive: true });
  return dir;
}

const deps = {
  chat: makeFakeChat(),
  fetchImpl: offlineFetch,
  resolveHost: async () => ["93.184.216.34"],
  now: () => new Date("2026-10-26T12:00:00.000Z"),
  log: () => {},
};

/** A site as the extension saves it: no processor fields, no marker. */
async function savePendingSite(
  vault: string,
  url: string,
  fields: Partial<SiteFrontmatter> = {},
  body = "Drag the timeline.",
): Promise<{ slug: string; dir: string }> {
  const slug = await slugForUrl(url);
  const dir = join(vault, "sites", slug);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", PREVIEW), "webp bytes");
  writeFileSync(
    join(dir, "index.md"),
    stringifySite(
      {
        url,
        title: "Battles of the Roman Republic",
        domain: new URL(url).hostname,
        clipped_at: "2026-10-26T10:00:00.000Z",
        description: "An interactive map of Rome's battles.",
        preview: `./assets/${PREVIEW}`,
        tiro: { schema: 1, clipper_version: "0.19.0" },
        ...fields,
      },
      body,
    ),
  );
  return { slug, dir };
}

function readSite(dir: string) {
  return parseSite(readFileSync(join(dir, "index.md"), "utf8"));
}

/** The JSON-mode requests a chat saw, as the model read them. */
function recording(chat: ChatFn = makeFakeChat()): {
  chat: ChatFn;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    chat: async (request) => {
      requests.push(request);
      return chat(request);
    },
    requests,
  };
}

describe("processing a saved site", () => {
  test("introduces it, tags it, and marks it processed — and nothing else", async () => {
    const vault = freshVault();
    const { slug, dir } = await savePendingSite(
      vault,
      "https://maps.example.net/rome/",
      { note: "Drag it slowly." },
    );
    // A screenshot from an earlier save: the processor's own name shape, and
    // nothing names it any more.
    writeFileSync(join(dir, "assets", OLD_PREVIEW), "old");
    const { chat, requests } = recording();
    const config = await loadVaultConfig(vault);
    const report = await runPipeline({ vaultDir: vault }, config, {
      ...deps,
      chat,
    });

    expect(report.errored).toEqual([]);
    expect(report.processed).toContain(`sites/${slug}`);
    const { frontmatter, body } = readSite(dir);
    expect(needsProcessing(frontmatter)).toBe(false);
    expect(frontmatter.summary).toContain("测试摘要");
    expect(frontmatter.tags).toEqual(["test", "fixture"]);
    expect(frontmatter.lang).toBe("en");
    expect(frontmatter.title_zh).toBe("测试标题（来自摘要）");
    // Never a source-language summary: the description is that half.
    expect("summary_orig" in frontmatter).toBe(false);
    // What the owner and the extension wrote survives the write.
    expect(frontmatter.note).toBe("Drag it slowly.");
    expect(frontmatter.preview).toBe(`./assets/${PREVIEW}`);
    expect(frontmatter.description).toBe(
      "An interactive map of Rome's battles.",
    );
    expect(body).toBe("Drag the timeline.\n");

    // No translation, no downloads: one call, the summary's.
    expect(existsSync(join(dir, "zh.md"))).toBe(false);
    const siteRequests = requests.filter((request) =>
      request.messages.some((m) => m.content.includes("maps.example.net")),
    );
    expect(siteRequests).toHaveLength(1);

    // The screenshot it names is kept; the one nothing names is pruned.
    expect(existsSync(join(dir, "assets", PREVIEW))).toBe(true);
    expect(existsSync(join(dir, "assets", OLD_PREVIEW))).toBe(false);
    rmSync(vault, { recursive: true, force: true });
  });

  test("tells the model what the page and the owner say about it", async () => {
    const vault = freshVault();
    await savePendingSite(
      vault,
      "https://maps.example.net/rome/",
      { note: "为了看战线如何推进。" },
      "",
    );
    const { chat, requests } = recording();
    await runPipeline({ vaultDir: vault }, await loadVaultConfig(vault), {
      ...deps,
      chat,
    });
    const [request] = requests.filter(
      (r) => r.response_format?.type === "json_object",
    );
    const system = request?.messages[0]?.content ?? "";
    const user = request?.messages[1]?.content ?? "";
    expect(system).toContain("introduction to this website");
    expect(system).not.toContain("summary_orig");
    expect(user).toContain("Website: https://maps.example.net/rome");
    expect(user).toContain(
      "The page describes itself as: An interactive map of Rome's battles.",
    );
    expect(user).toContain("Why the owner saved it: 为了看战线如何推进。");
    expect(user).toContain("no readable text");
    rmSync(vault, { recursive: true, force: true });
  });

  // The note is in the owner's language, not the site's. Counted, a Chinese
  // note would make an English site "zh" and leave it without a title_zh.
  test("reads the language from the page, never from the note", async () => {
    const vault = freshVault();
    const english = await savePendingSite(
      vault,
      "https://maps.example.net/rome/",
      { note: "这个地图做得很好，适合给学生看罗马的历史和战争的过程。" },
      "",
    );
    const chinese = await savePendingSite(
      vault,
      "https://ditu.example.cn/",
      {
        title: "中国历代疆域地图",
        description: "一张可以拖动时间轴的中国历代疆域变化地图。",
      },
      "",
    );
    await runPipeline({ vaultDir: vault }, await loadVaultConfig(vault), deps);
    const en = readSite(english.dir).frontmatter;
    expect(en.lang).toBe("en");
    expect(en.title_zh).toBe("测试标题（来自摘要）");
    // An empty body alone reads as English; the title and description say
    // otherwise, so no title is "translated" into the language it is in.
    const zh = readSite(chinese.dir).frontmatter;
    expect(zh.lang).toBe("zh");
    expect(zh.title_zh).toBeUndefined();
    rmSync(vault, { recursive: true, force: true });
  });

  test("a failed call leaves the site pending with its screenshot", async () => {
    const vault = freshVault();
    const { slug, dir } = await savePendingSite(
      vault,
      "https://maps.example.net/rome/",
    );
    const before = readFileSync(join(dir, "index.md"), "utf8");
    const down: ChatFn = async () => {
      throw new ChatConnectionError(new TypeError("connection refused"));
    };
    const report = await runPipeline(
      { vaultDir: vault, slug: `sites/${slug}` },
      await loadVaultConfig(vault),
      { ...deps, chat: down },
    );
    expect(report.errored.map((e) => e.slug)).toEqual([`sites/${slug}`]);
    expect(report.errored[0]?.staysPending).toBe(true);
    expect(readFileSync(join(dir, "index.md"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "assets", PREVIEW))).toBe(true);
    rmSync(vault, { recursive: true, force: true });
  });

  test("a site runs before the articles, and leaves them to the budget", async () => {
    const vault = freshVault();
    const { slug } = await savePendingSite(
      vault,
      "https://maps.example.net/rome/",
    );
    const order: string[] = [];
    const report = await runPipeline(
      { vaultDir: vault },
      await loadVaultConfig(vault),
      {
        ...deps,
        log: (line) => {
          if (line.startsWith("processing ")) order.push(line.slice(11));
        },
      },
    );
    expect(order[0]).toBe(`sites/${slug}`);
    expect(report.processed).toContain("example-org-blog-raw-clip-b5de6fbd");
    rmSync(vault, { recursive: true, force: true });
  });

  test("a forced site the budget defers is returned to pending", async () => {
    const vault = freshVault();
    const dir = join(vault, "sites", FIXTURE_SITE);
    const report = await runPipeline(
      { vaultDir: vault, slug: `sites/${FIXTURE_SITE}`, force: true },
      await loadVaultConfig(vault),
      {
        ...deps,
        deadline: createDeadline(0),
      },
    );
    expect(report.skipped).toEqual([`sites/${FIXTURE_SITE}`]);
    const { frontmatter } = readSite(dir);
    expect(needsProcessing(frontmatter)).toBe(true);
    // Everything else stays, so the site keeps rendering until a run redoes it.
    expect(frontmatter.summary).toContain("罗马共和国");
    expect(frontmatter.note).toBeDefined();
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("a failed forced rerun of a site", () => {
  // The reply is unusable, so the fallback is the page's description: English,
  // longer than the two-sentence introduction, and ending like a sentence —
  // so length and punctuation alone would have let it win.
  test("keeps the introduction and the translated title it already had", async () => {
    const vault = freshVault();
    const dir = join(vault, "sites", FIXTURE_SITE);
    const before = readSite(dir).frontmatter;
    const report = await runPipeline(
      { vaultDir: vault, slug: `sites/${FIXTURE_SITE}`, force: true },
      await loadVaultConfig(vault),
      { ...deps, chat: async () => "not json" },
    );
    expect(report.summaryFailed).toEqual([`sites/${FIXTURE_SITE}`]);
    const after = readSite(dir).frontmatter;
    expect(after.summary).toBe(before.summary);
    expect(after.title_zh).toBe(before.title_zh);
    expect(after.tags).toEqual(before.tags);
    expect(after.tiro.summary_failed).toBe(true);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("discoverSites", () => {
  test("no sites directory is no sites", async () => {
    const vault = freshVault();
    rmSync(join(vault, "sites"), { recursive: true, force: true });
    expect(await discoverSites(vault)).toEqual({
      pending: [],
      invalid: [],
      tagLists: [],
    });
    rmSync(vault, { recursive: true, force: true });
  });

  test("a bare slug matches the site; sites/<slug> matches only it", async () => {
    const vault = freshVault();
    const force = { force: true };
    expect(
      (await discoverSites(vault, { ...force, slug: FIXTURE_SITE })).pending,
    ).toHaveLength(1);
    expect(
      (
        await discoverSites(vault, {
          ...force,
          slug: `sites/${FIXTURE_SITE}`,
        })
      ).pending.map((site) => site.ref),
    ).toEqual([`sites/${FIXTURE_SITE}`]);
    expect(
      (await discoverSites(vault, { ...force, slug: "other" })).pending,
    ).toEqual([]);
    // The vocabulary is the whole vault's, whatever the run is narrowed to.
    expect(
      (await discoverSites(vault, { ...force, slug: "other" })).tagLists,
    ).toEqual([["可视化", "rendering"]]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("a site that does not parse is reported, not thrown", async () => {
    const vault = freshVault();
    mkdirSync(join(vault, "sites", "broken-1234abcd"), { recursive: true });
    writeFileSync(
      join(vault, "sites", "broken-1234abcd", "index.md"),
      "---\ntitle: x\n---\n",
    );
    const { invalid } = await discoverSites(vault);
    expect(invalid.map((bad) => bad.path)).toEqual([
      join(vault, "sites", "broken-1234abcd", "index.md"),
    ]);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("summarize, for a site", () => {
  const options = {
    model: "test-model",
    categories: ["tech", "culture", "other"],
    title: "Battles of the Roman Republic",
    body: "509 BC",
    targetLang: "zh",
    cjkThreshold: 0.3,
    site: {
      url: "https://maps.example.org/roman-battles",
      description: "An interactive map of the battles Rome fought.",
    },
  };

  test("falls back to the page's description, not its text", async () => {
    const result = await summarize({
      ...options,
      chat: async () => "not json",
    });
    expect(result.failed).toBe(true);
    expect(result.fromExcerpt).toBe(true);
    expect(result.summary).toBe(
      "An interactive map of the battles Rome fought.",
    );
  });

  test("a long description is cut, and says so", async () => {
    const result = await summarize({
      ...options,
      site: { ...options.site, description: "x".repeat(400) },
      chat: async () => "not json",
    });
    expect(result.summary).toBe(`${"x".repeat(300)}…`);
  });

  test("never keeps a source-language summary a site did not ask for", async () => {
    const result = await summarize({
      ...options,
      bilingual: true,
      chat: async () =>
        JSON.stringify({
          summary: "一张罗马战役地图。",
          category: "culture",
          tags: [],
          title_zh: "罗马共和国的战役",
          summary_orig: "A map of Roman battles.",
        }),
    });
    expect(result.titleZh).toBe("罗马共和国的战役");
    expect(result.summaryOrig).toBeUndefined();
  });
});

describe("validateVault, for sites", () => {
  test("accepts the fixture site and its collection membership", async () => {
    const vault = freshVault();
    const report = await validateVault(vault);
    expect(report.errors).toEqual([]);
    expect(report.sites).toBe(1);
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a missing screenshot", async () => {
    const vault = freshVault();
    rmSync(join(vault, "sites", FIXTURE_SITE, "assets", PREVIEW));
    expect((await validateVault(vault)).errors).toEqual([
      `sites/${FIXTURE_SITE}/index.md: preview ./assets/${PREVIEW} does not exist`,
    ]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a translation, which a site never has", async () => {
    const vault = freshVault();
    writeFileSync(join(vault, "sites", FIXTURE_SITE, "zh.md"), "中文\n");
    expect((await validateVault(vault)).errors).toEqual([
      `sites/${FIXTURE_SITE}/zh.md: a site is never translated, so it has no zh.md`,
    ]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a site filed under another URL's slug", async () => {
    const vault = freshVault();
    const path = join(vault, "sites", FIXTURE_SITE, "index.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        'url: "https://maps.example.org/roman-battles"',
        'url: "https://maps.example.org/elsewhere"',
      ),
    );
    const expected = await slugForUrl("https://maps.example.org/elsewhere");
    expect((await validateVault(vault)).errors).toEqual([
      `sites/${FIXTURE_SITE}/index.md: slug does not match url (expected ${expected})`,
    ]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("catches a collection naming a site that is not there", async () => {
    const vault = freshVault();
    rmSync(join(vault, "sites", FIXTURE_SITE), { recursive: true });
    expect((await validateVault(vault)).errors).toEqual([
      `collections/field-guide.md: sites/${FIXTURE_SITE} is not a site in this vault`,
    ]);
    rmSync(vault, { recursive: true, force: true });
  });

  // The article of the same URL is a different document: a site member is
  // not satisfied by it, and a site cover is checked against the site.
  test("does not take the article of the same slug for the site", async () => {
    const vault = freshVault();
    const path = join(vault, "collections", "favorites.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "items:\n",
        `items:\n  - slug: "sites/example-com-posts-hello-ai-e8446b12"\n`,
      ),
    );
    expect((await validateVault(vault)).errors).toEqual([
      "collections/favorites.md: sites/example-com-posts-hello-ai-e8446b12 is not a site in this vault",
    ]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("accepts a site's screenshot as a collection cover", async () => {
    const vault = freshVault();
    const path = join(vault, "collections", "field-guide.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        /cover: ".*"/,
        `cover: "sites/${FIXTURE_SITE}/assets/${PREVIEW}"`,
      ),
    );
    expect((await validateVault(vault)).errors).toEqual([]);
    rmSync(vault, { recursive: true, force: true });
  });
});
