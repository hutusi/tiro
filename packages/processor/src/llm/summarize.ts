import { splitBlocks } from "@tiro/shared";
import { z } from "zod";
import type { ChatFn, ChatMessage } from "./client.ts";
import {
  acceptableSourceSummary,
  acceptableTitleZh,
  sourceSummaryPromptLine,
  titlePromptLines,
} from "./title.ts";

export interface SummarizeOptions {
  chat: ChatFn;
  model: string;
  categories: readonly string[];
  title: string;
  body: string;
  /** Language the summary should be written in (config.translation.target). */
  targetLang: string;
  /**
   * Ask for the pair as well: the title translated into `targetLang`, and the
   * summary written a second time in the article's own language.
   *
   * False for an article already in the target language. It has no pair — its
   * title needs no translation and `summary` is already in its own language —
   * and a model asked anyway invents one.
   */
  bilingual?: boolean;
  maxBodyChars?: number;
  log?: (message: string) => void;
}

export interface SummaryResult {
  summary: string;
  category: string;
  tags: string[];
  /** The title translated into `targetLang`. Absent unless asked for, and
   * absent when what came back was not a translation — see `acceptableTitleZh`. */
  titleZh?: string;
  /** The summary in the article's own language, the other half of the pair. */
  summaryOrig?: string;
  /** True when the LLM failed and the excerpt fallback was used. */
  failed: boolean;
}

/**
 * `title_zh` and `summary_orig` stay optional **even when the prompt asked for
 * them**, and tightening that would be a mistake worth the comment: a schema
 * failure here is fed back as a correction and, after MAX_ATTEMPTS, drops the
 * article to an excerpt with `summary_failed` — an operator signal meaning
 * "reprocess this one by hand". Requiring them would spend three round trips on
 * a 30 K-char body and cost the article its summary, category and tags because
 * a model omitted a title. A missing half is worth exactly nothing, not that.
 */
const ResponseSchema = z.object({
  summary: z.string().min(1),
  category: z.string().min(1),
  tags: z.array(z.string().min(1)).max(8),
  title_zh: z.string().min(1).optional(),
  summary_orig: z.string().min(1).optional(),
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
    bilingual = false,
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
    ...(bilingual
      ? [...titlePromptLines(targetLang), sourceSummaryPromptLine()]
      : []),
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
        return { ...accept(parsed.data, bilingual, log), failed: false };
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

/**
 * Keep the two halves that survive their guards, and say so in the log when one
 * does not. An omission is not a failure — nothing is marked, and the article
 * simply renders the way it did before the field existed — but a run whose
 * titles are quietly all missing has to be visible in the workflow log rather
 * than only in the vault diff.
 */
function accept(
  data: z.infer<typeof ResponseSchema>,
  bilingual: boolean,
  log: (message: string) => void,
): Omit<SummaryResult, "failed"> {
  const { title_zh, summary_orig, ...rest } = data;
  // Gated on `bilingual` here as well as in the prompt, so a title volunteered
  // for an article that has no source language is discarded in one place and
  // the pipeline's write stays a plain spread.
  if (!bilingual) return rest;
  const titleZh = acceptableTitleZh(title_zh);
  const summaryOrig = acceptableSourceSummary(summary_orig, rest.summary);
  if (titleZh === undefined) {
    log("no usable title translation in the summary reply; leaving it unset");
  }
  if (summaryOrig === undefined) {
    log("no usable source-language summary in the reply; leaving it unset");
  }
  return {
    ...rest,
    ...(titleZh !== undefined ? { titleZh } : {}),
    ...(summaryOrig !== undefined ? { summaryOrig } : {}),
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
