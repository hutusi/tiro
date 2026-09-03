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

  test("returns null for ASCII art", () => {
    expect(
      detectLanguage("       /\\\n      /  \\\n     /what\\\n    /------\\"),
    ).toBeNull();
  });
});
