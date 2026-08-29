import { describe, expect, test } from "bun:test";
import { describeClipError } from "../src/errors.ts";
import { GitHubHttpError } from "../src/github.ts";
import { messages } from "../src/i18n.ts";

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
