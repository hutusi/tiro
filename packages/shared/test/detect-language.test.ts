import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectLanguage } from "../src/detect-language.ts";

/**
 * Every bare fence in the live vault, with the language a reader would give it.
 * The filename carries the expectation — `plain` meaning "leave it alone" — so
 * adding a case is dropping in a file.
 *
 * This is the corpus the detector exists for, and its shape is the point: 24 of
 * the 40 must come back `null` — 17 because they are English prose a source
 * author fenced for display, and 7 because they are markdown documents and
 * markdown inference was deliberately removed. A rule that fires eagerly fails
 * here loudly rather than in production.
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

  /**
   * Markdown is not inferred at all — `# ` is a heading and a comment, and
   * nothing inside a block settles which. Three rules tried, each defeated by
   * a four-line script within a round; the owner chose to stop trading. The
   * frontmatter rule went with it, though it was never implicated.
   */
  test("does not infer markdown, by decision", () => {
    for (const document of [
      "# Guide\n\n## Setup\n\n- install it\n- run it\n\nThen you are done.",
      "# Delivering work\nThe request sets the scope, and the scope is the deliverable.",
      "---\nname: verifier\ntools: Bash\n---\nStart the app.\n",
    ]) {
      expect(detectLanguage(document)).toBeNull();
    }
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
    // `Author: J. Ortiz. Status: draft.` reads exactly like a mapping. The
    // heading guard refuses it: the block is a document of some kind, and the
    // rule declines rather than claim it.
    expect(
      detectLanguage(
        "# Intent\nAuthor: J. Ortiz. Status: draft.\n\n## Problem\nCustomers phone in.\n\n## Outcome\nThey stop.",
      ),
    ).not.toBe("yaml");
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
      "sql, unpunctuated":
        "Select a source from the list\nCreate table rows for each item",
      "sql, imperative":
        "Update your settings from the menu\nDelete from the list any row you do not want",
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
    // Every SQL form, because the rules were rebuilt on operands rather than
    // keyword position: an identifier after FROM, a typed column, a VALUES
    // tuple, a literal comparison.
    for (const sql of [
      "SELECT id, name\nFROM users\nWHERE active = true;",
      "select u.name\nfrom users u\njoin orgs o on o.id = u.org_id",
      "CREATE TABLE users (\n  id INT PRIMARY KEY,\n  name TEXT\n);",
      "INSERT INTO users (id, name) VALUES (1, 'a');",
      "UPDATE users SET active = false WHERE id = 3;",
      "select *\nfrom orders\nwhere total > 100\norder by created_at desc",
    ]) {
      expect(detectLanguage(sql)).toBe("sql");
    }
    expect(
      detectLanguage("FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci"),
    ).toBe("docker");
    expect(
      detectLanguage(
        "export interface User {\n  id: number;\n}\nconst name: string = u.name;",
      ),
    ).toBe("typescript");
  });

  test("does not take a commented shell script for anything", () => {
    for (const script of [
      "# Install\nnpm install\n# Run\nnpm start",
      "# Install\nnpm install\n## Run\nnpm start",
      "# Install deps\nnpm ci\n# Build\nnpm run build\n# Deploy\nnpm run deploy",
      // A command that echoes a whole sentence. Full stops are a habit of
      // prose, not a property of it, and the rule that rested on them fell to
      // exactly this.
      "# Install\nnpm install\n## Explain\necho This command installs every required package.",
    ]) {
      expect(detectLanguage(script)).toBeNull();
    }
  });

  test("returns null for ASCII art", () => {
    expect(
      detectLanguage("       /\\\n      /  \\\n     /what\\\n    /------\\"),
    ).toBeNull();
  });
});
