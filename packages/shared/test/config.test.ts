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
