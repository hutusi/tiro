# 你好，AI：一份实用入门

理解大语言模型的最佳方式是把它看作通用的文本引擎。它能补全、转换和推理文本，几乎所有实际应用都是这三个动词的变体。

![封面](./assets/cover.png)

建立直觉最快的方式就是实际调用一次。下面的示例发送一个提示词并打印回复。

```ts
const res = await fetch(`${BASE_URL}/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}` },

  body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }] }),
});
```

| 模式 | 适用场景 | 注意事项 |
| --- | --- | --- |
| 补全 | 起草、扩写 | 事实幻觉 |
| 转换 | 翻译、改写 | 语气漂移 |
| 抽取 | 结构化数据 | 违反模式 |

把模型当作组件而不是先知：校验它的输出，失败时重试，并让人参与任何不可逆的决策。
