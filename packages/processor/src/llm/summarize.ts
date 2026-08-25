import { splitBlocks } from "@tiro/shared";
import { z } from "zod";
import type { ChatFn, ChatMessage } from "./client.ts";

export interface SummarizeOptions {
  chat: ChatFn;
  model: string;
  categories: readonly string[];
  title: string;
  body: string;
  /** Language the summary should be written in (config.translation.target). */
  targetLang: string;
  maxBodyChars?: number;
  log?: (message: string) => void;
}

export interface SummaryResult {
  summary: string;
  category: string;
  tags: string[];
  /** True when the LLM failed and the excerpt fallback was used. */
  failed: boolean;
}

const ResponseSchema = z.object({
  summary: z.string().min(1),
  category: z.string().min(1),
  tags: z.array(z.string().min(1)).max(8),
});

const MAX_ATTEMPTS = 3;

/**
 * One JSON-mode call producing summary + category + tags. Invalid JSON or an
 * off-taxonomy category is retried with the validation error appended; after
 * MAX_ATTEMPTS the result falls back to a first-paragraph excerpt with
 * `failed: true` so the article still gets processed (and is greppable for a
 * manual `--force` retry).
 *
 * Only *model* failures are handled that way. Transport and HTTP errors from
 * `chat` propagate to the caller, which leaves the article pending (invariant
 * 7) — a 403 or a provider outage is not something a corrective prompt can
 * fix, and burning the retry budget on it would mark every article processed
 * with an excerpt. `translateBlocks` already behaves this way.
 */
export async function summarize(
  options: SummarizeOptions,
): Promise<SummaryResult> {
  const {
    chat,
    model,
    categories,
    title,
    body,
    targetLang,
    maxBodyChars = 30_000,
    log = () => {},
  } = options;
  const truncated =
    body.length > maxBodyChars ? `${body.slice(0, maxBodyChars)}\n…` : body;

  // DashScope's JSON mode rejects requests whose messages don't contain the
  // literal word "JSON", so the word must appear in the prompt.
  const system = [
    "You are a precise reading assistant for a personal knowledge base.",
    "Respond with a single JSON object with exactly these keys:",
    `- "summary": a structured summary written in the language "${targetLang}" — one short paragraph of the article's core argument, then 2-4 key takeaways as sentences.`,
    `- "category": exactly one of: ${categories.join(", ")}.`,
    '- "tags": 3 to 6 short free-form topic tags, lowercase.',
    "Output JSON only, no markdown fences.",
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content: `Title: ${title}\n\nArticle (markdown):\n\n${truncated}`,
    },
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // Outside the try on purpose — see the note above about propagating.
    const raw = await chat({
      model,
      messages,
      response_format: { type: "json_object" },
    });

    let feedback: string;
    try {
      const parsed = ResponseSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        feedback = `Your previous JSON did not match the schema: ${parsed.error.message}`;
      } else if (!categories.includes(parsed.data.category)) {
        feedback = `Your previous "category" (${parsed.data.category}) is not in the allowed list: ${categories.join(", ")}.`;
      } else {
        return { ...parsed.data, failed: false };
      }
    } catch (error) {
      feedback = `Your previous response was not valid JSON: ${String(error).slice(0, 200)}`;
    }
    // Each failed attempt is minutes of LLM time on a long article; without
    // this line the workflow log is silent until the excerpt fallback.
    log(`summary attempt ${attempt}/${MAX_ATTEMPTS} failed: ${feedback}`);
    if (attempt < MAX_ATTEMPTS) {
      // The correction says "your previous response", so that response has to
      // be in the transcript for the reference to resolve to anything.
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `${feedback}\nRespond again with a corrected JSON object.`,
      });
    }
  }

  return {
    summary: excerptFallback(body, title),
    category: fallbackCategory(categories),
    tags: [],
    failed: true,
  };
}

/** "other" is the conventional catch-all, but nothing in the config schema
 * requires a vault to define it. Emitting it unconditionally would write the
 * off-taxonomy category the retry loop above exists to prevent, so fall back
 * to the last configured category instead. */
function fallbackCategory(categories: readonly string[]): string {
  if (categories.includes("other")) return "other";
  return categories[categories.length - 1] ?? "other";
}

/** First paragraph, trimmed. Falls back to the title because a body with no
 * paragraph block (all code, or a single image) would otherwise produce an
 * empty summary — which the frontmatter schema accepts silently. */
function excerptFallback(body: string, title: string): string {
  const firstParagraph = splitBlocks(body).find((b) => b.type === "paragraph");
  const text = (firstParagraph?.text ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return title;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
