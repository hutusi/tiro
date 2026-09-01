# 缩放点积注意力笔记

注意力机制将一个查询与一组键做匹配，返回值的加权和。对单个查询向量 $q$ 和键矩阵 $K$ 而言，权重为 $\mathrm{softmax}(qK^\top / \sqrt{d_k})$，完整的批量形式是：

$$
\mathrm{Attention}(Q, K, V) = \mathrm{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right) V
$$

真正值得琢磨的是那个缩放因子。对于方差为一的独立分量，点积 $q \cdot k$ 的方差是 $d_k$，因此若没有 $1/\sqrt{d_k}$，logits 会随维度增长：

$$
\begin{aligned}
\mathrm{Var}(q \cdot k) &= \sum_{i=1}^{d_k} \mathrm{Var}(q_i k_i) = d_k \\

\mathrm{Var}\!\left(\frac{q \cdot k}{\sqrt{d_k}}\right) &= 1
\end{aligned}
$$

过大的 logits 会把 softmax 推向单纯形的角落，那里的雅可比矩阵接近零，梯度随之消失。实现代码短到可以一口气读完：

```python
import math
import torch


def attention(q, k, v, mask=None):
    scores = q @ k.transpose(-2, -1) / math.sqrt(q.size(-1))

    if mask is not None:
        scores = scores.masked_fill(mask == 0, float("-inf"))
    return torch.softmax(scores, dim=-1) @ v
```

移植代码时，不带批处理的 TypeScript 版本是一个有用的对照：

```ts
const scale = 1 / Math.sqrt(dk);
const scores = q.map((row) => keys.map((key) => dot(row, key) * scale));
```

数值稳定性比公式看上去更重要。在取指数之前减去每行的最大值不会改变结果，因为对任意标量 $c$ 都有 $\mathrm{softmax}(x + c) = \mathrm{softmax}(x)$，但这能让每个指数都不大于零。

| 变体 | 复杂度 | 适用场景 |
| --- | --- | --- |
| 全注意力 | $O(n^2 d)$ | 短序列 |
| 滑动窗口 | $O(nwd)$ | 长文档 |
| 线性注意力 | $O(nd^2)$ | 超长序列 |

```
Q · Kᵀ  ->  scale  ->  mask  ->  softmax  ->  · V
```

把缩放因子理解成方差修正而非超参数，其余的设计大多就顺理成章了。
