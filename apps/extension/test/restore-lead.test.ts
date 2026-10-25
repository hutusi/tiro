import { describe, expect, test } from "bun:test";
import { parseArticle } from "@tiro/shared";
import type { FetchLike } from "../src/github.ts";
import { restoreLead } from "../src/restore-lead.ts";
import type { TiroExtensionConfig } from "../src/storage.ts";
import { fakeGitHub } from "./fake-github.ts";

const config: TiroExtensionConfig = {
  owner: "o",
  repo: "r",
  branch: "main",
  token: "t",
};
const SLUG = "magazine-example-archive-old-times-a1b2c3d4";
const PATH = `articles/${SLUG}/index.md`;

const DEK =
  "The first installment in a series about the author’s youthful training as a riverboat pilot";
const PICTURE =
  "![](https://cdn.example/media/img/2017/11/River-1/original.jpg)  \nCurrier & Ives / Library of Congress";
const LEAD = `${DEK}\n\n${PICTURE}`;
/** The lead as the popup offers it: from a clip of a page without math. */
const OFFER = { markdown: LEAD, hasMath: false };
const BODY =
  "When I was a boy, there was but one permanent ambition among my comrades in our village.\n\nMy father was a justice of the peace.\n";
const PAGE = `${LEAD}\n\n${BODY}`;

function article(body = BODY): string {
  return `---
url: https://magazine.example/archive/1875/01/old-times/537825
title: Old Times on the River
domain: magazine.example
clipped_at: 2026-10-24T05:13:57.511Z
tiro:
  schema: 1
  processed_at: 2026-10-24T06:10:40.344Z
  processor_version: 0.1.0
lang: en
summary: 一个男孩想当领航员。
category: culture
---

${body}`;
}

describe("restoreLead", () => {
  test("commits the missing lead into the saved article, and nothing else", async () => {
    const gh = fakeGitHub({ [PATH]: article() });
    const outcome = await restoreLead(config, SLUG, OFFER, PAGE, gh.fetch);
    expect(outcome).toEqual({ kind: "added", added: [DEK, PICTURE] });
    const saved = parseArticle(gh.files().get(PATH) ?? "");
    expect(saved.body).toBe(`${LEAD}\n\n${BODY}`);
    expect(saved.frontmatter.tiro.refresh).toBe("translation");
    expect(saved.frontmatter.tiro.processed_at).toBeUndefined();
    expect(gh.log().at(-1)).toBe("lead: Old Times on the River");
  });

  test("writes nothing when the article already has its lead", async () => {
    const gh = fakeGitHub({ [PATH]: article(`${LEAD}\n\n${BODY}`) });
    expect(await restoreLead(config, SLUG, OFFER, PAGE, gh.fetch)).toEqual({
      kind: "unchanged",
    });
    expect(gh.log()).toEqual(["root"]);
  });

  test("says when there is no article to add it to", async () => {
    const gh = fakeGitHub({});
    expect(await restoreLead(config, SLUG, OFFER, PAGE, gh.fetch)).toEqual({
      kind: "absent",
    });
    expect(gh.log()).toEqual(["root"]);
  });

  test("refuses a page that no longer begins where the article does", async () => {
    const gh = fakeGitHub({ [PATH]: article() });
    const stub = `${LEAD}\n\nSubscribe to keep reading this story and every story we publish.`;
    const outcome = await restoreLead(config, SLUG, OFFER, stub, gh.fetch);
    expect(outcome.kind).toBe("refused");
    expect(gh.log()).toEqual(["root"]);
  });

  /** A commit lands between the read and the write: the retry merges
   * against what is there now, so that commit's work survives. */
  function racing(land: (gh: ReturnType<typeof fakeGitHub>) => void) {
    const gh = fakeGitHub({ [PATH]: article() });
    let first = true;
    const fetchImpl: FetchLike = async (input, init) => {
      if (first && init?.method === "PUT") {
        first = false;
        land(gh);
        return new Response(JSON.stringify({ message: "sha" }), {
          status: 409,
        });
      }
      return gh.fetch(input, init);
    };
    return { gh, fetchImpl };
  }

  test("merges again over a commit that landed in between", async () => {
    const { gh, fetchImpl } = racing((gh) =>
      gh.commitDirect({
        [PATH]: article(BODY.replace("justice", "Justice")),
      }),
    );
    const outcome = await restoreLead(config, SLUG, OFFER, PAGE, fetchImpl);
    expect(outcome.kind).toBe("added");
    expect(parseArticle(gh.files().get(PATH) ?? "").body).toBe(
      `${LEAD}\n\n${BODY.replace("justice", "Justice")}`,
    );
  });

  test("stops without writing when that commit already added the lead", async () => {
    const { gh, fetchImpl } = racing((gh) =>
      gh.commitDirect({ [PATH]: article(`${LEAD}\n\n${BODY}`) }, "other"),
    );
    expect(await restoreLead(config, SLUG, OFFER, PAGE, fetchImpl)).toEqual({
      kind: "unchanged",
    });
    expect(gh.log()).toEqual(["root", "other"]);
  });
});
