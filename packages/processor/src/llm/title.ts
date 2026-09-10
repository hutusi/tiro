import { z } from "zod";
import { detectLang } from "../language.ts";
import type { ChatFn, ChatMessage } from "./client.ts";

/**
 * The rules a translated title follows, the guard that decides a candidate is
 * one, and the standalone call the backfill makes.
 *
 * Two callers prompt from here: the summary call, which gets the title for free
 * alongside the summary it has to share vocabulary with, and `backfill-titles`,
 * which has only the title and an already-written summary to go on. Two
 * spellings of these rules would give one vault two house styles for its titles
 * — one for everything clipped after this landed, another for everything that
 * came before it.
 */

/**
 * The title rules, in the register of `batchSystemPrompt` in `translate.ts`.
 *
 * The JSON key is `title_zh` rather than something built from `targetLang`
 * because the frontmatter field is: `translation.target` is a literal `"zh"` in
 * the config schema, deliberately un-widenable, and the artifact beside it is
 * named `zh.md` for the same reason.
 *
 * Deliberately no "drop the publisher's suffix" rule. Two live titles carry one
 * (`… critical | Bill Gates`, `autistici.org - Welcome to …`), but telling a
 * model to translate faithfully and then to delete part of what it was given
 * licenses it to edit the rest too — and the original renders directly beside
 * the translation everywhere the translation appears, so nothing is hidden. A
 * suffix worth removing is worth removing by hand.
 */
export function titlePromptLines(targetLang: string): string[] {
  return [
    `- "title_zh": the article's title translated into the language "${targetLang}". Translate it — do not summarize, expand or improve it, and add nothing the title does not say. Keep product names, company names, model names, acronyms, version numbers and code identifiers in their original form (Claude, arXiv, KAN, DNS, 1.1.1.1) and translate the words around them. A subtitle after a colon stays a subtitle, joined with a full-width colon. Match the original's length, at most 40 characters, with no quotation marks around the whole title and no trailing period.`,
  ];
}

/** The prompt line for the summary's other half. */
export function sourceSummaryPromptLine(): string {
  return '- "summary_orig": the same summary again, written in the language the article itself is written in — the same content, not a longer or looser one.';
}

// The per-character test `language.ts` makes a ratio of. Presence, not ratio,
// is the question here: a title may be almost entirely product name and still
// be a translation.
const HAN_RE = /\p{Script=Han}/u;

/**
 * A candidate translated title, or undefined when it is not one.
 *
 * A model handed a short English string sometimes returns it unchanged — asked
 * for Chinese, `The Twelve-Factor App` comes back as `The Twelve-Factor App` —
 * and an echo is worse than nothing: the site would print a second English line
 * under the first in every library row, where no title at all falls back to the
 * layout that has been shipping all along.
 *
 * One Han character is the whole bar, not a ratio: a legitimate translation can
 * be mostly product name (`为 Claude Fable 5.1 编写提示词`).
 */
export function acceptableTitleZh(
  candidate: string | undefined,
  sourceTitle: string,
): string | undefined {
  const trimmed = candidate?.trim();
  if (trimmed === undefined || trimmed === "" || !HAN_RE.test(trimmed)) {
    return undefined;
  }
  // A Han character alone is not proof of a translation: a source title that
  // already mixes scripts — `AI 与 the Future` — passes that test while
  // unchanged. Compared against the source for the same reason the summary
  // below is compared against its own counterpart.
  if (sameTitle(trimmed, sourceTitle)) return undefined;
  return trimmed;
}

/** Case, width and spacing folded, which is all an echo can differ by. Not the
 * site's `normalizeTitle`: that one folds quotes and dashes to ask "is this the
 * same title across scraping variants", and this asks the narrower question of
 * whether the model handed back what it was given. */
function sameTitle(a: string, b: string): boolean {
  const fold = (text: string) =>
    text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  return fold(a) === fold(b);
}

/**
 * A candidate source-language summary, or undefined when it is not one.
 *
 * Two ways it can be wrong, and the second is the one that happens. A model
 * asked for "the same summary in the article's own language" sometimes repeats
 * the summary it just wrote verbatim — cheap to catch — and more often writes
 * the target language again in different words, which an equality test cannot
 * see at all. Either way the reader would show that text in the column it
 * labels 原文.
 *
 * The language test is the same ratio the pipeline already uses to decide
 * whether an article needs translating at all, at the vault's own threshold, so
 * an English summary quoting a Chinese term stays an English summary.
 */
export function acceptableSourceSummary(
  candidate: string | undefined,
  summary: string,
  targetLang: string,
  cjkThreshold: number,
): string | undefined {
  const trimmed = candidate?.trim();
  if (trimmed === undefined || trimmed === "" || trimmed === summary.trim()) {
    return undefined;
  }
  if (detectLang(trimmed, cjkThreshold) === targetLang) return undefined;
  return trimmed;
}

const TitleResponseSchema = z.object({ title_zh: z.string().min(1) });

const MAX_ATTEMPTS = 2;

export interface TranslateTitleOptions {
  chat: ChatFn;
  model: string;
  targetLang: string;
  title: string;
  domain: string;
  /**
   * The article's already-written summary, in the target language.
   *
   * This is the whole reason a backfilled title is worth as much as one the
   * summary call produced: it is the text the title will render directly above
   * in every library row, so handing it over is what keeps the two agreeing on
   * how a term is rendered. Marked as context in the prompt, never as something
   * to translate.
   */
  summary?: string;
  log?: (message: string) => void;
}

/**
 * Translate one title. For articles the pipeline already processed — a title
 * that comes with a body gets translated by the summary call instead, in the
 * same request as the summary.
 *
 * Two corrective attempts rather than the summary call's three, and no fallback:
 * the title is the entire point of this call, so a correction is proportionate
 * and there is nothing to salvage if it does not work. Null means the article
 * keeps no `title_zh` and the site goes on showing what it showed before.
 *
 * Transport and HTTP errors propagate, the rule `summarize` and `translateBlocks`
 * already follow: a 403 or an outage is not something a reworded prompt fixes.
 */
export async function translateTitle(
  options: TranslateTitleOptions,
): Promise<string | null> {
  const {
    chat,
    model,
    targetLang,
    title,
    domain,
    summary,
    log = () => {},
  } = options;

  // DashScope's JSON mode rejects requests whose messages don't contain the
  // literal word "JSON", so the word must appear in the prompt.
  const system = [
    "You are a precise reading assistant for a personal knowledge base.",
    "Respond with a single JSON object with exactly this key:",
    ...titlePromptLines(targetLang),
    "Output JSON only, no markdown fences.",
  ].join("\n");

  const context = [
    `Title: ${title}`,
    `Published on: ${domain}`,
    ...(summary === undefined
      ? []
      : [
          "",
          "The article's summary, for terminology only — do not translate it, and do not summarize it into the title:",
          summary,
        ]),
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: context },
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const raw = await chat({
      model,
      messages,
      response_format: { type: "json_object" },
    });

    let feedback: string;
    try {
      const parsed = TitleResponseSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        feedback = `Your previous JSON did not match the schema: ${parsed.error.message}`;
      } else {
        const accepted = acceptableTitleZh(parsed.data.title_zh, title);
        if (accepted !== undefined) return accepted;
        feedback = `Your previous "title_zh" (${parsed.data.title_zh}) is not a translation of the title into the language "${targetLang}".`;
      }
    } catch (error) {
      feedback = `Your previous response was not valid JSON: ${String(error).slice(0, 200)}`;
    }
    log(`title attempt ${attempt}/${MAX_ATTEMPTS} failed: ${feedback}`);
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
  return null;
}
