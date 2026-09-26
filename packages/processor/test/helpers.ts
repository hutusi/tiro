import type { ChatFn, ChatRequest } from "../src/llm/client.ts";

/** Re-exported so the processor's tests keep one import for their helpers,
 * while the builder itself lives beside the extraction it feeds. */
export { makePdf, makeStyledPdf } from "../../shared/test/pdf-fixture.ts";

/**
 * Build a structurally valid PDF with one text run per page.
 *
 * Written rather than committed because this repo holds no content (AGENTS.md)
 * and a PDF is a binary besides. A hand-built file also makes the gates
 * testable at their edges — a page count and a text density are exactly what a
 * fixture would have fixed in place.
 */

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
          // Deliberately not what fakeTranslateBlock would make of a heading
          // ("# X（中文）"), so a test can tell a title that came from the
          // summary call from one the site lifted out of zh.md.
          title_zh: "测试标题（来自摘要）",
          summary_orig: "An English test summary.",
        },
      );
    }
    const user = request.messages.find((m) => m.role === "user")?.content ?? "";
    const system =
      request.messages.find((m) => m.role === "system")?.content ?? "";
    // A faithful restructuring: rejoin the hyphenated line breaks and mark the
    // headings, changing nothing else. Deliberately faithful, so a pipeline
    // test exercising PDFs is not also exercising the fallback path.
    if (system.includes("restore structure to text extracted from a PDF")) {
      return user
        .replace(/-\n/g, "")
        .split("\n")
        .map((line) => (/^Section \d+$/.test(line) ? `## ${line}` : line))
        .join("\n");
    }
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

/** A reply whose headers arrive and whose body then stops: part of the JSON,
 * then the `TypeError` Bun raises for a socket reset mid-body (measured
 * against a real socket: "The socket connection was closed unexpectedly",
 * code ECONNRESET). */
export function droppedReply(status = 200): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":['));
        controller.error(
          new TypeError("The socket connection was closed unexpectedly"),
        );
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}
