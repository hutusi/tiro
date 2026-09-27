import { z } from "zod";
import { MAX_NEW_TAGS } from "../tag-policy.ts";
import type { ChatFn, ChatMessage } from "./client.ts";

/**
 * How the model is asked for tags (ADR 0033, ADR 0035), in one place so the
 * summary call and `retag` ask the same question: a retagged article should
 * carry the tags a fresh run would give it.
 *
 * Chinese first, with the owner's own examples, since which terms Chinese
 * writing keeps in English is a judgment the rule alone does not make. Most
 * central first, because the cap on new tags and `TAG_LIMIT` keep the head of
 * the list: asked in no order, the model once led with `mathematics` and
 * `physics` and an article on entropy lost `entropy`.
 *
 * `translating` is retag's question, which differs in one line. A run coins
 * tags and is told the cap on new ones; a retag keeps topics an article
 * already has, and told the same cap, the model obeyed it — a pilot traded
 * `十二要素` for `软件架构` on the Twelve-Factor article, and Pull Request
 * for `工作流`.
 *
 * `current` is a run's version of the same lesson. Reprocessing an article
 * never counts the tags it already carries against the cap (`writableTags`),
 * but a model that is not shown them, and is told the cap, drops them before
 * that exemption can apply — so a run that has them says so.
 */
export function tagPromptLines(
  vocabulary: readonly string[],
  {
    translating = false,
    current = [],
  }: { translating?: boolean; current?: readonly string[] } = {},
): string[] {
  return [
    '- "tags": 3 to 6 short topic tags, the most central topic first. Write them in Simplified Chinese — 强化学习 rather than reinforcement learning, 软件工程, 熵 — keeping English where Chinese technical writing keeps it or its Chinese word is less precise: acronyms and the names of people, companies, products and projects in their usual case (AI rather than 人工智能, LLM, Git, OpenAI, Bill Gates), and terms such as Safety and Security (both 安全 in Chinese), Alignment and Agent, in Title Case. A tag may mix the two, with no space where Chinese meets English (AI编程); English words are separated by spaces (AI Safety).',
    ...(vocabulary.length === 0
      ? []
      : translating
        ? [
            `  The vault already uses these tags. Where one names the same topic as a current tag, use it exactly as written; a topic none of them names keeps a tag of its own: ${vocabulary.join(", ")}.`,
          ]
        : [
            `  The vault already uses these tags. Reuse one, exactly as written, whenever it fits; coin a new tag only for a central topic none of them covers, at most ${MAX_NEW_TAGS} new ones: ${vocabulary.join(", ")}.`,
          ]),
    ...(translating || current.length === 0
      ? []
      : [
          `  The article already carries these tags. Keep each one that still names a topic of it, exactly as written — they are not new, and never count against a limit on new tags: ${current.join(", ")}.`,
        ]),
  ];
}

const TagsResponseSchema = z.object({ tags: z.array(z.string()) });

const MAX_ATTEMPTS = 2;

export interface SuggestTagsOptions {
  chat: ChatFn;
  model: string;
  /** The title as the site shows it: `title_zh` where there is one. */
  title: string;
  /** The article's own title, where the one above is a translation. */
  originalTitle?: string;
  /** The summary as the site shows it, in Chinese — the wording tags that are
   * Chinese first should match (ADR 0035). Tags are about what an article
   * covers, which the summary states in a paragraph; sending the body would
   * cost a full summary call per article to learn the same. */
  summary: string;
  /** The summary in the article's own language, where it has one, so a name
   * the Chinese summary transliterated can still be tagged as it is spelled. */
  originalSummary?: string;
  /** The article's topics as tagged before, respelled: kept as topics and
   * written in the vault's form, not kept as spelled. */
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
    originalTitle,
    summary,
    originalSummary,
    currentTags,
    vocabulary,
    log = () => {},
  } = options;
  // DashScope's JSON mode rejects a request whose messages lack the word
  // "JSON", so it must appear in the prompt.
  const system = [
    "You tag articles for a personal knowledge base.",
    "Respond with a single JSON object with exactly one key:",
    ...tagPromptLines(vocabulary, { translating: true }),
    // Translating, not pruning (ADR 0035): the old tags are the article's
    // topics, and a retag that dropped them lost what made a niche article
    // findable.
    "The article's current tags name its topics. Keep every one of them, writing each in the form above — translate it (reinforcement learning → 强化学习), respell it (rss → RSS), or use the vault's tag for the same topic. Never trade a specific topic for a broader one: the specific tag is what makes the article findable. Merge two that mean the same; drop one only if it is not a topic of the article; add one only for a central topic none of them covers.",
    "Output JSON only, no markdown fences.",
  ].join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        `Title: ${title}`,
        ...(originalTitle !== undefined
          ? [`Original title: ${originalTitle}`]
          : []),
        "",
        "Summary:",
        summary,
        ...(originalSummary !== undefined
          ? ["", "Original summary:", originalSummary]
          : []),
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
