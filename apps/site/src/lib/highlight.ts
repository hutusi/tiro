import bash from "@shikijs/langs/bash";
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import csharp from "@shikijs/langs/csharp";
import css from "@shikijs/langs/css";
import diff from "@shikijs/langs/diff";
import docker from "@shikijs/langs/docker";
import elixir from "@shikijs/langs/elixir";
import go from "@shikijs/langs/go";
import graphql from "@shikijs/langs/graphql";
import haskell from "@shikijs/langs/haskell";
import html from "@shikijs/langs/html";
import ini from "@shikijs/langs/ini";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import kotlin from "@shikijs/langs/kotlin";
import latex from "@shikijs/langs/latex";
import lua from "@shikijs/langs/lua";
import make from "@shikijs/langs/make";
import markdown from "@shikijs/langs/markdown";
import nix from "@shikijs/langs/nix";
import objectiveC from "@shikijs/langs/objective-c";
import perl from "@shikijs/langs/perl";
import php from "@shikijs/langs/php";
import powershell from "@shikijs/langs/powershell";
import proto from "@shikijs/langs/proto";
import python from "@shikijs/langs/python";
import r from "@shikijs/langs/r";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import scala from "@shikijs/langs/scala";
import sql from "@shikijs/langs/sql";
import swift from "@shikijs/langs/swift";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import vue from "@shikijs/langs/vue";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import zig from "@shikijs/langs/zig";
import githubDarkDimmed from "@shikijs/themes/github-dark-dimmed";
import type { Element, Root } from "hast";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { visit } from "unist-util-visit";

const THEME = "github-dark-dimmed";
/** Shiki special-cases this one — it needs no grammar. */
const FALLBACK_LANG = "plaintext";

/**
 * Grammars are imported rather than lazily bundled because the highlighter has
 * to be **synchronous**: `renderBlockHtml` runs under `processSync`, which the
 * article page calls straight from its frontmatter. An async highlighter would
 * make the reader view async all the way up for no reader-visible gain.
 *
 * The list is a judgement call about what clipped technical writing contains.
 * Anything outside it degrades to plain text, never to a build failure — see
 * `languageFor`.
 */
const highlighter = createHighlighterCoreSync({
  engine: createJavaScriptRegexEngine(),
  themes: [githubDarkDimmed],
  langs: [
    bash,
    c,
    cpp,
    csharp,
    css,
    diff,
    docker,
    elixir,
    go,
    graphql,
    haskell,
    html,
    ini,
    java,
    javascript,
    json,
    jsonc,
    kotlin,
    latex,
    lua,
    make,
    markdown,
    nix,
    objectiveC,
    perl,
    php,
    powershell,
    proto,
    python,
    r,
    ruby,
    rust,
    scala,
    sql,
    swift,
    toml,
    tsx,
    typescript,
    vue,
    xml,
    yaml,
    zig,
  ],
});

// Shiki registers each grammar's own aliases, so `js`, `sh`, `py` and friends
// resolve without being listed above.
const loaded = new Set(highlighter.getLoadedLanguages());
const unsupported = new Set<string>();

/**
 * Resolve a fence's info string to a loaded grammar. Info strings come from
 * arbitrary web pages, so an unknown one must cost the block its colors and
 * nothing more: `codeToHast` throws on a language it does not have, and one
 * exotic fence must not be able to fail the site build.
 */
function languageFor(info: string | undefined): string {
  if (info === undefined || info === "") return FALLBACK_LANG;
  const lang = info.toLowerCase();
  if (loaded.has(lang)) return lang;
  if (!unsupported.has(lang)) {
    unsupported.add(lang);
    console.warn(`shiki: no grammar for "${lang}"; rendering as plain text`);
  }
  return FALLBACK_LANG;
}

function classNames(node: Element): string[] {
  // hast carries className as an array, but rehype-raw's round trip through
  // HTML can leave a plain string; accept either.
  const value: unknown = node.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s+/);
  return [];
}

/**
 * All text under a `<code>` element. Must recurse: a clipped page that ships
 * its own highlighting arrives as `<pre><code><span>…</span></code></pre>`,
 * and the sanitizer strips those spans' attributes but keeps the elements, so
 * reading only direct text children would silently render an empty block.
 */
function codeText(node: Element): string {
  let text = "";
  for (const child of node.children) {
    if (child.type === "text") text += child.value;
    else if (child.type === "element") text += codeText(child);
  }
  return text;
}

/**
 * Syntax-highlight every fenced code block with Shiki.
 *
 * Must run **after** rehype-sanitize (ADR 0009). Shiki's output carries a
 * `class` on the `<pre>` and an inline `style` on every token span, none of
 * which the sanitize schema allows — and widening it to let them through would
 * grant the same permission to clipped markup, which is exactly what the schema
 * exists to distrust. Running afterwards, the only input is the code's text and
 * Shiki escapes everything it emits.
 */
export function rehypeShiki() {
  return (tree: Root): void => {
    visit(tree, "element", (node, index, parent) => {
      if (node.tagName !== "pre" || parent === undefined || index === undefined)
        return;
      const code = node.children.find(
        (child): child is Element =>
          child.type === "element" && child.tagName === "code",
      );
      if (code === undefined) return;

      const classes = classNames(code);
      // `language-math` is remark-math's marker for a display formula. KaTeX
      // owns those; highlighting one would consume it before KaTeX ran.
      if (classes.includes("language-math")) return;

      const info = classes
        .find((name) => name.startsWith("language-"))
        ?.slice("language-".length);
      // remark-rehype terminates the code text with a newline; passing it
      // through would give every block a trailing blank line.
      const text = codeText(code).replace(/\n$/, "");
      const highlighted = highlighter.codeToHast(text, {
        lang: languageFor(info),
        theme: THEME,
      });
      const root = highlighted.children[0];
      if (root?.type === "element") {
        // Shiki paints its theme's background and base color inline on the
        // <pre>. Dropping them leaves the site's own warm code-block styling
        // in charge (global.css: "one warm dark code theme in both modes")
        // and keeps only the token colors from the theme — no !important
        // needed to win against an inline style.
        if (root.properties !== undefined) root.properties.style = undefined;
        parent.children[index] = root;
      }
      return "skip";
    });
  };
}
