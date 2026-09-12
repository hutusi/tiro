import { describe, expect, test } from "bun:test";
import {
  ArticleFrontmatterSchema,
  ClipFrontmatterSchema,
  needsProcessing,
  parseArticle,
  stringifyArticle,
} from "../src/frontmatter.ts";

const validClip = {
  url: "https://example.com/posts/hello-ai",
  title: "Hello, AI",
  domain: "example.com",
  clipped_at: "2026-08-22T10:00:00.000Z",
  tiro: { schema: 1 },
};

describe("frontmatter schemas", () => {
  test("accepts a minimal clip", () => {
    expect(ClipFrontmatterSchema.safeParse(validClip).success).toBe(true);
  });

  test("rejects a clip without a url", () => {
    const { url: _url, ...rest } = validClip;
    expect(ClipFrontmatterSchema.safeParse(rest).success).toBe(false);
  });

  test("rejects an unknown schema version", () => {
    expect(
      ClipFrontmatterSchema.safeParse({ ...validClip, tiro: { schema: 2 } })
        .success,
    ).toBe(false);
  });

  test("round-trips the optional has_math flag", () => {
    const parsed = ClipFrontmatterSchema.parse({
      ...validClip,
      has_math: true,
    });
    expect(parsed.has_math).toBe(true);
  });

  test("accepts an article with no has_math — the field is additive", () => {
    // Why this matters: `has_math` arriving without a tiro.schema bump is only
    // safe because old articles validate unchanged and unknown keys are
    // stripped rather than rejected (ADR 0009).
    const parsed = ArticleFrontmatterSchema.parse(validClip);
    expect(parsed.has_math).toBeUndefined();
    expect(parsed.title_zh).toBeUndefined();
    expect(parsed.summary_orig).toBeUndefined();
    expect(
      ArticleFrontmatterSchema.parse({ ...validClip, unknown_field: 1 }),
    ).not.toHaveProperty("unknown_field");
  });

  test("carries a translated title and a source-language summary", () => {
    const parsed = ArticleFrontmatterSchema.parse({
      ...validClip,
      lang: "en",
      title_zh: "你好，AI",
      summary: "一句中文摘要。",
      summary_orig: "One English summary.",
    });
    expect(parsed.title_zh).toBe("你好，AI");
    expect(parsed.summary_orig).toBe("One English summary.");
  });

  test("rejects a blank translated title or source-language summary", () => {
    // Neither an empty string nor whitespace is a translation, and the
    // difference matters: a blank string is truthy on the site, so it would
    // suppress the fallback title and render an empty line in its place.
    for (const blank of ["", "   ", "\n\t"]) {
      expect(
        ArticleFrontmatterSchema.safeParse({ ...validClip, title_zh: blank })
          .success,
      ).toBe(false);
      expect(
        ArticleFrontmatterSchema.safeParse({
          ...validClip,
          summary_orig: blank,
        }).success,
      ).toBe(false);
    }
  });

  test("normalizes surrounding whitespace, and only that", () => {
    const parsed = ArticleFrontmatterSchema.parse({
      ...validClip,
      title_zh: "  你好，AI  ",
      summary_orig: "\n  One English summary.  ",
    });
    expect(parsed.title_zh).toBe("你好，AI");
    expect(parsed.summary_orig).toBe("One English summary.");
    // Inner spacing is content — a title mixing scripts needs it.
    expect(
      ArticleFrontmatterSchema.parse({
        ...validClip,
        title_zh: "为 Claude Fable 5.1 编写提示词",
      }).title_zh,
    ).toBe("为 Claude Fable 5.1 编写提示词");
  });

  test("the clip schema does not carry a translated title", () => {
    // The deliberate inverse of the provenance round-trip below: these two are
    // written by the processor, not the clipper, so the clip schema must strip
    // them — a re-clip may be clipping a page whose title has changed, and it
    // clears tiro.processed_at, so the next run writes them again.
    const clipped = ClipFrontmatterSchema.parse({
      ...validClip,
      title_zh: "你好，AI",
      summary_orig: "One English summary.",
    });
    expect(clipped).not.toHaveProperty("title_zh");
    expect(clipped).not.toHaveProperty("summary_orig");
  });

  test("normalizes YAML Date objects to ISO strings", () => {
    const parsed = ArticleFrontmatterSchema.parse({
      ...validClip,
      clipped_at: new Date("2026-08-22T10:00:00.000Z"),
    });
    expect(parsed.clipped_at).toBe("2026-08-22T10:00:00.000Z");
  });
});

describe("needsProcessing", () => {
  test("true without a processed marker, false with one", () => {
    const raw = ArticleFrontmatterSchema.parse(validClip);
    expect(needsProcessing(raw)).toBe(true);
    const done = ArticleFrontmatterSchema.parse({
      ...validClip,
      tiro: { schema: 1, processed_at: "2026-08-22T11:00:00.000Z" },
    });
    expect(needsProcessing(done)).toBe(false);
  });
});

describe("parseArticle / stringifyArticle", () => {
  test("round-trips an article with a YAML-hostile title", () => {
    const frontmatter = ArticleFrontmatterSchema.parse({
      ...validClip,
      title: 'Tools: a "practical" guide #1 — 中文标题',
    });
    const body = "# Heading\n\nA paragraph.\n";
    const text = stringifyArticle(frontmatter, body);
    const back = parseArticle(text);
    expect(back.frontmatter).toEqual(frontmatter);
    expect(back.body).toBe(body);
  });

  test("round-trips a YAML-hostile translated title", () => {
    // A translated title is likelier than the original to carry the characters
    // YAML argues with: a full-width colon reads as a mapping separator to a
    // reader that normalizes width, and quotes come free with the model.
    const frontmatter = ArticleFrontmatterSchema.parse({
      ...validClip,
      lang: "en",
      title_zh: 'KAN：柯尔莫哥洛夫–阿诺德网络 "笔记" #1',
    });
    const back = parseArticle(stringifyArticle(frontmatter, "Body.\n"));
    expect(back.frontmatter.title_zh).toBe(
      'KAN：柯尔莫哥洛夫–阿诺德网络 "笔记" #1',
    );
  });

  test("preserves the clipper's provenance through a processor round-trip", () => {
    // The trap this guards: zod strips keys an object does not name, and the
    // processor reparses and rewrites frontmatter on every run — so a field the
    // clipper records but ArticleFrontmatterSchema omits is not merely
    // unvalidated, it is deleted the first time the article is processed.
    const clipped = ArticleFrontmatterSchema.parse({
      ...validClip,
      tiro: {
        schema: 1,
        clipper_version: "0.7.0",
        clipper_commit: "ext-v0.7.0-3-gabc1234",
      },
    });
    expect(clipped.tiro.clipper_version).toBe("0.7.0");
    expect(clipped.tiro.clipper_commit).toBe("ext-v0.7.0-3-gabc1234");

    // What the processor does: parse what is on disk, add its own markers,
    // write it back.
    const processed = parseArticle(
      stringifyArticle(
        {
          ...clipped,
          tiro: {
            ...clipped.tiro,
            processed_at: "2026-08-22T11:00:00.000Z",
            processor_version: "0.1.0",
          },
        },
        "Body.\n",
      ),
    );
    expect(processed.frontmatter.tiro).toEqual({
      schema: 1,
      clipper_version: "0.7.0",
      clipper_commit: "ext-v0.7.0-3-gabc1234",
      processed_at: "2026-08-22T11:00:00.000Z",
      processor_version: "0.1.0",
    });
  });

  test("preserves the URL the body was read from through a processor round-trip", () => {
    // Same trap as above, and the one that would hurt most: for a canonicalized
    // publisher the article is filed under a URL nobody visited, so source_url
    // is the only record of which form produced the text — and of the arXiv
    // version, which is deliberately not part of the identity.
    const clipped = ArticleFrontmatterSchema.parse({
      ...validClip,
      url: "https://arxiv.org/abs/2404.19756",
      tiro: {
        schema: 1,
        clipper_version: "0.12.0",
        source_url: "https://arxiv.org/html/2404.19756v1",
      },
    });
    const processed = parseArticle(
      stringifyArticle(
        {
          ...clipped,
          tiro: {
            ...clipped.tiro,
            processed_at: "2026-09-04T11:00:00.000Z",
            processor_version: "0.1.0",
          },
        },
        "Body.\n",
      ),
    );
    expect(processed.frontmatter.tiro.source_url).toBe(
      "https://arxiv.org/html/2404.19756v1",
    );
  });

  test("preserves an unlisted article's flag through a processor round-trip", () => {
    // Same trap as the two above, and the one with the worst failure mode: the
    // flag is set by hand and the loss is silent, so an article hidden on
    // purpose would quietly rejoin the library the next time it is processed.
    const flagged = ArticleFrontmatterSchema.parse({
      ...validClip,
      unlisted: true,
    });
    const processed = parseArticle(
      stringifyArticle(
        {
          ...flagged,
          lang: "en",
          summary: "A summary.",
          tiro: {
            ...flagged.tiro,
            processed_at: "2026-09-12T11:00:00.000Z",
            processor_version: "0.1.0",
          },
        },
        "Body.\n",
      ),
    );
    expect(processed.frontmatter.unlisted).toBe(true);
  });

  test("leaves an ordinary article's unlisted flag absent, not false", () => {
    // The site asks `unlisted === true`; an article that never carried the key
    // must round-trip without gaining one, or every vault file would grow a
    // line the first time it is processed.
    const frontmatter = ArticleFrontmatterSchema.parse(validClip);
    const back = parseArticle(stringifyArticle(frontmatter, "Body.\n"));
    expect(back.frontmatter.unlisted).toBeUndefined();
    expect(stringifyArticle(frontmatter, "Body.\n")).not.toContain("unlisted");
  });

  test("parses an unquoted YAML timestamp (js-yaml Date) into a string", () => {
    const text = [
      "---",
      "url: https://example.com/posts/hello-ai",
      "title: Hello",
      "domain: example.com",
      "clipped_at: 2026-08-22T10:00:00.000Z",
      "tiro:",
      "  schema: 1",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    const { frontmatter } = parseArticle(text);
    expect(frontmatter.clipped_at).toBe("2026-08-22T10:00:00.000Z");
  });

  test("throws on schema violations", () => {
    expect(() => parseArticle("---\ntitle: No url\n---\nBody.\n")).toThrow();
  });
});
