/**
 * Infer a fenced block's language from its text, for the fences that arrive
 * without one.
 *
 * Every one of the vault's 40 fences is bare, and re-clipping cannot fix most
 * of them: the pages they came from pre-highlight their code with Shiki, whose
 * output carries theme names and inline token colors and no language id at all.
 * The clipper recovers a language wherever a page states one (`languageFromLabel`
 * in `@tiro/shared`); this is what is left when no page ever did.
 *
 * **Inference belongs here and not in the clipper.** A language written into the
 * vault is permanent — the clipper does not revisit what it has written, and a
 * wrong one costs the block its highlighting for good. A language decided at
 * build time costs one build and is reversible by editing this file, which is
 * the right price for an answer that is a guess.
 *
 * The rule that shapes everything: **nothing fires without a positive
 * signature.** About 16 of those 40 fences are not code at all — they are
 * English prose, LLM prompt snippets the source author fenced for display — and
 * on the reported article 14 of 15 are. There is no "reject prose" test here
 * because there does not need to be one: prose matches no signature, so it
 * falls through to `null` and renders exactly as it does today. Every rule
 * below is anchored and requires corroboration, so the cost of a rule being too
 * narrow is a block that stays plain, and the cost of one being too broad is a
 * paragraph of English painted as Ruby.
 */

/** Lines with content, for rules that reason about a block's shape. */
function contentLines(code: string): string[] {
  return code.split("\n").filter((line) => line.trim() !== "");
}

/** How many of `patterns` appear anywhere in the code. */
function signals(code: string, patterns: readonly RegExp[]): number {
  return patterns.filter((pattern) => pattern.test(code)).length;
}

/**
 * A shebang names the interpreter outright, which is as certain as this file
 * gets. Checked first so `#!/usr/bin/env python` is never read as a comment by
 * a later rule.
 */
const SHEBANGS: readonly (readonly [RegExp, string])[] = [
  [/^#!.*\b(bash|sh|zsh)\b/, "bash"],
  [/^#!.*\bpython[\d.]*\b/, "python"],
  [/^#!.*\bnode\b/, "javascript"],
  [/^#!.*\bruby\b/, "ruby"],
  [/^#!.*\bperl\b/, "perl"],
];

function fromShebang(code: string): string | null {
  const first = code.split("\n", 1)[0] ?? "";
  for (const [pattern, language] of SHEBANGS) {
    if (pattern.test(first)) return language;
  }
  return null;
}

/**
 * JSON is the one language that can be recognised by definition rather than by
 * resemblance: it either parses or it does not. The opening-character test is
 * what keeps a bare number or a quoted sentence — both valid JSON — from
 * claiming a block of prose.
 */
function isJson(code: string): boolean {
  const text = code.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A terminal transcript, not a script: the prompt is in the text. Distinguished
 * from `bash` because the `$` would otherwise be highlighted as part of the
 * command.
 */
function isShellSession(code: string): boolean {
  const lines = contentLines(code);
  if (lines.length === 0) return false;
  const prompts = lines.filter((line) => /^\s*[$#>]\s+\S/.test(line)).length;
  return prompts > 0 && (lines[0] ?? "").trimStart().startsWith("$ ");
}

/**
 * Markdown is *not* inferred, and that is a decision rather than an omission.
 *
 * `# ` opens a heading in markdown and a comment in shell, and nothing in a
 * block settles which. Three rules tried: two headings, then differing heading
 * depth, then depth joined by a sentence — each admitted some script, and each
 * was defeated by a four-line counter-example within a round. The only version
 * that held required two list items, which a script cannot write, and that one
 * missed a real spec document in the vault that has six headings and no lists.
 *
 * The owner chose to remove the inference rather than keep trading. Every
 * markdown block in the vault today carries an explicit fence language anyway,
 * written at clip time or by the backfill, so nothing on the site changes —
 * what goes is the ability to guess, and with it the ambiguity.
 */

/**
 * YAML's mappings and a spec's `Key: value` prose look alike —
 * `Author: J. Ortiz. Status: draft.` reads exactly like a mapping. The
 * heading guard is what refuses those: a block with `# ` lines is a document
 * of some kind, and this rule declines rather than claim it.
 */
function isYaml(code: string): boolean {
  const lines = contentLines(code);
  if (lines.length < 3) return false;
  if (/^#{1,6} \S/m.test(code)) return false;
  // Statement terminators, not flow mappings: `{ action: log }` is YAML, and an
  // earlier version of this guard rejected two of the vault's three YAML blocks
  // for ending a line with `}`.
  if ((code.match(/;\s*$/gm) ?? []).length >= 2) return false;
  const keys = lines.filter((line) =>
    /^\s*(- )?[\w.$-]+:(\s|$)/.test(line),
  ).length;
  return keys >= 3 && keys / lines.length >= 0.5;
}

/**
 * English function words that never follow a SQL keyword. `from the list` is a
 * sentence; `from users` is a query, and the difference is the article.
 */
const STOPWORDS =
  "the|a|an|each|every|this|that|these|those|your|our|my|its|their|some|any|all|what|which|it";

/** A SQL identifier: bare, quoted, or schema-qualified. */
const IDENT = '[\\w."`]+';

/**
 * Rules that need corroboration: a single match is a coincidence, two together
 * are a language. Each list is anchored to line starts or to punctuation that
 * prose does not produce, so English scores zero rather than one.
 */
const CORROBORATED: readonly (readonly [string, readonly RegExp[], number])[] =
  [
    [
      "rust",
      [
        /^\s*(pub )?(struct|enum|trait|impl)\s+\w/m,
        /^\s*(pub )?fn \w+/m,
        /\blet mut\b/,
        /\b(Vec|Option|Result|Box)</,
        /^\s*use \w+(::\w+)+;/m,
        /\bfn\b[^\n]*->/,
        // `A(Ipv4Addr),` — an enum's tuple variant.
        /^\s*\w+\(\w[\w:<>, ]*\),\s*$/m,
        // `qname: Name,` — a struct field. The trailing comma is what separates
        // it from a YAML mapping.
        /^\s*(pub )?\w+:\s*[\w:<>&' ]+,\s*$/m,
      ],
      2,
    ],
    [
      "python",
      [
        // Whole-line forms. `import duties are a class of problem` matched a
        // bare `^import \w`, and `print(the contract)` matched a bare
        // `\bprint\(` — two signals, and the paragraph came back as Python.
        /^\s*import [\w.]+( +as +\w+)?,?\s*$/m,
        /^\s*from [\w.]+ import\b/m,
        /^\s*def \w+\s*\(/m,
        /^\s*class \w+[(:]/m,
        /^\s*(el)?if .+:\s*$/m,
        /^\s*print\(/m,
      ],
      2,
    ],
    [
      "go",
      [
        /^package \w+/m,
        /^\s*func \w*\s*\(/m,
        /:=/,
        /^\s*import \($/m,
        /\bfmt\.\w+\(/,
      ],
      2,
    ],
    [
      "c",
      [
        /^\s*#include\s*[<"]/m,
        /^\s*#define \w/m,
        /^\s*typedef\s+\w/m,
        /\b(int|void|char)\s+\w+\s*\([^)]*\)\s*\{/,
        /\bprintf\s*\(/,
      ],
      2,
    ],
    [
      "typescript",
      [
        /^\s*(export )?(interface|type) \w+/m,
        // Tied to a declaration or a parameter list. A bare `: string` matches
        // "The ratio: number of items per page", and `\bas\s+(const|string)` —
        // which used to sit here — matches "such as string values".
        /\b(const|let|var|readonly|private|public|function) \w+\??:\s*[\w<>[\]|]+/,
        /\(\s*\w+\??:\s*(string|number|boolean|unknown|any)\b/,
        /\)\s*:\s*(string|number|boolean|void|Promise)\b/,
        /^\s*import .* from ["']/m,
        /\bas\s+const\b/,
      ],
      2,
    ],
    [
      // `FROM x` is a base image as often as it is a SQL clause. This used to sit
      // in ANCHORED, where one match was enough, and read the `FROM users` of a
      // SELECT as a Dockerfile. A real Dockerfile has instructions beside it.
      "docker",
      [
        /^FROM \S+(\s+AS \w+)?\s*$/m,
        /^(RUN|COPY|ADD|CMD|ENTRYPOINT|WORKDIR|ENV|EXPOSE|ARG|VOLUME|USER) \S/m,
      ],
      2,
    ],
    [
      "javascript",
      [
        /^\s*(const|let|var) \w+\s*=/m,
        /^\s*(export )?(async )?function \w*\s*\(/m,
        /=>\s*[{(]/,
        /\brequire\(["']/,
        /^\s*import .* from ["']/m,
        /\bconsole\.\w+\(/,
      ],
      2,
    ],
    [
      // SQL's keywords are ordinary English verbs, so no amount of anchoring
      // separates them — "Select a source from the list" and "Create table rows
      // for each item" begin lines as readily as statements do. Two earlier
      // versions tried position, then the absence of full stops; punctuation is
      // a habit of prose, not a property of it, and dropping the full stops
      // defeated the second in one line.
      //
      // What separates them is the *operand*. English puts an article after
      // `from`; SQL puts an identifier. English does not write a typed column,
      // a VALUES tuple, or `= true`.
      "sql",
      [
        new RegExp(
          `^\\s*select\\s+(distinct\\s+)?(\\*|[\\w."\`,()\\s]+?)\\s+from\\s+(?!(${STOPWORDS})\\b)${IDENT}`,
          "im",
        ),
        new RegExp(
          `^\\s*create\\s+(table|index|view)\\s+(if\\s+not\\s+exists\\s+)?${IDENT}\\s*(\\(|as\\b|on\\b)`,
          "im",
        ),
        new RegExp(
          `^\\s*insert\\s+into\\s+${IDENT}\\s*(\\(|values\\b|select\\b)`,
          "im",
        ),
        new RegExp(
          `^\\s*update\\s+(?!(${STOPWORDS})\\b)${IDENT}\\s+set\\s+${IDENT}\\s*=`,
          "im",
        ),
        new RegExp(
          `^\\s*delete\\s+from\\s+(?!(${STOPWORDS})\\b)${IDENT}`,
          "im",
        ),
        new RegExp(
          `^\\s*(inner|left|right|full|cross)?\\s*join\\s+${IDENT}(\\s+(as\\s+)?\\w+)?\\s+on\\s+${IDENT}\\s*=`,
          "im",
        ),
        new RegExp(
          `^\\s*(where|group\\s+by|order\\s+by|having)\\s+(?!(${STOPWORDS})\\b)[\\w."\`(]`,
          "im",
        ),
        // A typed column definition. English does not write `name TEXT`.
        /^\s*"?\w+"?\s+(int|integer|bigint|serial|text|varchar\(|char\(|boolean|bool|timestamp|timestamptz|date|uuid|numeric|decimal|float|double|jsonb?)\b/im,
        /\bvalues\s*\(/i,
        /\b\w+\s*(=|<>|!=|>=|<=)\s*(true|false|null|\d|')/i,
      ],
      2,
    ],
    [
      "toml",
      [/^\s*\[[\w.]+\]\s*$/m, /^\s*\[\[[\w.]+\]\]\s*$/m, /^\s*\w+ = /m],
      2,
    ],
  ];

/** Single-match rules whose anchor prose cannot produce by accident. */
const ANCHORED: readonly (readonly [string, RegExp])[] = [
  ["bibtex", /^@\w+\{[\w:-]+,\s*$/m],
  ["diff", /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m],
];

/**
 * The language this code is written in, or `null` when nothing is sure enough.
 *
 * `null` means "render it plain", which is what every one of these blocks does
 * today — so a rule that declines costs nothing, and only a rule that fires
 * wrongly can make the page worse than it already is.
 */
export function detectLanguage(code: string): string | null {
  if (code.trim() === "") return null;

  const shebang = fromShebang(code);
  if (shebang !== null) return shebang;
  if (isJson(code)) return "json";
  for (const [language, pattern] of ANCHORED) {
    if (pattern.test(code)) return language;
  }
  if (isShellSession(code)) return "shellsession";

  // Whichever corroborated rule scores highest, and only if it clears the
  // runner-up. A tie means two languages explain the block equally well, and
  // the honest answer to that is plain text.
  let best: string | null = null;
  let bestScore = 0;
  let runnerUp = 0;
  for (const [language, patterns, floor] of CORROBORATED) {
    const score = signals(code, patterns);
    if (score < floor) continue;
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = language;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (bestScore > runnerUp && best !== null) return best;

  // Last, because `key: value` is a mapping in YAML and a line of English in a
  // spec. A block any rule above could explain has already been explained.
  if (isYaml(code)) return "yaml";
  return null;
}
