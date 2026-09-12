---
url: "https://example.dev/notes/a-clip-awaiting-retranslation"
title: "What a Re-clipped Article Looks Like"
domain: "example.dev"
clipped_at: "2026-09-09T11:20:00.000Z"
lang: "en"
title_zh: "重新剪藏后的文章长什么样"
summary: "这篇文章处于一个真实但容易被忽略的中间状态：它已经处理过，带有中文标题和摘要，但它的译文没有通过对齐检查，因此没有 zh.md。站点必须把它当作单栏文章渲染。"
category: "tech"
tags:
  - contract
  - rendering
tiro:
  schema: 1
  processed_at: "2026-09-09T11:24:00.000Z"
  processor_version: "0.1.0"
  translation_failed: true
---

This article is processed and carries a Chinese title and summary, but its
translation did not survive the alignment gate, so there is no `zh.md` beside it.

The site renders it single-pane while `articleMeta` still hands the template a
Chinese title — the one combination no other fixture produces, and the reason
every rule keyed on the reader mode also has to ask whether the article is
actually paired.
