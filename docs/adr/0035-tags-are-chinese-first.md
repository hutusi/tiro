# ADR 0035: Tags are Chinese first

Status: accepted (2026-09). Supersedes ADR 0033's language and case rules — its
tags were English and lowercase; they are now Chinese first and keep their
case. ADR 0033's vocabulary, aliases, report and retag stand, adjusted below.

## Context

ADR 0033 made tags English: the vault's tags were 87% English already, and one
language was the way to stop a topic splitting across two scripts. Before
retagging the live vault with it, the owner ran it on five articles, and read
the result as worse:

- **Its readers read Chinese.** The site is Chinese; `熵`, `热力学` and
  `注意力劫持` said more to them than `thermodynamics` and `attention`.
- **The new-tag cap cut each niche article's defining topic.** The entropy
  article came back as `mathematics, physics, thermodynamics`: the model had
  offered `statistical mechanics, entropy, arrow of time` too, ignoring the
  prompt's limit of two, and the policy kept whichever two came first.

The live vault then: 189 articles, 188 of them English-source; tag occurrences
920 English, 114 Chinese, 22 mixed; not one with an uppercase letter.

## Decision

### 1. Chinese first

A tag is written in Simplified Chinese — `强化学习`, `软件工程`, `熵` — and in
English only where Chinese technical writing keeps English: acronyms (`AI`,
`LLM`, `API`), and proper nouns and products (`Git`, `Rust`, `Claude`,
`OpenAI`). A tag may mix them: `AI安全`. The owner's own examples are in the
prompt, which asks for tags most central first, so the cap on new ones and the
limit of six keep the core topic.

The policy (`writableTags`) no longer drops Chinese. It drops a tag in kana or
hangul — the vault holds Japanese articles, and a Japanese tag is neither
language — and cannot tell Japanese kanji or traditional characters from
Simplified; an alias fixes those.

### 2. Case is spelling, not identity

A tag keeps its case: `AI安全`, not `ai安全`. Every comparison — an alias, a
duplicate, the vocabulary — is made on its key (`tagKey`: the canonical form
without case), so `AI` and `ai` are one tag, which the vault spells one way.
The site already grouped tags this way (`tagSlug` folds case), so pages do not
change; chips now read as they should.

### 3. No gap beside a Chinese character

`AI 安全`, `AI-安全` and `AI安全` are one tag, written `AI安全`: `normalizeTag`
removes spaces, underscores and hyphens beside a Han character, before the
rule that keeps a hyphen beside a digit (`GPT-4 发布` → `GPT-4发布`), and
`tagSlug` does the same to its separators, so the two still agree on every
page. Latin words keep single spaces between them (ADR 0033).

### 4. Aliases are the vault's spelling

`tags.aliases` says how the vault spells a tag: `reinforcement learning:
强化学习`, `ai safety: AI安全`, `ai: AI`. A target is also its own key's
spelling — `large language models: LLM` makes the vault's forty `llm` tags
`LLM` too, rather than the lowercase majority outvoting the table. Aliases
stay one hop, and a table under which respelling would not settle — a chain,
a cycle, one tag spelled two ways, two entries for one tag — is refused when
`tiro.yml` is read, since it would otherwise rewrite the same articles on
every run and nothing would ever say so.

### 5. The vocabulary, spelled and seeded

The vocabulary is counted by key and offered in the vault's spelling — an
alias target, or else the spelling most articles use. A tag that is still in
the old regime's form — Latin letters, no Han, all lowercase, and not an alias
target — is *undecided*: it is left out of the vocabulary, so the English the
vault has today does not pull the model back to it.

That makes the order of a migration load-bearing. The alias table has to land
after this code (the old policy drops a Chinese target) and before a retag (or
the vocabulary is English); `retag` refuses to start while a tag two articles
share is undecided.

### 6. Retag translates, rather than prunes

A retag keeps an article's topics and writes them in the vault's form: it asks
the model with the article's Chinese title and summary, and the original
summary where there is one for exact names, and holds the reply to no cap on
new tags — each tag it translates is new to the vocabulary by spelling, and
pruning them is how the pilot lost `entropy`. An article whose tags only need
respelling by the aliases is rewritten without a call, and one already in the
vault's form is not asked again. A run's cap on new tags rises from two to
three, and never counts a tag the article already carries, so reprocessing an
article does not prune it either.

## Consequences

- **No schema bump.** Tags are still strings; their form is the processor's
  policy, checked by `validate`, which now takes any case and flags `AI` and
  `ai` in one article as a duplicate.
- **Tag URLs change once.** A translated tag's page moves
  (`/tags/reinforcement-learning/` → `/tags/强化学习/`) and the old one 404s.
  Accepted: a tag page is derived, and nothing outside the site links to one.
- **Mixed language is a judgment.** Which terms Chinese writing keeps in
  English is the model's call, and it will sometimes differ from the owner's;
  the `tags` report lists the vault's English tags and its spellings of one
  tag, and an alias settles each.
