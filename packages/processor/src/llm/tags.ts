import { z } from "zod";
import { MAX_NEW_TAGS } from "../tag-policy.ts";
import type { ChatFn, ChatMessage } from "./client.ts";

/**
 * How the model is asked for tags (ADR 0033), in one place so the summary
 * call and `retag` ask the same question: a retagged article should carry the
 * tags a fresh run would give it.
 */
export function tagPromptLines(vocabulary: readonly string[]): string[] {
  return [
    '- "tags": 3 to 6 short topic tags, in English even when the article is not — lowercase, words separated by spaces, a proper noun by its usual English name.',
    ...(vocabulary.length > 0
      ? [
          `  The vault already uses these tags. Reuse one whenever it fits; coin a new tag only for a central topic none of them covers, at most ${MAX_NEW_TAGS} new ones: ${vocabulary.join(", ")}.`,
        ]
      : []),
  ];
}

const TagsResponseSchema = z.object({ tags: z.array(z.string()) });

const MAX_ATTEMPTS = 2;

export interface SuggestTagsOptions {
  chat: ChatFn;
  model: string;
  title: string;
  /** The article's summary — its own language's if it has one. Tags are about
   * what an article covers, which the summary states in a paragraph; sending
   * the body would cost a full summary call per article to learn the same. */
  summary: string;
  /** Offered as hints, not kept by right: an old tag survives if it is a good
   * tag by the rules the model is given. */
  currentTags: readonly string[];
  vocabulary: readonly string[];
  log?: (message: string) => void;
}

/**
 * Ask for an already-processed article's tags again, from its title and
 * summary. Returns the model's tags as offered — the caller holds them to the
 * tag policy — or null when no reply was usable. Transport and HTTP errors
 * propagate, as they do from `summarize`.
 */
export async function suggestTags(
  options: SuggestTagsOptions,
): Promise<string[] | null> {
  const {
    chat,
    model,
    title,
    summary,
    currentTags,
    vocabulary,
    log = () => {},
  } = options;
  // DashScope's JSON mode rejects a request whose messages lack the word
  // "JSON", so it must appear in the prompt.
  const system = [
    "You tag articles for a personal knowledge base.",
    "Respond with a single JSON object with exactly one key:",
    ...tagPromptLines(vocabulary),
    "The article's current tags are hints: keep one only if it is a good tag by these rules.",
    "Output JSON only, no markdown fences.",
  ].join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        `Title: ${title}`,
        "",
        "Summary:",
        summary,
        "",
        `Current tags: ${currentTags.length > 0 ? currentTags.join(", ") : "(none)"}`,
      ].join("\n"),
    },
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const raw = await chat({
      model,
      messages,
      response_format: { type: "json_object" },
    });
    let feedback: string;
    try {
      const parsed = TagsResponseSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data.tags;
      feedback = `Your previous JSON did not match the schema: ${parsed.error.message}`;
    } catch (error) {
      feedback = `Your previous response was not valid JSON: ${String(error).slice(0, 200)}`;
    }
    log(`tags attempt ${attempt}/${MAX_ATTEMPTS} failed: ${feedback}`);
    if (attempt < MAX_ATTEMPTS) {
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `${feedback}\nRespond again with a corrected JSON object.`,
      });
    }
  }
  return null;
}
