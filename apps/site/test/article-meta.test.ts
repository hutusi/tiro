import { describe, expect, test } from "bun:test";
import type { ArticleFrontmatter } from "@tiro/shared";
import {
  articleMeta,
  articleStatus,
  liftTitles,
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
    expect(liftTitles("# Hello, AI\n\nBody.", "# 你好，AI\n\n正文。")).toEqual({
      titleZh: "你好，AI",
      liftedH1: true,
    });
  });

  test("a body without a leading H1 lifts nothing", () => {
    expect(liftTitles("Body first.\n\n# Later", "正文。\n\n# 后面")).toEqual({
      titleZh: null,
      liftedH1: false,
    });
  });

  test("a leading H1 with no translation is still lifted", () => {
    expect(liftTitles("# Hello\n\nBody.", null)).toEqual({
      titleZh: null,
      liftedH1: true,
    });
  });

  test("never lifts when the translation does not open with an H1", () => {
    expect(liftTitles("# Hello\n\nBody.", "## 你好\n\n正文。")).toEqual({
      titleZh: null,
      liftedH1: false,
    });
    expect(liftTitles("# Hello\n\nBody.", "你好。\n\n正文。")).toEqual({
      titleZh: null,
      liftedH1: false,
    });
  });

  test("an H2 is not a title", () => {
    expect(liftTitles("## Section\n\nBody.", null).liftedH1).toBe(false);
  });

  test("strips a closing hash run but keeps a hash inside the text", () => {
    expect(
      liftTitles("# Title #\n\nBody.", "# 标题 ##\n\n正文。").titleZh,
    ).toBe("标题");
    expect(liftTitles("# Learn C#\n\nBody.", "# 学 C#\n\n正文。").titleZh).toBe(
      "学 C#",
    );
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
