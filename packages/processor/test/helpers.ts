import type { ChatFn, ChatRequest } from "../src/llm/client.ts";

/**
 * Build a structurally valid PDF with one text run per page.
 *
 * Written rather than committed because this repo holds no content (AGENTS.md)
 * and a PDF is a binary besides. A hand-built file also makes the gates
 * testable at their edges — a page count and a text density are exactly what a
 * fixture would have fixed in place.
 */
function wrap(text: string, width: number): string[] {
  if (text === "") return [""];
  // The caller's own newlines are real line breaks — a heading sits on its own
  // line in a PDF exactly as it does here — so they are honoured first and each
  // resulting line is then broken to the page width.
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "") {
      lines.push("");
      continue;
    }
    for (let i = 0; i < line.length; i += width) {
      lines.push(line.slice(i, i + width));
    }
  }
  return lines;
}

export function makePdf(pageTexts: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs[1] = "<</Type/Catalog/Pages 2 0 R>>";
  objs[2] = `<</Type/Pages/Kids[${kids}]/Count ${pageTexts.length}>>`;
  objs[3] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
  pageTexts.forEach((text, i) => {
    const pageNo = 4 + i * 2;
    const contentNo = pageNo + 1;
    objs[pageNo] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${contentNo} 0 R>>`;
    // Wrapped into lines rather than emitted as one run: pdf.js positions
    // glyphs and drops those past the MediaBox edge, so a long single run is
    // silently clipped at the page width — which made a 292-character page
    // extract as 101 and a density test fail for the wrong reason.
    const lines = wrap(text, 70);
    const runs = lines
      .map(
        (line, n) =>
          `${n === 0 ? "" : "0 -14 Td "}(${line.replace(/([()\\])/g, "\\$1")}) Tj `,
      )
      .join("");
    const stream = `BT /F1 12 Tf 72 720 Td ${runs}ET`;
    objs[contentNo] =
      `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i += 1) {
    out += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objs.length}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

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
