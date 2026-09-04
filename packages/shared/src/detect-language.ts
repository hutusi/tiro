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
 * Markdown, and the rule that made this file hard.
 *
 * Six of the vault's bare fences hold whole markdown documents — agent
 * instructions, a spec, a review checklist — and highlighting those is a real
 * gain. But a prompt that opens with `# Delivering work` and continues in
 * paragraphs is *also* one heading, and it is prose. And `# ` opens a comment
 * in shell, so `# Install` / `npm install` / `# Run` / `npm start` is two
 * headings and a shell script.
 *
 * So a heading is necessary and never sufficient: it must be joined by a signal
 * of a *different kind*. Lists are one. Nested heading depth is the other, and
 * it is what separates a document from a commented script — a script's comments
 * all sit at `#`, while prose that uses headings at all almost always uses more
 * than one level.
 *
 * An earlier version counted `headings >= 1` and `headings >= 2` as two
 * separate signals, which made two headings sufficient on their own and
 * contradicted this comment directly above it.
 */
function isMarkdown(code: string): boolean {
  const headings = code.match(/^(#{1,6}) \S/gm) ?? [];
  if (headings.length === 0) return false;
  const depths = new Set(headings.map((line) => line.indexOf(" ")));
  const bullets = (code.match(/^\s*[-*+] \S/gm) ?? []).length;
  const numbered = (code.match(/^\s*\d+\. \S/gm) ?? []).length;
  return bullets + numbered >= 2 || depths.size >= 2;
}

/**
 * YAML is checked after markdown because the two are genuinely confusable:
 * `Author: J. Ortiz. Status: draft.` is a line of a spec that reads exactly
 * like a mapping, and `- name:` opens a sequence entry and a bullet list at
 * once. They are told apart by what markdown has and YAML does not — headings —
 * so a block with any is refused here outright.
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
      // Anchored to line starts throughout. Unanchored, these are ordinary
      // English: "Select a source from the list. Then create table rows for each
      // item." scored two and came back as SQL.
      "sql",
      [
        /^\s*select\b[\s\S]*?\bfrom\s+\w/im,
        /^\s*(insert\s+into|update\s+\w+\s+set|delete\s+from)\s+\w/im,
        /^\s*create\s+(table|index|view)\s+(if\s+not\s+exists\s+)?\w/im,
        /^\s*(inner|left|right|full)?\s*join\s+\w+\s+on\b/im,
        /^\s*(where|group by|order by|having)\b/im,
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
/**
 * YAML frontmatter closed by `---` with a body after it.
 *
 * The shape alone is not enough, because a *multi-document* YAML file is
 * spelled the same way: `---` opens a document and `---` opens the next, so a
 * pair of Kubernetes manifests matches this exactly. Frontmatter is therefore
 * only frontmatter when what surrounds it is not itself YAML — which is true
 * of a markdown file, whose body is prose and drags the mapping ratio down.
 */
const FRONTMATTER = /^---\n[\s\S]*?\n---\n[\s\S]*\S/;

function isMarkdownFrontmatter(code: string): boolean {
  return FRONTMATTER.test(code) && !isYaml(code);
}

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
  if (isMarkdownFrontmatter(code)) return "markdown";
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

  // Last, because both read structure that code produces incidentally: `# ` is
  // a heading in markdown and a comment in Python and shell, and `key: value`
  // is a mapping in YAML and a line of English in a spec. A block that any
  // rule above could explain has already been explained.
  if (isMarkdown(code)) return "markdown";
  if (isYaml(code)) return "yaml";
  return null;
}
