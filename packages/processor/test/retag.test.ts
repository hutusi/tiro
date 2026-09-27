import { describe, expect, test } from "bun:test";
import {
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
/** The seven processed fixture articles, none of which meets the policy yet:
 * the vocabulary is `contract` and `rendering`, and no article has three tags
 * with at most two outside it. */
const PROCESSED = 7;

function freshVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "tiro-retag-"));
  cpSync(fixtureVault, dir, { recursive: true });
  return dir;
}

function indexOf(vault: string, slug: string): string {
  return readFileSync(join(vault, "articles", slug, "index.md"), "utf8");
}

function tagsOf(vault: string, slug: string): string[] | undefined {
  return parseArticle(indexOf(vault, slug)).frontmatter.tags;
}

/** A tagging model that always answers `tags`. */
function tagChat(tags: string[] = ["Contract", "rendering", "testing"]): {
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

const quiet = { log: () => {} };

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

    expect(report.retagged).toEqual([
      {
        slug: HELLO,
        before: ["llm", "introduction", "tutorial", "ci/cd"],
        after: ["contract", "rendering", "testing"],
      },
    ]);
    const after = indexOf(vault, HELLO);
    // Everything but the tag list, line for line — so a key that moved, or a
    // value re-quoted, fails here.
    const withoutTags = (text: string) =>
      text.split("\n").filter((line) => !line.startsWith("  - "));
    expect(withoutTags(after)).toEqual(withoutTags(before));
    expect(after).toContain(
      "tags:\n  - contract\n  - rendering\n  - testing\n",
    );
    expect(parseArticle(after).frontmatter.tiro).toEqual(
      parseArticle(before).frontmatter.tiro,
    );
    for (const [slug, text] of others) expect(indexOf(vault, slug)).toBe(text);
  });

  test("holds the reply to the tag policy", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const logs: string[] = [];
    await retagVault(
      vault,
      config,
      { slug: ATTENTION },
      {
        chat: tagChat(["Attention", "注意力", "contract", "a", "b", "c"]).chat,
        log: (m) => logs.push(m),
      },
    );
    // English only, canonical, and two new tags beside the listed one.
    expect(tagsOf(vault, ATTENTION)).toEqual(["attention", "contract", "a"]);
    expect(logs).toContain("dropped non-English tag(s): 注意力");
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
    expect(report.vocabulary).toEqual(["contract", "rendering"]);
    const system =
      requests[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("contract, rendering.");
    expect(requests[0]?.response_format).toEqual({ type: "json_object" });
  });

  test("tags from the source-language summary, with the old tags as hints", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const { chat, requests } = tagChat();
    await retagVault(vault, config, { slug: HELLO }, { ...quiet, chat });
    const user =
      requests[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    const { frontmatter } = parseArticle(indexOf(freshVault(), HELLO));
    expect(user).toContain(frontmatter.summary_orig as string);
    expect(user).toContain("Current tags: llm, introduction, tutorial, ci/cd");
  });

  test("skips pending articles, and ones already meeting the policy", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    await retagVault(
      vault,
      config,
      { slug: ATTENTION },
      {
        ...quiet,
        chat: tagChat().chat,
      },
    );
    const { chat, requests } = tagChat();
    const report = await retagVault(vault, config, {}, { ...quiet, chat });
    expect(report.skipped).toContainEqual({
      slug: PENDING,
      reason: "pending",
    });
    expect(report.skipped).toContainEqual({
      slug: ATTENTION,
      reason: "already-tagged",
    });
    // Every other processed article was asked.
    expect(requests).toHaveLength(PROCESSED - 1);
  });

  test("--force asks about an article that already meets the policy", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    await retagVault(
      vault,
      config,
      { slug: ATTENTION },
      {
        ...quiet,
        chat: tagChat().chat,
      },
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

  test("a dry run makes no call and writes nothing", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const before = indexOf(vault, ATTENTION);
    const report = await retagVault(
      vault,
      config,
      { dryRun: true },
      {
        ...quiet,
        chat: async () => {
          throw new Error("no calls in a dry run");
        },
      },
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

  test("a reply with no usable tags keeps the old ones", async () => {
    const vault = freshVault();
    const config = await loadVaultConfig(vault);
    const report = await retagVault(
      vault,
      config,
      { slug: ATTENTION },
      { ...quiet, chat: tagChat(["注意力"]).chat },
    );
    expect(report.failed).toEqual([
      { slug: ATTENTION, error: "no usable tags in the reply" },
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
