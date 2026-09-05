import { describe, expect, test } from "bun:test";
import { dateLabel, pageNote } from "../src/lib/strings.ts";

const NOW = new Date("2026-09-05T08:00:00.000Z");

describe("dateLabel", () => {
  test("drops the year within the current year", () => {
    expect(dateLabel("2026-09-03T14:20:00.000Z", NOW)).toBe("9 月 3 日");
  });

  test("keeps the year for older clips", () => {
    expect(dateLabel("2025-12-01T00:00:00.000Z", NOW)).toBe(
      "2025 年 12 月 1 日",
    );
  });

  test("uses the UTC date, like the ISO string it comes from", () => {
    expect(dateLabel("2025-12-31T23:30:00.000Z", NOW)).toBe(
      "2025 年 12 月 31 日",
    );
  });
});

describe("pageNote", () => {
  test("reads position and total", () => {
    expect(pageNote(1, 4, 40)).toBe("第 1 / 4 页 · 共 40 篇");
  });
});
