import type { ChatFn, ChatRequest } from "../src/llm/client.ts";

const MARKER_RE = /<<<TIRO_BLOCK_(\d+)>>>\n?/g;

/** Deterministic per-block "translation" that preserves markdown structure. */
export function fakeTranslateBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("#")) return `${line}（中文）`;
      if (/^(\||-|\d+\.|>)/.test(line.trim())) return line;
      if (line.trim() === "") return line;
      return `中文：${line}`;
    })
    .join("\n");
}

/**
 * A ChatFn standing in for a well-behaved LLM: JSON-mode requests get a valid
 * summary object; batch translation requests get marker-preserving
 * translations; single-block requests get one translated block.
 */
export function makeFakeChat(overrides?: {
  summary?: Record<string, unknown>;
  onRequest?: (request: ChatRequest) => void;
}): ChatFn {
  return async (request) => {
    overrides?.onRequest?.(request);
    if (request.response_format?.type === "json_object") {
      return JSON.stringify(
        overrides?.summary ?? {
          summary: "这是一段测试摘要。要点一。要点二。",
          category: "ai",
          tags: ["test", "fixture"],
        },
      );
    }
    const user = request.messages.find((m) => m.role === "user")?.content ?? "";
    if (user.includes("<<<TIRO_BLOCK_")) {
      const matches = [...user.matchAll(MARKER_RE)];
      return matches
        .map((match, i) => {
          const start = (match.index ?? 0) + match[0].length;
          const end = matches[i + 1]?.index ?? user.length;
          return `<<<TIRO_BLOCK_${match[1]}>>>\n${fakeTranslateBlock(user.slice(start, end).trim())}`;
        })
        .join("\n");
    }
    return fakeTranslateBlock(user);
  };
}
