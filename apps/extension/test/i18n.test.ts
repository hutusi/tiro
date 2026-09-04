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

  /**
   * Key parity is not enough: the Chinese disclosure once kept describing only
   * a read of the current page for a whole release after the English one
   * gained arxiv.org, because an edit matched the English string and silently
   * missed the Chinese. The UI language here is Chinese, so that was the copy
   * the owner actually saw.
   *
   * Every host the extension may contact belongs in the disclosure, in both
   * languages. Add the next one here.
   */
  test("both disclosures name every host the extension may contact", () => {
    for (const locale of ["en", "zh"] as const) {
      const disclosure = `${messages(locale).disclosureBody1} ${messages(locale).disclosureBody2}`;
      for (const host of ["arxiv.org", "GitHub"]) {
        expect(disclosure).toContain(host);
      }
    }
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
