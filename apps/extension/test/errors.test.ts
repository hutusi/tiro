import { describe, expect, test } from "bun:test";
import {
  describeClipError,
  describeFlushError,
  describeRemoveError,
} from "../src/errors.ts";
import { GitHubHttpError } from "../src/github.ts";
import { messages } from "../src/i18n.ts";
import { UnreadableCollectionError } from "../src/remove-article.ts";

const zh = messages("zh");

describe("describeClipError", () => {
  test("401 points at the token settings", () => {
    expect(
      describeClipError(new GitHubHttpError(401, "checking p failed: 401"), zh),
    ).toBe("GitHub 令牌无效或已过期，请在设置中更新令牌。");
  });

  test("speaks the requested locale", () => {
    expect(
      describeClipError(new GitHubHttpError(401, "x"), messages("en")),
    ).toContain("token");
  });

  test("404 points at the repository settings and token access", () => {
    // GitHub answers 404 for a private repo the token cannot access, so the
    // message must name that cause too — the vault is private.
    const message = describeClipError(
      new GitHubHttpError(404, "committing p failed: 404"),
      zh,
    );
    expect(message).toContain("仓库名");
    expect(message).toContain("令牌");
    expect(message).toContain("私有仓库");
  });

  test("403 names both permission and rate-limit causes", () => {
    // GitHub uses 403 for both; the message must not send the user to
    // regenerate a token that is merely rate-limited.
    const message = describeClipError(new GitHubHttpError(403, "x"), zh);
    expect(message).toContain("403");
    expect(message).toContain("权限不足");
    expect(message).toContain("频率限制");
  });

  test("other statuses fall back to a retry message with the status", () => {
    expect(describeClipError(new GitHubHttpError(502, "x"), zh)).toContain(
      "502",
    );
  });

  test("a fetch TypeError reads as a network problem", () => {
    expect(describeClipError(new TypeError("Failed to fetch"), zh)).toContain(
      "网络错误",
    );
  });

  test("a branch that kept moving says to try again, not that GitHub failed", () => {
    expect(
      describeClipError(
        new GitHubHttpError(409, "main kept moving — gave up after 3 attempts"),
        zh,
      ),
    ).toBe(zh.errClipBusy);
  });

  test("an unexpected error keeps its detail", () => {
    // Not everything in the clip path is a GitHub call (frontmatter build,
    // slug derivation); those must not masquerade as network failures.
    expect(describeClipError(new Error("boom"), zh)).toContain("boom");
  });

  test("a TypeError from a plain bug is not called a network failure", () => {
    // TypeError is also the classic programming-bug exception; only fetch's
    // "Failed to fetch" means connectivity.
    const message = describeClipError(new TypeError("x is not a function"), zh);
    expect(message).not.toContain("网络错误");
    expect(message).toContain("x is not a function");
  });

  test("a near-match of fetch's message is not called a network failure", () => {
    // Chromium's network failure is exactly "Failed to fetch"; a message
    // that merely starts with it came from somewhere else.
    const message = describeClipError(
      new TypeError("Failed to fetch metadata"),
      zh,
    );
    expect(message).not.toContain("网络错误");
    expect(message).toContain("Failed to fetch metadata");
  });
});

describe("describeRemoveError", () => {
  const en = messages("en");

  test("a GitHub or network failure reads as it would for a clip", () => {
    for (const error of [
      new GitHubHttpError(401, "x"),
      new GitHubHttpError(404, "x"),
      new GitHubHttpError(403, "x"),
      new TypeError("Failed to fetch"),
    ]) {
      expect(describeRemoveError(error, zh)).toBe(describeClipError(error, zh));
    }
  });

  test("a collection it cannot read names the file and says nothing was removed", () => {
    const message = describeRemoveError(
      new UnreadableCollectionError("collections/reading.md", new Error("bad")),
      en,
    );
    expect(message).toContain("collections/reading.md");
    expect(message).toContain("nothing was removed");
  });

  test("a branch that kept moving is a retry, not a token problem", () => {
    const message = describeRemoveError(
      new GitHubHttpError(409, "main kept moving — gave up after 3 attempts"),
      en,
    );
    expect(message).toBe(en.errRemoveBusy);
  });

  test("anything else keeps its detail, as a failed removal rather than a clip", () => {
    const message = describeRemoveError(new Error("boom"), en);
    expect(message).toContain("boom");
    expect(message).toContain("remove");
    expect(message).not.toContain("Clip");
  });
});

describe("describeFlushError", () => {
  test("a flush the branch kept refusing is not told to press Clip", () => {
    // The clip's busy sentence names its button; a collection flush has none.
    const en = messages("en");
    const text = describeFlushError(
      { error: "main kept moving — gave up after 3 attempts", httpStatus: 409 },
      en,
    );
    expect(text).toBe(en.errHttp(409));
  });

  test("a bad token reads as it does for a clip", () => {
    expect(describeFlushError({ httpStatus: 401 }, zh)).toBe(
      zh.errTokenInvalid,
    );
    expect(describeFlushError({ error: "Failed to fetch" }, zh)).toBe(
      zh.errNetwork,
    );
  });
});
