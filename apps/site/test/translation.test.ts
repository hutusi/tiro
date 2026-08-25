import { describe, expect, test } from "bun:test";
import type { ArticleFrontmatter } from "@tiro/shared";
import { usableTranslation } from "../src/lib/translation.ts";

const PROCESSED = "2026-08-20T09:35:00.000Z";

function frontmatter(
  overrides: {
    lang?: string;
    processed_at?: string;
    translation_failed?: boolean;
  } = {},
): ArticleFrontmatter {
  const { lang = "en", processed_at, translation_failed } = overrides;
  return {
    url: "https://example.com/posts/hello",
    title: "Hello",
    domain: "example.com",
    clipped_at: "2026-08-20T09:00:00.000Z",
    lang,
    tiro: {
      schema: 1,
      ...(processed_at !== undefined ? { processed_at } : {}),
      ...(translation_failed !== undefined ? { translation_failed } : {}),
    },
  };
}

describe("usableTranslation", () => {
  test("renders a translation the frontmatter vouches for", () => {
    const fm = frontmatter({ processed_at: PROCESSED });
    expect(usableTranslation(fm, "译文")).toBe("译文");
  });

  test("ignores a translation on a pending article", () => {
    // What every re-clip produces: the extension rewrites index.md and clears
    // processed_at, but never touches the previous run's zh.md.
    expect(usableTranslation(frontmatter(), "过时的译文")).toBeNull();
  });

  test("ignores a translation beside a Chinese original", () => {
    const fm = frontmatter({ lang: "zh", processed_at: PROCESSED });
    expect(usableTranslation(fm, "不该存在的译文")).toBeNull();
  });

  test("ignores a translation the run rejected", () => {
    const fm = frontmatter({
      processed_at: PROCESSED,
      translation_failed: true,
    });
    expect(usableTranslation(fm, "未对齐的译文")).toBeNull();
  });

  test("passes null through", () => {
    expect(
      usableTranslation(frontmatter({ processed_at: PROCESSED }), null),
    ).toBeNull();
  });
});
