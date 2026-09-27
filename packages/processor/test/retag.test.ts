import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArticle, stringifyArticle } from "@tiro/shared";
import { createDeadline } from "../src/deadline.ts";
import type { ChatFn, ChatRequest } from "../src/llm/client.ts";
import { loadVaultConfig } from "../src/pipeline.ts";
import { retagVault } from "../src/retag.ts";

const fixtureVault = join(import.meta.dir, "../../../fixtures/vault");

const ATTENTION = "example-net-papers-attention-notes-278b43cb";
const HELLO = "example-com-posts-hello-ai-e8446b12";
const PENDING = "example-org-blog-raw-clip-b5de6fbd";
/** The seven processed fixture articles, none of which is in the vault's form
 * yet: their tags are lowercase English, or fewer than three. */
const PROCESSED = 7;

/**
 * The fixture vault, with the aliases a migration would add first (ADR 0035):
 * `contract` and `rendering` are the undecided tags two articles share, and
 * without a spelling for each `retag` refuses to start. The fixture itself
 * stays as it is — it is a contract test, and English tags are valid.
 */
function freshVault(aliases = true): string {
  const dir = mkdtempSync(join(tmpdir(), "tiro-retag-"));
  cpSync(fixtureVault, dir, { recursive: true });
  if (aliases) {
    appendFileSync(
      join(dir, "config", "tiro.yml"),
      "\ntags:\n  aliases:\n    contract: 契约\n    rendering: 渲染\n",
    );
  }
  return dir;
}

function indexOf(vault: string, slug: string): string {
  return readFileSync(join(vault, "articles", slug, "index.md"), "utf8");
}

function tagsOf(vault: string, slug: string): string[] | undefined {
  return parseArticle(indexOf(vault, slug)).frontmatter.tags;
}

function setTags(vault: string, slug: string, tags: string[]): void {
  const path = join(vault, "articles", slug, "index.md");
  const { frontmatter, body } = parseArticle(readFileSync(path, "utf8"));
  writeFileSync(path, stringifyArticle({ ...frontmatter, tags }, body));
}

/** A tagging model that always answers `tags`. */
function tagChat(tags: string[] = ["Contract", "渲染", "测试"]): {
  chat: ChatFn;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    chat: async (request) => {
      requests.push(request);
      return JSON.stringify({ tags });
    },
    requests,
  };
}

const noCalls: ChatFn = async () => {
  throw new Error("no call expected");
};

const quiet = { log: () => {} };

const messageOf = (request: ChatRequest | undefined, role: string) =>
  request?.messages.find((m) => m.role === role)?.content ?? "";

describe("retagVault", () => {
  test("rewrites the tags line and nothing else", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    // The fixture is hand-written; a vault article was written by the
    // processor, which puts `title_zh` and `summary_orig` after `tags`. Start
    // from that layout — a bilingual article, the kind whose keys a naive
    // rewrite reorders — so the diff measured is the one a real one would show.
    const path = join(vault, "articles", HELLO, "index.md");
    const { frontmatter, body } = parseArticle(readFileSync(path, "utf8"));
    const { title_zh, summary_orig, ...rest } = frontmatter;
    expect(summary_orig).toBeDefined();
    writeFileSync(
      path,
      stringifyArticle(
        {
          ...rest,
          ...(title_zh !== undefined ? { title_zh } : {}),
          summary_orig,
        },
        body,
      ),
    );
    const before = indexOf(vault, HELLO);
    const others = readdirSync(join(vault, "articles"))
      .filter((slug) => slug !== HELLO)
      .map((slug) => [slug, indexOf(vault, slug)] as const);

    const report = await retagVault(
      vault,
      config,
      { slug: HELLO },
      { ...quiet, chat: tagChat().chat },
    );

    // The model's `Contract` is spelled the way the vault's alias spells it.
    expect(report.retagged).toEqual([
      {
        slug: HELLO,
        before: ["llm", "introduction", "tutorial", "ci/cd"],
        after: ["契约", "渲染", "测试"],
      },
    ]);
    const after = indexOf(vault, HELLO);
    // Everything but the tag list, line for line — so a key that moved, or a
    // value re-quoted, fails here.
    const withoutTags = (text: string) =>
      text.split("\n").filter((line) => !line.startsWith("  - "));
    expect(withoutTags(after)).toEqual(withoutTags(before));
    expect(parseArticle(after).frontmatter.tags).toEqual([
      "契约",
      "渲染",
      "测试",
    ]);
    expect(parseArticle(after).frontmatter.tiro).toEqual(
      parseArticle(before).frontmatter.tiro,
    );
    for (const [slug, text] of others) expect(indexOf(vault, slug)).toBe(text);
  });

  test("keeps the article's topics: no cap on new tags, only the limit", async () => {
    // Translating an article's tags makes every one of them new to the
    // vocabulary by spelling; capping them is how a pilot lost an entropy
    // article's `entropy` (ADR 0035).
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const logs: string[] = [];
    await retagVault(
      vault,
      config,
      { slug: ATTENTION },
      {
        chat: tagChat([
          "Attention",
          "注意力",
          "ベクトル",
          "contract",
          "a",
          "b",
          "c",
          "d",
        ]).chat,
        log: (m) => logs.push(m),
      },
    );
    expect(tagsOf(vault, ATTENTION)).toEqual([
      "Attention",
      "注意力",
      "契约",
      "a",
      "b",
      "c",
    ]);
    expect(logs).toContain(
      "dropped tag(s) in neither Chinese nor English: ベクトル",
    );
  });

  test("offers the whole vault's vocabulary to a one-article run", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const { chat, requests } = tagChat();
    const report = await retagVault(
      vault,
      config,
      { slug: ATTENTION },
      { ...quiet, chat },
    );
    expect(report.vocabulary).toEqual(["契约", "渲染", "知识管理"]);
    expect(messageOf(requests[0], "system")).toContain(
      "keeps a tag of its own: 契约, 渲染, 知识管理.",
    );
    expect(requests[0]?.response_format).toEqual({ type: "json_object" });
  });

  test("tags from the Chinese title and summary, with the originals beside them", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const { chat, requests } = tagChat();
    await retagVault(vault, config, { slug: HELLO }, { ...quiet, chat });
    const user = messageOf(requests[0], "user");
    const { frontmatter } = parseArticle(indexOf(freshVault(), HELLO));
    expect(user).toContain(`Title: ${frontmatter.title_zh}`);
    expect(user).toContain(`Original title: ${frontmatter.title}`);
    expect(user).toContain(`Summary:\n${frontmatter.summary}`);
    expect(user).toContain(`Original summary:\n${frontmatter.summary_orig}`);
    expect(user).toContain("Current tags: llm, introduction, tutorial, ci/cd");
    const system = messageOf(requests[0], "system");
    expect(system).toContain("Keep every one of them");
    expect(system).toContain("Never trade a specific topic for a broader one");
    // A run's cap on new tags is not retag's question: told it, the model
    // obeyed it and dropped the Twelve-Factor article's `十二要素`.
    expect(system).not.toContain("at most");
    expect(system).toContain("a topic none of them names keeps a tag");
  });

  test("respells with no call where the aliases alone settle an article", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    setTags(vault, ATTENTION, ["contract", "Rendering", "知识管理"]);
    const before = indexOf(vault, ATTENTION);

    const dry = await retagVault(
      vault,
      config,
      { slug: ATTENTION, dryRun: true },
      { ...quiet, chat: noCalls },
    );
    expect(dry.respelled).toEqual([
      {
        slug: ATTENTION,
        before: ["contract", "Rendering", "知识管理"],
        after: ["契约", "渲染", "知识管理"],
      },
    ]);
    expect(indexOf(vault, ATTENTION)).toBe(before);

    const real = await retagVault(
      vault,
      config,
      { slug: ATTENTION },
      { ...quiet, chat: noCalls },
    );
    expect(real.respelled).toHaveLength(1);
    expect(real.retagged).toEqual([]);
    expect(tagsOf(vault, ATTENTION)).toEqual(["契约", "渲染", "知识管理"]);
  });

  test("a respelling it cannot write is one failure, not the end of the run", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    setTags(vault, ATTENTION, ["contract", "rendering", "知识管理"]);
    const path = join(vault, "articles", ATTENTION, "index.md");
    chmodSync(path, 0o444);
    try {
      const { chat, requests } = tagChat();
      const report = await retagVault(vault, config, {}, { ...quiet, chat });
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0]?.slug).toBe(ATTENTION);
      expect(report.respelled).toEqual([]);
      // Every other article still ran.
      expect(requests).toHaveLength(PROCESSED - 1);
      expect(report.retagged).toHaveLength(PROCESSED - 1);
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test("a second run asks about nothing, and skips pending articles", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const first = await retagVault(
      vault,
      config,
      {},
      { ...quiet, chat: tagChat().chat },
    );
    expect(first.retagged).toHaveLength(PROCESSED);

    const { chat, requests } = tagChat();
    const second = await retagVault(vault, config, {}, { ...quiet, chat });
    expect(requests).toHaveLength(0);
    expect(second.skipped).toContainEqual({ slug: PENDING, reason: "pending" });
    expect(
      second.skipped.filter((s) => s.reason === "already-tagged"),
    ).toHaveLength(PROCESSED);
  });

  test("asks again about a tag the model left in lowercase English", async () => {
    // Undecided until an alias spells it, so the article is not settled.
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    await retagVault(
      vault,
      config,
      { slug: ATTENTION },
      { ...quiet, chat: tagChat(["注意力", "npm", "测试"]).chat },
    );
    const { chat, requests } = tagChat(["注意力", "npm", "测试"]);
    await retagVault(vault, config, { slug: ATTENTION }, { ...quiet, chat });
    expect(requests).toHaveLength(1);
  });

  test("--force asks about an article already in the vault's form", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    await retagVault(
      vault,
      config,
      { slug: ATTENTION },
      { ...quiet, chat: tagChat().chat },
    );
    const { chat, requests } = tagChat();
    const report = await retagVault(
      vault,
      config,
      { slug: ATTENTION, force: true },
      { ...quiet, chat },
    );
    expect(requests).toHaveLength(1);
    expect(report.unchanged).toEqual([ATTENTION]);
  });

  test("refuses while tags two articles share have no spelling", async () => {
    // The fixture's `contract` and `rendering`, with no aliases: retagged
    // against a vocabulary missing them, each article would coin its own
    // translation of each.
    const vault = freshVault(false);
    const config = await loadVaultConfig(vault);
    const before = indexOf(vault, ATTENTION);
    const report = await retagVault(
      vault,
      config,
      {},
      { ...quiet, chat: noCalls },
    );
    expect(report.refused).toBe(true);
    expect(report.undecided).toEqual([
      { tag: "contract", articles: 2 },
      { tag: "rendering", articles: 2 },
    ]);
    expect(indexOf(vault, ATTENTION)).toBe(before);

    // A dry run still shows what it would do.
    const dry = await retagVault(
      vault,
      config,
      { dryRun: true },
      { ...quiet, chat: noCalls },
    );
    expect(dry.refused).toBe(false);
    expect(dry.undecided).toHaveLength(2);
    expect(dry.retagged).toHaveLength(PROCESSED);
  });

  test("a dry run makes no call and writes nothing", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const before = indexOf(vault, ATTENTION);
    const report = await retagVault(
      vault,
      config,
      { dryRun: true },
      { ...quiet, chat: noCalls },
    );
    expect(report.retagged).toHaveLength(PROCESSED);
    expect(report.retagged.every((r) => r.after === null)).toBe(true);
    expect(indexOf(vault, ATTENTION)).toBe(before);
  });

  test("--limit narrows a run and a dry run alike", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const dry = await retagVault(
      vault,
      config,
      { dryRun: true, limit: 2 },
      { ...quiet, chat: tagChat().chat },
    );
    expect(dry.retagged).toHaveLength(2);
    expect(dry.remaining).toHaveLength(PROCESSED - 2);

    const { chat, requests } = tagChat();
    const real = await retagVault(
      vault,
      config,
      { limit: 2 },
      { ...quiet, chat },
    );
    expect(requests).toHaveLength(2);
    expect(real.remaining).toHaveLength(PROCESSED - 2);
  });

  test("a reply with fewer than three usable tags keeps the old ones", async () => {
    // Fewer would take the article off tag pages it was on.
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const none = await retagVault(
      vault,
      config,
      { slug: ATTENTION },
      { ...quiet, chat: tagChat(["ベクトル"]).chat },
    );
    expect(none.failed).toEqual([
      { slug: ATTENTION, error: "no usable tags in the reply" },
    ]);
    const two = await retagVault(
      vault,
      config,
      { slug: ATTENTION },
      { ...quiet, chat: tagChat(["熵", "热力学"]).chat },
    );
    expect(two.failed).toEqual([
      { slug: ATTENTION, error: "only 2 usable tag(s) in the reply" },
    ]);
    expect(tagsOf(vault, ATTENTION)).toEqual([
      "attention",
      "transformers",
      "math",
    ]);
  });

  test("stops after three failures in a row", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    let calls = 0;
    const report = await retagVault(
      vault,
      config,
      {},
      {
        ...quiet,
        chat: async () => {
          calls += 1;
          throw new Error("provider says 503");
        },
      },
    );
    expect(calls).toBe(3);
    expect(report.failed).toHaveLength(3);
    expect(report.remaining).toHaveLength(PROCESSED - 3);
  });

  test("an exhausted budget leaves the rest for a re-run", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const { chat, requests } = tagChat();
    const report = await retagVault(
      vault,
      config,
      {},
      { ...quiet, chat, deadline: createDeadline(0) },
    );
    expect(requests).toHaveLength(0);
    expect(report.remaining).toHaveLength(PROCESSED);
  });

  test("an unreadable article is reported only when it is in scope", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    writeFileSync(
      join(vault, "articles", HELLO, "index.md"),
      "---\nnot: [valid\n---\n",
    );
    const narrowed = await retagVault(
      vault,
      config,
      { slug: ATTENTION },
      { ...quiet, chat: tagChat().chat },
    );
    expect(narrowed.invalid).toEqual([]);
    const whole = await retagVault(
      vault,
      config,
      { dryRun: true },
      { ...quiet, chat: tagChat().chat },
    );
    expect(whole.invalid).toHaveLength(1);
  });
});
