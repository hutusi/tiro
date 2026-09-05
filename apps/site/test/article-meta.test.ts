import { describe, expect, test } from "bun:test";
import type { ArticleFrontmatter } from "@tiro/shared";
import {
  articleMeta,
  articleStatus,
  liftTitles,
  normalizeTitle,
} from "../src/lib/article-meta.ts";

function frontmatter(
  overrides: {
    lang?: string;
    processed_at?: string;
    translation_failed?: boolean;
  } = {},
): ArticleFrontmatter {
  const { lang, processed_at, translation_failed } = overrides;
  return {
    url: "https://example.com/posts/hello",
    title: "Hello",
    domain: "example.com",
    clipped_at: "2026-08-20T09:00:00.000Z",
    ...(lang === undefined ? {} : { lang }),
    tiro: {
      schema: 1,
      ...(processed_at === undefined ? {} : { processed_at }),
      ...(translation_failed === undefined ? {} : { translation_failed }),
    },
  };
}

const PROCESSED = "2026-08-20T09:35:00.000Z";

describe("articleStatus", () => {
  test("a clip nobody has processed is pending, whatever its language", () => {
    expect(articleStatus(frontmatter())).toBe("pending");
    expect(articleStatus(frontmatter({ lang: "zh" }))).toBe("pending");
  });

  test("a processed Chinese original needs no translation", () => {
    expect(
      articleStatus(frontmatter({ lang: "zh", processed_at: PROCESSED })),
    ).toBe("zh-original");
  });

  test("a rejected translation is reported, not hidden", () => {
    expect(
      articleStatus(
        frontmatter({
          lang: "en",
          processed_at: PROCESSED,
          translation_failed: true,
        }),
      ),
    ).toBe("untranslated");
  });

  test("everything else is translated", () => {
    expect(
      articleStatus(frontmatter({ lang: "en", processed_at: PROCESSED })),
    ).toBe("translated");
  });
});

describe("liftTitles", () => {
  test("lifts a mirrored H1 pair into a Chinese title", () => {
    expect(
      liftTitles("# Hello, AI\n\nBody.", "# 你好，AI\n\n正文。", "Hello, AI"),
    ).toEqual({ titleZh: "你好，AI", liftedH1: true });
  });

  test("a body without a leading H1 lifts nothing", () => {
    expect(
      liftTitles("Body first.\n\n# Later", "正文。\n\n# 后面", "Later"),
    ).toEqual({ titleZh: null, liftedH1: false });
  });

  test("a leading H1 with no translation is still lifted", () => {
    expect(liftTitles("# Hello\n\nBody.", null, "Hello")).toEqual({
      titleZh: null,
      liftedH1: true,
    });
  });

  test("never lifts when the translation does not open with an H1", () => {
    expect(
      liftTitles("# Hello\n\nBody.", "## 你好\n\n正文。", "Hello"),
    ).toEqual({ titleZh: null, liftedH1: false });
    expect(liftTitles("# Hello\n\nBody.", "你好。\n\n正文。", "Hello")).toEqual(
      {
        titleZh: null,
        liftedH1: false,
      },
    );
  });

  test("an H2 is not a title", () => {
    expect(liftTitles("## Section\n\nBody.", null, "Section").liftedH1).toBe(
      false,
    );
  });

  test("an opening H1 that is not the title is content and stays", () => {
    expect(
      liftTitles("# Introduction\n\nBody.", "# 简介\n\n正文。", "A Long Essay"),
    ).toEqual({ titleZh: null, liftedH1: false });
    // A scraped <title> with a site suffix does not match either — safe side.
    expect(
      liftTitles("# Hello\n\nBody.", "# 你好\n\n正文。", "Hello | Example")
        .liftedH1,
    ).toBe(false);
  });

  test("matches the title across case, whitespace and quote style", () => {
    expect(
      liftTitles(
        "# Fermat’s   Last Theorem\n\nBody.",
        "# 费马大定理\n\n正文。",
        "fermat's last theorem",
      ),
    ).toEqual({ titleZh: "费马大定理", liftedH1: true });
  });

  test("uses the heading's plain text, not its markdown source", () => {
    expect(
      liftTitles(
        "# Hello *AI* #\n\nBody.",
        "# 你好 *AI* ##\n\n正文。",
        "Hello AI",
      ),
    ).toEqual({ titleZh: "你好 AI", liftedH1: true });
    expect(
      liftTitles("# Learn C#\n\nBody.", "# 学 C#\n\n正文。", "Learn C#")
        .titleZh,
    ).toBe("学 C#");
    expect(
      liftTitles(
        "# [Linked](https://x.y) `code`\n\nBody.",
        "# 链接 `代码`\n\n正文。",
        "Linked code",
      ).titleZh,
    ).toBe("链接 代码");
  });

  test("a setext H1 counts as an H1 too", () => {
    expect(liftTitles("Hello\n=====\n\nBody.", null, "Hello").liftedH1).toBe(
      true,
    );
  });
});

describe("normalizeTitle", () => {
  test("folds quotes, dashes, case and whitespace", () => {
    expect(normalizeTitle("  “Smart” — Quotes’  ")).toBe('"smart" - quotes\'');
    expect(normalizeTitle("Ａ　ｂ")).toBe("a b");
  });
});

describe("articleMeta", () => {
  test("combines the derivations and memoizes per article object", () => {
    const article = {
      frontmatter: frontmatter({ lang: "en", processed_at: PROCESSED }),
      body: "# Hello\n\nBody text here.",
      zhBody: "# 你好\n\n正文。",
    };
    const meta = articleMeta(article);
    expect(meta).toEqual({
      minutes: 1,
      status: "translated",
      titleZh: "你好",
      liftedH1: true,
    });
    expect(articleMeta(article)).toBe(meta);
  });
});
