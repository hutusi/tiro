import { describe, expect, test } from "bun:test";
import {
  canonicalLanguage,
  languageFromFilename,
  languageFromLabel,
} from "../src/languages.ts";

describe("languageFromLabel", () => {
  test("resolves display names as a tab writes them", () => {
    expect(languageFromLabel("Python")).toBe("python");
    expect(languageFromLabel("TypeScript")).toBe("typescript");
    expect(languageFromLabel("C#")).toBe("csharp");
    expect(languageFromLabel("C++")).toBe("cpp");
    expect(languageFromLabel("Objective-C")).toBe("objective-c");
  });

  test("normalizes case and inner whitespace", () => {
    expect(languageFromLabel("  RUST  ")).toBe("rust");
    expect(languageFromLabel("Shell   Session")).toBe("shellsession");
    // Whitespace collapses but does not fold to a hyphen, so both spellings
    // of a hyphenated name need to be present.
    expect(languageFromLabel("objective c")).toBe("objective-c");
    expect(languageFromLabel("Objective-C")).toBe("objective-c");
  });

  test("maps names that describe a snippet rather than a language", () => {
    // A cURL tab holds a shell invocation; a Node.js tab holds JavaScript.
    expect(languageFromLabel("cURL")).toBe("bash");
    expect(languageFromLabel("Node.js")).toBe("javascript");
  });

  /**
   * The reason this module is an allowlist. Every one of these appears in a
   * code block's chrome where a language name would, and any of them written
   * into a fence is a wrong language in the vault forever.
   */
  test("refuses chrome words that are not languages", () => {
    for (const label of [
      "Copy",
      "Output",
      "Response",
      "Request",
      "Terminal",
      "Example",
      "Result",
      "Preview",
      "Expand",
    ]) {
      expect(languageFromLabel(label)).toBeNull();
    }
  });

  test("refuses empty and sentence-length text", () => {
    expect(languageFromLabel("")).toBeNull();
    expect(languageFromLabel("   ")).toBeNull();
    expect(languageFromLabel("Copy this into your terminal to run")).toBeNull();
  });
});

describe("languageFromFilename", () => {
  test("reads the extension", () => {
    expect(languageFromFilename("app.ts")).toBe("typescript");
    expect(languageFromFilename("main.rs")).toBe("rust");
    expect(languageFromFilename("styles.css")).toBe("css");
  });

  test("drops directories before reading the extension", () => {
    expect(languageFromFilename("src/index.ts")).toBe("typescript");
    expect(languageFromFilename("a/b/c/main.go")).toBe("go");
    // The length cap is about the basename. A long directory says nothing
    // about whether the file it holds is named like a language.
    expect(languageFromFilename("a-very-long-directory-name/app.ts")).toBe(
      "typescript",
    );
  });

  test("resolves filenames that carry no extension", () => {
    expect(languageFromFilename("Dockerfile")).toBe("docker");
    expect(languageFromFilename("Makefile")).toBe("make");
  });

  test("prefers a whole-name match over the extension table", () => {
    // Both would resolve; tsconfig.json is jsonc because it permits comments.
    expect(languageFromFilename("tsconfig.json")).toBe("jsonc");
    expect(languageFromFilename("other.json")).toBe("json");
  });

  test("treats a leading dot as a dotfile, not an extension", () => {
    expect(languageFromFilename(".env")).toBeNull();
  });

  test("refuses unknown extensions and empty input", () => {
    expect(languageFromFilename("notes.xyz")).toBeNull();
    expect(languageFromFilename("README")).toBeNull();
    expect(languageFromFilename("")).toBeNull();
  });
});

describe("canonicalLanguage", () => {
  test("resolves the machine spellings a fence uses", () => {
    expect(canonicalLanguage("shell-session")).toBe("shellsession");
    expect(canonicalLanguage("sh-session")).toBe("shellsession");
    expect(canonicalLanguage("command-line")).toBe("shellsession");
    expect(canonicalLanguage("ts")).toBe("typescript");
    expect(canonicalLanguage("golang")).toBe("go");
    expect(canonicalLanguage("dockerfile")).toBe("docker");
  });

  test("folds the plain-text spellings together", () => {
    for (const one of ["text", "txt", "plain", "plaintext", ""]) {
      expect(canonicalLanguage(one)).toBe("plaintext");
    }
  });

  test("passes an unrecognised but plausible id through", () => {
    // The site's grammar list decides what can be rendered, not this table —
    // erasing an id here would lose a language Shiki may well know.
    expect(canonicalLanguage("exoticlang")).toBe("exoticlang");
    expect(canonicalLanguage("not a language")).toBeNull();
  });

  test("is more generous than the chrome reader, deliberately", () => {
    // A fence info string was written by an author naming a language; a tab
    // label is untrusted page text where a wrong match reaches the vault.
    expect(canonicalLanguage("output")).toBe("output");
    expect(languageFromLabel("Output")).toBeNull();
  });
});
