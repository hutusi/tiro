---
url: "https://example.com/posts/hello-ai"
title: "Hello, AI: A Practical Introduction"
domain: "example.com"
clipped_at: "2026-08-20T09:30:00.000Z"
author: "Jane Doe"
lang: "en"
summary: "A gentle introduction to working with large language models, covering what they are good at, a minimal code example, and a comparison of common usage patterns."
category: "ai"
tags:
  - llm
  - introduction
  - tutorial
  - ci/cd
tiro:
  schema: 1
  processed_at: "2026-08-20T09:35:00.000Z"
  processor_version: "0.1.0"
---

# Hello, AI: A Practical Introduction

Large language models are best understood as general-purpose text engines. They complete, transform, and reason over text, and almost every practical application is a variation on those three verbs.

![cover](./assets/cover.png)

The fastest way to build an intuition is to call one. The example below sends a single prompt and prints the reply.

```ts
const res = await fetch(`${BASE_URL}/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}` },

  body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }] }),
});
```

| Pattern | Good for | Watch out for |
| --- | --- | --- |
| Completion | drafting, expansion | hallucinated facts |
| Transformation | translation, rewriting | tone drift |
| Extraction | structured data | schema violations |

Treat the model as a component, not an oracle: validate its output, retry on failure, and keep a human in the loop for anything irreversible.
