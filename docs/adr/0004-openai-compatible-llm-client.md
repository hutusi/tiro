# ADR 0004: Provider-configurable LLM via OpenAI-compatible endpoint

Status: accepted (2026-08)

## Context

The vault workflow needs an LLM for summaries and translations. The user
wants the provider to be configurable (e.g. Aliyun Bailian), not hardcoded to
any single vendor.

## Decision

- The processor speaks only the OpenAI-compatible chat-completions protocol.
  `config/tiro.yml` sets `base_url`, `model` (optional `summary_model` /
  `translation_model` overrides), and `api_key_env` — the name of the env var
  (a GitHub Actions secret) carrying the key.
- Template default: Aliyun Bailian compatible mode
  (`https://dashscope.aliyuncs.com/compatible-mode/v1`) with `qwen-plus`.
- The client is a small hand-rolled `fetch` wrapper (timeout, 3 retries with
  backoff on 429/5xx/network), injected into the pipeline so tests substitute
  a fake. No `openai` SDK dependency.
- Summary calls use JSON mode (`response_format: json_object`) with Zod
  validation of the response; DashScope requires the literal word "JSON" in
  the prompt, which the prompt template includes.

## Consequences

- Switching providers (DeepSeek, OpenAI, a gateway in front of Anthropic, a
  local server) is a config edit, no code change.
- Provider-specific features beyond plain chat completions are off the table
  by design; the pipeline only needs text in / text-or-JSON out.
