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
  }),
  categories: z.array(z.string().min(1)).min(1),
  translation: z
    .object({
      target: z.string().min(2).default("zh"),
      cjk_threshold: z.number().min(0).max(1).default(0.3),
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
