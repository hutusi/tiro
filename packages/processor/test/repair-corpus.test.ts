import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repairBody } from "../src/repair.ts";

/**
 * Byte-exact replay over the markdown shapes that actually reached the vault.
 *
 * The unit tests beside this one each pin a single behaviour, which is how
 * every defect so far was fixed — and also how two of them arrived: a change
 * that satisfied its own test corrupted a shape nobody had written a case for.
 * Both were found by replaying the repair over real articles and diffing. This
 * is that replay, kept.
 *
 * A case whose `expected.md` equals its `input.md` asserts the repair leaves it
 * alone, which is the half that regressions break.
 */
const corpusDir = join(import.meta.dir, "fixtures/repair-corpus");

describe("repair corpus", () => {
  const cases = readdirSync(corpusDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  // A corpus that silently found no cases would pass forever.
  test("the corpus is not empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const name of cases) {
    test(name, () => {
      const input = readFileSync(join(corpusDir, name, "input.md"), "utf8");
      const expected = readFileSync(
        join(corpusDir, name, "expected.md"),
        "utf8",
      );
      expect(repairBody(input)).toBe(expected);
    });
  }

  test("every case behaves identically with CRLF endings", () => {
    // One assertion covering every transform under CRLF, and every case added
    // here later. Two transforms once silently did nothing on a CRLF article
    // while the other three worked — a half-repaired file, which is worse than
    // an untouched one. repairBody normalizes at its boundary now, so the CRLF
    // result must be the LF result with the endings put back.
    for (const name of cases) {
      const input = readFileSync(join(corpusDir, name, "input.md"), "utf8");
      const expected = readFileSync(
        join(corpusDir, name, "expected.md"),
        "utf8",
      );
      expect(repairBody(input.replaceAll("\n", "\r\n"))).toBe(
        expected.replaceAll("\n", "\r\n"),
      );
    }
  });

  test("every case is idempotent", () => {
    // A repair that changes its own output is a repair that fights the next run.
    for (const name of cases) {
      const expected = readFileSync(
        join(corpusDir, name, "expected.md"),
        "utf8",
      );
      expect(repairBody(expected)).toBe(expected);
    }
  });
});
