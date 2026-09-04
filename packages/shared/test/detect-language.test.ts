import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectLanguage } from "../src/detect-language.ts";

/**
 * Every bare fence in the live vault, with the language a reader would give it.
 * The filename carries the expectation — `plain` meaning "leave it alone" — so
 * adding a case is dropping in a file.
 *
 * This is the corpus the detector exists for, and its shape is the point: 16 of
 * the 40 blocks are English prose that a source author fenced for display, so a
 * rule that fires eagerly fails here loudly rather than in production.
 */
const CORPUS = join(import.meta.dirname, "fixtures", "code-blocks");

describe("the vault's own code blocks", () => {
  const files = readdirSync(CORPUS)
    .filter((name) => name.endsWith(".txt"))
    .sort();

  test("the corpus is present", () => {
    expect(files.length).toBe(40);
  });

  for (const name of files) {
    const expected = name.slice(0, name.indexOf("-"));
    test(`${name} → ${expected}`, () => {
      const code = readFileSync(join(CORPUS, name), "utf-8");
      expect(detectLanguage(code)).toBe(expected === "plain" ? null : expected);
    });
  }

  test("no prose block is given a language", () => {
    const wrong = files
      .filter((name) => name.startsWith("plain-"))
      .filter(
        (name) =>
          detectLanguage(readFileSync(join(CORPUS, name), "utf-8")) !== null,
      );
    expect(wrong).toEqual([]);
  });
});

describe("detectLanguage", () => {
  test("reads a shebang before anything else", () => {
    expect(detectLanguage("#!/bin/bash\necho hi")).toBe("bash");
    expect(detectLanguage("#!/usr/bin/env python3\nx = 1")).toBe("python");
    expect(detectLanguage("#!/usr/bin/env node\nx()")).toBe("javascript");
  });

  test("recognises JSON by parsing it", () => {
    expect(detectLanguage('{"a": [1, 2], "b": null}')).toBe("json");
    // Valid JSON, but a block of prose is not a JSON document.
    expect(detectLanguage('"just a quoted sentence"')).toBeNull();
    expect(detectLanguage("42")).toBeNull();
    // Looks like JSON, does not parse — a snippet with an ellipsis.
    expect(detectLanguage('{"a": 1, ...}')).toBeNull();
  });

  test("separates a shell session from a shell script", () => {
    expect(detectLanguage("$ ls -la\ntotal 8\ndrwxr-xr-x  2 me  staff")).toBe(
      "shellsession",
    );
    expect(detectLanguage("ls -la\ncd /tmp")).toBeNull();
  });

  test("takes markdown for a document, not for a titled paragraph", () => {
    expect(
      detectLanguage(
        "# Guide\n\n## Setup\n\n- install it\n- run it\n\nThen you are done.",
      ),
    ).toBe("markdown");
    // One heading and prose: the shape of half the vault's prompt snippets.
    expect(
      detectLanguage(
        "# Delivering work\nThe request sets the scope, and the scope is the deliverable.",
      ),
    ).toBeNull();
  });

  test("takes frontmatter closed over a body as markdown", () => {
    expect(
      detectLanguage("---\nname: verifier\ntools: Bash\n---\nStart the app.\n"),
    ).toBe("markdown");
  });

  test("does not take multi-document YAML for frontmatter", () => {
    // `---` opens a YAML document and closes markdown frontmatter, so the
    // shape alone cannot tell them apart. What separates them is that a
    // markdown body is prose and a YAML body is more mappings.
    expect(
      detectLanguage(
        "---\napiVersion: v1\nkind: ConfigMap\n---\napiVersion: v1\nkind: ConfigMap",
      ),
    ).toBe("yaml");
  });

  test("reads YAML, including flow mappings", () => {
    expect(
      detectLanguage("name: build\non:\n  push:\n    branches: [main]"),
    ).toBe("yaml");
    // A `}` at end of line is a flow mapping here, not a closing brace.
    expect(
      detectLanguage("tiers:\n  one: { action: log }\n  two: { action: page }"),
    ).toBe("yaml");
  });

  test("does not read a spec's Key: value lines as YAML", () => {
    expect(
      detectLanguage(
        "# Intent\nAuthor: J. Ortiz. Status: draft.\n\n## Problem\nCustomers phone in.\n\n## Outcome\nThey stop.",
      ),
    ).toBe("markdown");
  });

  test("requires two signals before naming a language", () => {
    // `import` alone is Python, JavaScript, TypeScript or Go.
    expect(detectLanguage("import anthropic")).toBeNull();
    expect(detectLanguage("import anthropic\n\ndef main():\n    pass")).toBe(
      "python",
    );
    // One Rust-shaped line is not Rust.
    expect(detectLanguage("pub enum Colour {}")).toBeNull();
    expect(
      detectLanguage("pub enum Data {\n    A(Ipv4Addr),\n    B(Txt),\n}"),
    ).toBe("rust");
  });

  test("returns null for prose, however long", () => {
    for (const prose of [
      "Please remove all mannered prose.",
      "Before you start, say in a line what you're about to do; brief updates while you work help the user follow along.",
      "You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task.",
      "",
      "   \n  \n",
    ]) {
      expect(detectLanguage(prose)).toBeNull();
    }
  });

  /**
   * The test the design's central claim deserves, and the one that would have
   * caught three bugs at once instead of one at a time.
   *
   * Every rule below is supposed to be anchored to line starts or to
   * punctuation prose does not produce. Three were not: `select … from` and
   * `create table` matched a sentence, `: number` and `such as string` matched
   * another, and `FROM users` in a SELECT was read as a Dockerfile. Each
   * paragraph here is ordinary English seeded with one language's keywords.
   */
  test("no language's keywords fire on English prose", () => {
    const prose: Record<string, string> = {
      sql: "Select a source from the list.\nThen create table rows for each item, and order by whichever column you find clearest.",
      typescript:
        "The ratio: number of items per page, such as string values in the list, is worth tuning as const conditions change.",
      docker:
        "FROM the outset the team ran into trouble.\nCOPY was never the problem; the ADD of a second reviewer was.",
      go: "package deals are available from the func desk.\nimport duties may apply.",
      python:
        "import duties are a class of problem.\ndef the terms before you print(the contract).",
      rust: "The struct of the argument is sound.\nlet mut nobody tell you otherwise; the impl is the easy part.",
      c: "typedef is not a word.\nThe int of the matter is that void spaces printf badly.",
      javascript:
        "const conditions apply.\nlet the reader decide; var is a Scandinavian word.",
      markdown:
        "# Delivering work\nThe request sets the scope, and the scope is the deliverable.",
      yaml: "This: is a sentence with a colon.\nAnd so: is this one, at some length.",
      toml: "[bracketed asides] read like this.\nx = whatever you want it to be.",
      shellsession:
        "$5 was the price. The $ sign is used for dollars.\nRun it and see.",
    };
    const wrong = Object.entries(prose)
      .map(([name, text]) => [name, detectLanguage(text)] as const)
      .filter(([, got]) => got !== null);
    expect(wrong).toEqual([]);
  });

  test("still reads the real thing for each of those", () => {
    expect(
      detectLanguage("SELECT id, name\nFROM users\nWHERE active = true;"),
    ).toBe("sql");
    expect(
      detectLanguage("FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci"),
    ).toBe("docker");
    expect(
      detectLanguage(
        "export interface User {\n  id: number;\n}\nconst name: string = u.name;",
      ),
    ).toBe("typescript");
  });

  test("does not take a commented shell script for markdown", () => {
    // `# ` is a heading in one language and a comment in another. A heading
    // needs a second signal of a different kind — a list, or a nested depth.
    expect(
      detectLanguage("# Install\nnpm install\n# Run\nnpm start"),
    ).toBeNull();
    expect(
      detectLanguage(
        "# Install deps\nnpm ci\n# Build\nnpm run build\n# Deploy\nnpm run deploy",
      ),
    ).toBeNull();
    // Nested depth is the signal a script does not produce.
    expect(
      detectLanguage(
        "# Guide\n\n## Setup\n\nRun it.\n\n## Teardown\n\nStop it.",
      ),
    ).toBe("markdown");
  });

  test("returns null for ASCII art", () => {
    expect(
      detectLanguage("       /\\\n      /  \\\n     /what\\\n    /------\\"),
    ).toBeNull();
  });
});
