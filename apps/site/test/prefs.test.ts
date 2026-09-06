import { describe, expect, test } from "bun:test";
import {
  clampFontSize,
  FONT_SIZE,
  isLayoutWidth,
  isPaper,
} from "../src/lib/prefs.ts";

describe("isPaper", () => {
  test("accepts the three papers", () => {
    expect(isPaper("cream")).toBe(true);
    expect(isPaper("white")).toBe(true);
    expect(isPaper("dark")).toBe(true);
  });

  test("rejects anything else, including null from an empty store", () => {
    expect(isPaper("blue")).toBe(false);
    expect(isPaper(null)).toBe(false);
    expect(isPaper(undefined)).toBe(false);
    expect(isPaper(1)).toBe(false);
  });
});

describe("isLayoutWidth", () => {
  test("accepts the three steps", () => {
    expect(isLayoutWidth("compact")).toBe(true);
    expect(isLayoutWidth("standard")).toBe(true);
    expect(isLayoutWidth("wide")).toBe(true);
  });

  test("rejects anything else, including a raw width", () => {
    expect(isLayoutWidth("1040px")).toBe(false);
    expect(isLayoutWidth("widest")).toBe(false);
    expect(isLayoutWidth(null)).toBe(false);
  });
});

describe("clampFontSize", () => {
  test("parses a stored string", () => {
    expect(clampFontSize("19")).toBe(19);
    expect(clampFontSize(21)).toBe(21);
  });

  test("falls back to the default for garbage", () => {
    expect(clampFontSize("abc")).toBe(FONT_SIZE.default);
    expect(clampFontSize(null)).toBe(FONT_SIZE.default);
    expect(clampFontSize("")).toBe(FONT_SIZE.default);
  });

  test("pulls out-of-range values back to the bounds", () => {
    expect(clampFontSize("9")).toBe(FONT_SIZE.min);
    expect(clampFontSize("40")).toBe(FONT_SIZE.max);
  });

  test("rounds fractional sizes", () => {
    expect(clampFontSize("18.7")).toBe(19);
    expect(clampFontSize("18.2")).toBe(18);
  });
});
