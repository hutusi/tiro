import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excerptDek, readSavedPage, savedFrom } from "../scripts/sweep.ts";

const URL =
  "https://www.theatlantic.com/magazine/archive/1875/01/old-times/537825";

describe("savedFrom", () => {
  test("takes the address itself, or a Wayback capture of it", () => {
    expect(savedFrom(URL, URL)).toBe(true);
    expect(savedFrom(`${URL}/\n`, URL)).toBe(true);
    expect(savedFrom(`20260113105955 ${URL}/`, URL)).toBe(true);
    expect(
      savedFrom(`https://web.archive.org/web/20261003222057id_/${URL}/`, URL),
    ).toBe(true);
  });

  test("refuses another page, or another capture's", () => {
    expect(savedFrom(`${URL.replace("537825", "537828")}`, URL)).toBe(false);
    expect(
      savedFrom(
        "https://web.archive.org/web/2026id_/https://elsewhere.example/a",
        URL,
      ),
    ).toBe(false);
    expect(savedFrom("", URL)).toBe(false);
  });
});

describe("readSavedPage", () => {
  test("reads a page only when its stamp names the address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tiro-pages-"));
    writeFileSync(join(dir, "a.html"), "<p>A</p>");
    writeFileSync(join(dir, "a.html.url"), `20260113105955 ${URL}`);
    writeFileSync(join(dir, "b.html"), "<p>B</p>");
    writeFileSync(join(dir, "b.html.url"), "https://elsewhere.example/b");
    writeFileSync(join(dir, "c.html"), "<p>C</p>");
    expect(await readSavedPage(dir, "a", URL)).toBe("<p>A</p>");
    expect(await readSavedPage(dir, "b", URL)).toBeNull();
    expect(await readSavedPage(dir, "c", URL)).toBeNull();
    expect(await readSavedPage(dir, "d", URL)).toBeNull();
  });
});

describe("excerptDek", () => {
  test("is the excerpt as the page shows it, its escaped markup read", () => {
    expect(
      excerptDek(
        "Twenty-five years ago, <em>Friends</em> anticipated a time that would both romanticize and mistrust work.",
      ),
    ).toBe(
      "Twenty-five years ago, *Friends* anticipated a time that would both romanticize and mistrust work.",
    );
    expect(
      excerptDek("<span>Even when a dentist kills an adored lion.</span>"),
    ).toBe("Even when a dentist kills an adored lion.");
  });

  test("is nothing for an empty excerpt, or one that is not a paragraph", () => {
    expect(excerptDek(undefined)).toBeNull();
    expect(excerptDek("  ")).toBeNull();
    expect(excerptDek("<h2>A heading</h2><p>And a paragraph.</p>")).toBeNull();
  });
});
