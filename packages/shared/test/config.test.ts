import { describe, expect, test } from "bun:test";
import { modelFor, parseTiroConfig } from "../src/config.ts";

const fullConfig = `
llm:
  base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
  model: qwen-plus
  summary_model: qwen-max
  api_key_env: TIRO_LLM_API_KEY
categories: [tech, ai, other]
translation:
  target: zh
  cjk_threshold: 0.3
images:
  max_bytes: 10485760
  timeout_ms: 20000
`;

const minimalConfig = `
llm:
  base_url: https://api.example.com/v1
  model: some-model
  api_key_env: MY_KEY
categories: [other]
`;

describe("parseTiroConfig", () => {
  test("parses a full config", () => {
    const config = parseTiroConfig(fullConfig);
    expect(config.llm.model).toBe("qwen-plus");
    expect(config.categories).toEqual(["tech", "ai", "other"]);
    expect(config.images.max_bytes).toBe(10485760);
  });

  test("fills defaults for omitted translation/images sections", () => {
    const config = parseTiroConfig(minimalConfig);
    expect(config.translation.target).toBe("zh");
    expect(config.translation.cjk_threshold).toBe(0.3);
    expect(config.translation.batch_chars).toBe(10_000);
    expect(config.images.max_bytes).toBe(10 * 1024 * 1024);
    expect(config.pdf.max_bytes).toBe(25 * 1024 * 1024);
    expect(config.pdf.max_pages).toBe(200);
    // The scanned-PDF gate: an order of magnitude below real prose, which
    // measures 2600-2800 chars/page.
    expect(config.pdf.min_chars_per_page).toBe(100);
    expect(config.pdf.min_page_coverage).toBe(0.5);
    expect(config.images.timeout_ms).toBe(20000);
  });

  test("rejects an empty category list", () => {
    expect(() =>
      parseTiroConfig(minimalConfig.replace("[other]", "[]")),
    ).toThrow();
  });

  test("rejects a non-URL base_url", () => {
    expect(() =>
      parseTiroConfig(
        minimalConfig.replace("https://api.example.com/v1", "not a url"),
      ),
    ).toThrow();
  });
});

describe("modelFor", () => {
  test("honors per-task overrides and falls back to the base model", () => {
    const config = parseTiroConfig(fullConfig);
    expect(modelFor(config, "summary")).toBe("qwen-max");
    expect(modelFor(config, "translation")).toBe("qwen-plus");
  });
});

describe("translation.target", () => {
  test("rejects a language the pipeline cannot actually produce", () => {
    expect(() =>
      parseTiroConfig(`${minimalConfig}translation:\n  target: ja\n`),
    ).toThrow();
  });
});

describe("the PDF stage cap and the request timeout", () => {
  const withTimeouts = (stage: number, request: number) => `
llm:
  base_url: https://api.example.com/v1
  model: m
  api_key_env: KEY
  timeout_ms: ${request}
categories: [other]
pdf:
  stage_timeout_ms: ${stage}
`;

  test("rejects a stage cap that cannot fit one request", () => {
    // The stage refuses to start work it cannot finish inside its own cap, so
    // a cap below one request's timeout means no batch is ever attempted: the
    // article stays pending every run, and the log says "timed out" rather
    // than "misconfigured".
    expect(() => parseTiroConfig(withTimeouts(60_000, 120_000))).toThrow(
      /stage_timeout_ms .* below llm.timeout_ms/,
    );
  });

  test("accepts a cap equal to the request timeout", () => {
    expect(
      parseTiroConfig(withTimeouts(120_000, 120_000)).pdf.stage_timeout_ms,
    ).toBe(120_000);
  });

  test("the defaults are compatible", () => {
    const config = parseTiroConfig(minimalConfig);
    expect(config.pdf.stage_timeout_ms).toBeGreaterThanOrEqual(
      config.llm.timeout_ms,
    );
  });
});
