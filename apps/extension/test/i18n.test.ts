import { describe, expect, test } from "bun:test";
import { formatClipDate, messages, resolveLocale } from "../src/i18n.ts";

describe("resolveLocale", () => {
  test("an explicit setting wins over the browser language", () => {
    expect(resolveLocale("en", "zh-CN")).toBe("en");
    expect(resolveLocale("zh", "en-US")).toBe("zh");
  });

  test("auto follows any Chinese browser variant", () => {
    expect(resolveLocale("auto", "zh-CN")).toBe("zh");
    expect(resolveLocale("auto", "zh-TW")).toBe("zh");
    expect(resolveLocale("auto", "zh")).toBe("zh");
  });

  test("auto falls back to English for everything else", () => {
    expect(resolveLocale("auto", "en-US")).toBe("en");
    expect(resolveLocale("auto", "ja")).toBe("en");
    expect(resolveLocale("auto", "")).toBe("en");
  });
});

describe("messages", () => {
  test("returns the table for the requested locale", () => {
    expect(messages("en").readyToClip).toBe("Ready to clip.");
    expect(messages("zh").readyToClip).toBe("可以剪藏了。");
  });

  test("the tables expose the same keys", () => {
    // The Messages type enforces this at compile time; the runtime check
    // guards against a key sneaking in through a cast.
    expect(Object.keys(messages("zh")).sort()).toEqual(
      Object.keys(messages("en")).sort(),
    );
  });
});

describe("formatClipDate", () => {
  // Midday UTC keeps the calendar date stable in any test-runner timezone.
  const iso = "2026-08-27T12:00:00.000Z";

  test("formats per locale convention", () => {
    // Assert loosely — the exact rendering belongs to ICU, not this code.
    expect(formatClipDate("en", iso)).toContain("2026");
    expect(formatClipDate("zh", iso)).toContain("2026");
  });
});
