import { describe, expect, test } from "bun:test";
import { monthLabel } from "../src/lib/strings.ts";

describe("monthLabel", () => {
  test("formats a YYYY-MM month as a Chinese label", () => {
    expect(monthLabel("2026-08")).toBe("2026 年 8 月");
  });

  test("keeps two-digit months intact", () => {
    expect(monthLabel("2026-12")).toBe("2026 年 12 月");
  });

  test("strips the leading zero from single-digit months", () => {
    expect(monthLabel("2025-01")).toBe("2025 年 1 月");
  });
});
