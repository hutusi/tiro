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
