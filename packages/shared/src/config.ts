import { parse } from "yaml";
import { z } from "zod";

/**
 * Schema for the vault's `config/tiro.yml`. Subpath export
 * (`@tiro/shared/config`) — consumed by the processor and site only; the
 * extension never reads vault config.
 */
export const TiroConfigSchema = z.object({
  llm: z.object({
    base_url: z.url(),
    model: z.string().min(1),
    summary_model: z.string().min(1).optional(),
    translation_model: z.string().min(1).optional(),
    api_key_env: z.string().min(1),
    // Per-HTTP-request timeout, not per logical call: the client may retry.
    timeout_ms: z.number().int().positive().default(120_000),
    max_retries: z.number().int().min(0).default(3),
  }),
  categories: z.array(z.string().min(1)).min(1),
  translation: z
    .object({
      // zh-only, deliberately. Two things hardcode it: `translationPath()`
      // always names the artifact `zh.md`, and `detectLang` only ever returns
      // "zh" | "en" — so any other value makes the pipeline's
      // `lang !== target` check permanently true and translates every article,
      // Chinese originals included. Widening this means changing both.
      target: z.literal("zh").default("zh"),
      cjk_threshold: z.number().min(0).max(1).default(0.3),
      // Chars of source text per translation LLM call. Sized against provider
      // output caps and the client timeout, not the context window: the
      // output is as long as the input, so batches beyond ~10-30K chars risk
      // truncated responses and slow, expensive batch retries.
      batch_chars: z.number().int().positive().default(10_000),
    })
    .prefault({}),
  images: z
    .object({
      max_bytes: z
        .number()
        .int()
        .positive()
        .default(10 * 1024 * 1024),
      timeout_ms: z.number().int().positive().default(20_000),
      // max_bytes and timeout_ms bound one image; these bound the stage. A
      // page full of slow or huge images would otherwise run the job past its
      // timeout-minutes, and a killed run leaves the article pending and
      // repeats the whole download next push.
      max_count: z.number().int().positive().default(100),
      total_max_bytes: z
        .number()
        .int()
        .positive()
        .default(100 * 1024 * 1024),
      stage_timeout_ms: z.number().int().positive().default(300_000),
    })
    .prefault({}),
  processing: z
    .object({
      // Wall-clock budget for one processor run. The point is to stop the
      // processor *before* the workflow's timeout-minutes kills it: a killed
      // job cannot flush its translation checkpoint, so the run's work is
      // discarded and redone from scratch next push — which is how a single
      // 170 KB article stayed permanently unprocessed while starving every
      // article queued behind it.
      //
      // Keep it under timeout-minutes by more than llm.timeout_ms: the budget
      // is only checked between batches, so one in-flight request can overrun
      // it by up to that much.
      run_budget_ms: z
        .number()
        .int()
        .positive()
        .default(50 * 60 * 1000),
    })
    .prefault({}),
});
export type TiroConfig = z.infer<typeof TiroConfigSchema>;

/** Parse and validate tiro.yml text. Throws with a useful message on error. */
export function parseTiroConfig(yamlText: string): TiroConfig {
  return TiroConfigSchema.parse(parse(yamlText));
}

/** The model to use for a given pipeline task, honoring per-task overrides. */
export function modelFor(
  config: TiroConfig,
  task: "summary" | "translation",
): string {
  if (task === "summary") return config.llm.summary_model ?? config.llm.model;
  return config.llm.translation_model ?? config.llm.model;
}
