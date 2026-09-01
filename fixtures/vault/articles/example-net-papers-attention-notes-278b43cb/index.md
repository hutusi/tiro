---
url: "https://example.net/papers/attention-notes"
title: "Notes on Scaled Dot-Product Attention"
domain: "example.net"
clipped_at: "2026-08-24T14:10:00.000Z"
author: "R. Okonkwo"
has_math: true
lang: "en"
summary: "Working notes on scaled dot-product attention: why the scaling factor is there, a minimal implementation, and what the softmax does to the gradient."
category: "ai"
tags:
  - attention
  - transformers
  - math
tiro:
  schema: 1
  processed_at: "2026-08-24T14:15:00.000Z"
  processor_version: "0.1.0"
---

# Notes on Scaled Dot-Product Attention

Attention maps a query against a set of keys and returns a weighted sum of the values. Written for a single query vector $q$ and key matrix $K$, the weights are $\mathrm{softmax}(qK^\top / \sqrt{d_k})$, and the whole batched form is:

$$
\mathrm{Attention}(Q, K, V) = \mathrm{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right) V
$$

The scaling factor is the part worth dwelling on. For independent components with unit variance the dot product $q \cdot k$ has variance $d_k$, so without the $1/\sqrt{d_k}$ the logits grow with dimension:

$$
\begin{aligned}
\mathrm{Var}(q \cdot k) &= \sum_{i=1}^{d_k} \mathrm{Var}(q_i k_i) = d_k \\

\mathrm{Var}\!\left(\frac{q \cdot k}{\sqrt{d_k}}\right) &= 1
\end{aligned}
$$

Large logits push the softmax into a corner of the simplex where its Jacobian is nearly zero, and the gradient vanishes. The implementation is short enough to read in one sitting:

```python
import math
import torch


def attention(q, k, v, mask=None):
    scores = q @ k.transpose(-2, -1) / math.sqrt(q.size(-1))

    if mask is not None:
        scores = scores.masked_fill(mask == 0, float("-inf"))
    return torch.softmax(scores, dim=-1) @ v
```

The same thing in TypeScript, without the batching, is a useful sanity check when porting:

```ts
const scale = 1 / Math.sqrt(dk);
const scores = q.map((row) => keys.map((key) => dot(row, key) * scale));
```

Numerical stability matters more than the formula suggests. Subtracting the row maximum before exponentiating leaves the result unchanged, since $\mathrm{softmax}(x + c) = \mathrm{softmax}(x)$ for any scalar $c$, but it keeps every exponent at or below zero. Renting a machine to check this costs \$5 to \$10 an hour, which is cheap next to shipping it wrong.

| Variant | Complexity | Where it helps |
| --- | --- | --- |
| Full attention | $O(n^2 d)$ | short sequences |
| Sliding window | $O(nwd)$ | long documents |
| Linear attention | $O(nd^2)$ | very long sequences |

Two habits are worth keeping when you implement it:

- Assert the mask broadcasts, because

  $$
  \mathrm{scores} \in \mathbb{R}^{B \times H \times n \times n}
  $$

  and a mask of the wrong rank broadcasts silently instead of failing.
- Compare against a naive loop on a tiny input before trusting the batched form.

```
Q · Kᵀ  ->  scale  ->  mask  ->  softmax  ->  · V
```

Read the scaling factor as a variance correction rather than a hyperparameter, and most of the design follows.
