---
url: "https://example.org/essays/before-the-backfill"
title: "The Shape Every Article Had First"
domain: "example.org"
author: "P. Okafor"
clipped_at: "2026-09-10T07:40:00.000Z"
lang: "en"
summary: "这篇文章代表了文库里最常见的一种状态：已经处理过，有中文摘要和完整的对照译文，但没有 title_zh——它在这个字段出现之前就处理完了，正文也不以自己的标题开头，所以站点无法推导出一个中文标题。"
category: "tech"
tags:
  - contract
  - rendering
tiro:
  schema: 1
  processed_at: "2026-09-10T07:46:00.000Z"
  processor_version: "0.1.0"
---

Every article in the vault looked like this before translated titles existed: a
full side-by-side translation, a Chinese summary, and no Chinese title at all.

The body does not open with its own title, which is why nothing can be lifted
out of the translation to stand in for one. That combination is ordinary rather
than exotic, so the reader has to stay readable in it — including in the mode
that shows only one language.
