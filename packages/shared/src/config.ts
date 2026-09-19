import { parse } from "yaml";
import { z } from "zod";

/**
 * Schema for the vault's `config/tiro.yml`. Subpath export
 * (`@tiro/shared/config`) — consumed by the processor and site only; the
 * extension never reads vault config.
 */
export const TiroConfigSchema = z
  .object({
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
        // A single top-level block is never split — it is the unit the 1:1
        // alignment contract is built on — so a block bigger than this cannot be
        // batched with anything and would be sent alone, expecting an equally
        // large response. Past the provider's output cap that request never
        // succeeds, and the article never gets translated at all. Above this
        // size a block is copied through untranslated instead, exactly as code
        // and images already are: one untranslated block beats no translation.
        // (A 177-entry arXiv bibliography, 47K chars as one list, is the case
        // this exists for — and not something worth translating anyway.)
        max_block_chars: z.number().int().positive().default(20_000),
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
    pdf: z
      .object({
        // A PDF is fetched at processing time and never stored (ADR 0026), so
        // this bounds one download rather than anything the vault keeps. Larger
        // than an image's cap because a paper routinely runs to several MB and a
        // report further; a PDF over this stays unconverted, which leaves the
        // article pending rather than failing the run.
        max_bytes: z
          .number()
          .int()
          .positive()
          .default(25 * 1024 * 1024),
        timeout_ms: z.number().int().positive().default(60_000),
        stage_timeout_ms: z.number().int().positive().default(300_000),
        // Extraction is cheap per page but the structure pass that follows is
        // not, and a 600-page book would spend a whole run's budget on one
        // article. Past this the PDF is refused rather than truncated: half a
        // document filed as the whole one is the silent kind of wrong.
        max_pages: z.number().int().positive().default(200),
        // The scanned-PDF gate (ADR 0026 clause 4). A page image carries no text
        // layer, so a scan extracts to roughly nothing, and an empty body is the
        // empty article the clipper already refuses. Measured against real
        // papers, which run 2600-2800 chars/page, so this sits an order of
        // magnitude below anything with prose on it and still clears a document
        // that is mostly figures.
        min_chars_per_page: z.number().int().positive().default(100),
        // The other half of that gate. An average is a sum, so one dense page
        // among nine scanned ones clears min_chars_per_page comfortably and the
        // article would be filed as a whole document while holding a tenth of
        // it. This asks that the text be spread across the document, while
        // staying loose enough for the full-page figures a real paper carries.
        min_page_coverage: z.number().min(0).max(1).default(0.5),
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
  })
  /**
   * A PDF stage that cannot fit one model call can never start a batch.
   *
   * The stage refuses to begin work it cannot finish inside its own cap, which
   * is what keeps a conversion from overrunning it. Set the cap below a single
   * request's timeout and that rule bites every batch: nothing is ever
   * attempted, the stage times out, and the article stays pending on every run
   * with the log showing a timeout rather than a misconfiguration. Caught here
   * so it reads as the config error it is.
   */
  .superRefine((config, ctx) => {
    if (config.pdf.stage_timeout_ms < config.llm.timeout_ms) {
      ctx.addIssue({
        code: "custom",
        path: ["pdf", "stage_timeout_ms"],
        message: `pdf.stage_timeout_ms (${config.pdf.stage_timeout_ms}) is below llm.timeout_ms (${config.llm.timeout_ms}), so no PDF batch could ever be started`,
      });
    }
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
