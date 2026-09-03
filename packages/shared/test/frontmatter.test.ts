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
    expect(
      ArticleFrontmatterSchema.parse({ ...validClip, unknown_field: 1 }),
    ).not.toHaveProperty("unknown_field");
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
