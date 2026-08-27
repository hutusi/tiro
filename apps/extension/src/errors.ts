import { GitHubHttpError } from "./github.ts";

/** Popup-facing failure text: what happened and what to do next. The raw
 * error keeps its detail for the console; the user gets an instruction, not
 * a stack trace. Chinese like the site — the popup's one real user reads it. */
export function describeClipError(error: unknown): string {
  if (error instanceof GitHubHttpError) {
    switch (error.status) {
      case 401:
        return "GitHub 令牌无效或已过期，请在设置中更新令牌。";
      case 404:
        return "找不到仓库或分支，请检查设置中的仓库名和分支。";
      case 403:
        return "GitHub 拒绝了请求（403）：令牌权限不足或已触发频率限制，请稍后再试。";
      default:
        return `GitHub 返回了 ${error.status}，请稍后重试。`;
    }
  }
  // fetch signals network failure (offline, DNS, blocked) as a TypeError.
  if (error instanceof TypeError) {
    return "网络错误：无法连接 GitHub，请检查网络后重试。";
  }
  return `剪藏失败：${String(error)}`;
}
