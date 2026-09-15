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
   * Every place the data may end up belongs in the disclosure, in both
   * languages. Add the next one here. Chrome is in the list because settings
   * sync hands the token to it to replicate — not a host the extension calls,
   * but a destination all the same, and the one most easily left out of the
   * Chinese copy since neither string names it in translation.
   */
  test("both disclosures name every destination the data may reach", () => {
    for (const locale of ["en", "zh"] as const) {
      const disclosure = `${messages(locale).disclosureBody1} ${messages(locale).disclosureBody2}`;
      for (const host of [
        "arxiv.org",
        "raw.githubusercontent.com",
        "GitHub",
        "Chrome",
      ]) {
        expect(disclosure).toContain(host);
      }
    }
  });

  /**
   * Key parity does not reach meaning, and this is the second time a Chinese
   * string lagged its English counterpart — the first was the disclosure
   * above. An edit matched the English `denied`, missed the Chinese, and the
   * popup went on telling a Chinese reader it would clip the page it had just
   * refused to clip.
   *
   * The invariant, stated where both locales have to satisfy it: a publisher
   * that offers a way out instead of falling back (`instead !== null`) must not
   * have copy promising the fallback, and one that *does* fall back must say
   * so. Whether a publisher degrades lives in `fetch-source.ts`; this is the
   * half a translator can break.
   */
  test.each(["en", "zh"] as const)(
    "%s copy agrees with whether the publisher falls back",
    (locale) => {
      const fallback = locale === "en" ? "the page you are on" : "当前页面";
      const { arxiv, github } = messages(locale).fetchSources;
      // arXiv degrades: an abstract page is a fair article, and the copy says
      // the tab is what will be clipped.
      expect(arxiv.instead).toBeNull();
      expect(arxiv.denied).toContain(fallback);
      // GitHub refuses: a rendering of the file is not the file.
      expect(github.instead).not.toBeNull();
      expect(github.denied).not.toContain(fallback);
      expect(github.failed("x")).not.toContain(fallback);
    },
  );

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
