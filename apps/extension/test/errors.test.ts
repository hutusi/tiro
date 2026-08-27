import { describe, expect, test } from "bun:test";
import { describeClipError } from "../src/errors.ts";
import { GitHubHttpError } from "../src/github.ts";

describe("describeClipError", () => {
  test("401 points at the token settings", () => {
    expect(
      describeClipError(new GitHubHttpError(401, "checking p failed: 401")),
    ).toBe("GitHub 令牌无效或已过期，请在设置中更新令牌。");
  });

  test("404 points at the repository settings", () => {
    expect(
      describeClipError(new GitHubHttpError(404, "committing p failed: 404")),
    ).toBe("找不到仓库或分支，请检查设置中的仓库名和分支。");
  });

  test("403 names both permission and rate-limit causes", () => {
    // GitHub uses 403 for both; the message must not send the user to
    // regenerate a token that is merely rate-limited.
    expect(describeClipError(new GitHubHttpError(403, "x"))).toContain("403");
  });

  test("other statuses fall back to a retry message with the status", () => {
    expect(describeClipError(new GitHubHttpError(502, "x"))).toContain("502");
  });

  test("a fetch TypeError reads as a network problem", () => {
    expect(describeClipError(new TypeError("Failed to fetch"))).toContain(
      "网络错误",
    );
  });

  test("an unexpected error keeps its detail", () => {
    // Not everything in the clip path is a GitHub call (frontmatter build,
    // slug derivation); those must not masquerade as network failures.
    expect(describeClipError(new Error("boom"))).toContain("boom");
  });
});
