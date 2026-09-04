/**
 * Resolve a code block's *stated* language to a canonical id.
 *
 * Pages that pre-highlight their code — increasingly with Shiki, whose output
 * carries theme names and inline token colors but no language id — leave the
 * language nowhere a class or attribute probe can find it. What they do leave
 * is chrome a human reads: a tab labelled `Python`, a header naming
 * `Dockerfile`. This module turns that text into an id, and refuses everything
 * else.
 *
 * Both lookups are **allowlists, and that is the whole point**. The text sitting
 * where a language name sits is very often not a language — `Copy`, `Output`,
 * `Response`, `Terminal`, `Request`, `Example` all appear in exactly that
 * position — and a permissive rule turns one of those into ```` ```output ````
 * in the vault, permanently, because a wrong language is written into content
 * the clipper will not revisit. Anything unrecognised resolves to `null` and the
 * fence stays bare, which is what happens today and costs only colors.
 *
 * Ids are Shiki's own, so the site needs no second translation. An id the site
 * has no grammar for degrades to plain text there (`languageFor` in
 * `apps/site/src/lib/highlight.ts`), never to a build failure.
 */

/**
 * Display name → canonical id. Keys are matched after lowercasing and
 * whitespace collapsing, so `Objective-C` and `objective c` both land here.
 *
 * Spelled out rather than derived from Shiki's metadata because the *input*
 * here is prose written for humans, not Shiki's vocabulary: `cURL` means a
 * shell snippet, `Node.js` means JavaScript, and no amount of alias data
 * relates those. It also keeps `@tiro/shared` free of a Shiki dependency, which
 * matters because the extension bundles this file.
 */
const LABEL_LANGUAGES = new Map<string, string>([
  ["bash", "bash"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["zsh", "bash"],
  ["command line", "bash"],
  // A cURL tab holds a shell invocation, not a language of its own.
  ["curl", "bash"],
  ["shell session", "shellsession"],
  ["console", "shellsession"],
  ["terminal session", "shellsession"],
  ["c", "c"],
  ["c++", "cpp"],
  ["cpp", "cpp"],
  ["c#", "csharp"],
  ["csharp", "csharp"],
  ["css", "css"],
  ["diff", "diff"],
  ["patch", "diff"],
  ["docker", "docker"],
  ["dockerfile", "docker"],
  ["elixir", "elixir"],
  ["go", "go"],
  ["golang", "go"],
  ["graphql", "graphql"],
  ["gql", "graphql"],
  ["haskell", "haskell"],
  ["html", "html"],
  ["ini", "ini"],
  ["java", "java"],
  ["javascript", "javascript"],
  ["js", "javascript"],
  ["node", "javascript"],
  ["node.js", "javascript"],
  ["nodejs", "javascript"],
  ["jsx", "tsx"],
  ["json", "json"],
  ["jsonc", "jsonc"],
  ["kotlin", "kotlin"],
  ["latex", "latex"],
  ["tex", "latex"],
  ["bibtex", "bibtex"],
  ["lua", "lua"],
  ["make", "make"],
  ["makefile", "make"],
  ["markdown", "markdown"],
  ["md", "markdown"],
  ["nix", "nix"],
  ["objective-c", "objective-c"],
  // `normalize` collapses whitespace but does not fold it to a hyphen, so the
  // spaced spelling needs its own entry.
  ["objective c", "objective-c"],
  ["objc", "objective-c"],
  ["perl", "perl"],
  ["php", "php"],
  ["powershell", "powershell"],
  ["ps1", "powershell"],
  ["proto", "proto"],
  ["proto3", "proto"],
  ["protobuf", "proto"],
  ["python", "python"],
  ["py", "python"],
  ["r", "r"],
  ["ruby", "ruby"],
  ["rb", "ruby"],
  ["rust", "rust"],
  ["rs", "rust"],
  ["scala", "scala"],
  ["sql", "sql"],
  ["swift", "swift"],
  ["toml", "toml"],
  ["tsx", "tsx"],
  ["typescript", "typescript"],
  ["ts", "typescript"],
  ["vue", "vue"],
  ["xml", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["zig", "zig"],
]);

/**
 * Filename → canonical id, for chrome that names a file rather than a language.
 * Matched on the whole lowercased basename, before the extension table, so
 * `Dockerfile` and `Makefile` resolve without one.
 */
const FILENAME_LANGUAGES = new Map<string, string>([
  ["dockerfile", "docker"],
  ["makefile", "make"],
  ["gnumakefile", "make"],
  ["gemfile", "ruby"],
  ["rakefile", "ruby"],
  ["cargo.toml", "toml"],
  ["package.json", "json"],
  ["tsconfig.json", "jsonc"],
]);

/** Extension → canonical id. Keys carry no leading dot. */
const EXTENSION_LANGUAGES = new Map<string, string>([
  ["bash", "bash"],
  ["bib", "bibtex"],
  ["c", "c"],
  ["cc", "cpp"],
  ["cpp", "cpp"],
  ["cs", "csharp"],
  ["css", "css"],
  ["cxx", "cpp"],
  ["diff", "diff"],
  ["ex", "elixir"],
  ["exs", "elixir"],
  ["go", "go"],
  ["graphql", "graphql"],
  ["h", "c"],
  ["hpp", "cpp"],
  ["hs", "haskell"],
  ["htm", "html"],
  ["html", "html"],
  ["ini", "ini"],
  ["java", "java"],
  ["js", "javascript"],
  ["json", "json"],
  ["jsonc", "jsonc"],
  ["jsx", "tsx"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["lua", "lua"],
  ["m", "objective-c"],
  ["md", "markdown"],
  ["mjs", "javascript"],
  ["nix", "nix"],
  ["patch", "diff"],
  ["php", "php"],
  ["pl", "perl"],
  ["proto", "proto"],
  ["ps1", "powershell"],
  ["py", "python"],
  ["r", "r"],
  ["rb", "ruby"],
  ["rs", "rust"],
  ["scala", "scala"],
  ["sh", "bash"],
  ["sql", "sql"],
  ["swift", "swift"],
  ["tex", "latex"],
  ["toml", "toml"],
  ["ts", "typescript"],
  ["tsx", "tsx"],
  ["vue", "vue"],
  ["xml", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["zig", "zig"],
  ["zsh", "bash"],
]);

/**
 * Longest label worth considering. Chrome text runs to whole sentences on some
 * sites ("Copy this into your terminal"), and a length cap rejects those before
 * the map has to have an opinion about every word in English.
 */
const LABEL_MAX_LENGTH = 24;

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A language name as a human would write it, or `null`.
 *
 * `null` is the answer for every input this module does not recognise, which
 * includes the whole open set of words that are not languages. Callers must
 * treat it as "leave the fence alone", never as a reason to substitute a guess.
 */
export function languageFromLabel(label: string): string | null {
  const text = normalize(label);
  if (text === "" || text.length > LABEL_MAX_LENGTH) return null;
  return LABEL_LANGUAGES.get(text) ?? null;
}

/**
 * A filename as chrome writes it — `app.ts`, `src/main.rs`, `Dockerfile` — or
 * `null`.
 *
 * Directories are dropped first: a title is as likely to read `src/index.ts` as
 * `index.ts`, and the extension is the only part that carries the answer.
 */
export function languageFromFilename(name: string): string | null {
  const text = normalize(name);
  if (text === "") return null;
  const base = text.split(/[/\\]/).pop() ?? "";
  // The cap applies to the basename, not the path: a title reading
  // `a-very-long-directory-name/app.ts` is a perfectly ordinary filename, and
  // capping the whole string rejects it for the directory's length alone.
  if (base === "" || base.length > LABEL_MAX_LENGTH) return null;
  const named = FILENAME_LANGUAGES.get(base);
  if (named !== undefined) return named;
  // `.` at position 0 is a dotfile, not an extension: `.env` has no suffix.
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXTENSION_LANGUAGES.get(base.slice(dot + 1)) ?? null;
}
