import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { ArticleFrontmatterSchema } from "../src/frontmatter.ts";
import {
  PREVIEW_RE,
  parseSite,
  previewFile,
  previewRef,
  type SiteFrontmatter,
  SiteFrontmatterSchema,
  stringifySite,
} from "../src/site.ts";

const saved: SiteFrontmatter = {
  url: "https://maps.example.org/roman-battles",
  title: "Battles: of the Roman Republic # 1",
  domain: "maps.example.org",
  clipped_at: "2026-10-20T08:15:00.000Z",
  description: "An interactive map.",
  preview: "./assets/54ea819b7af4.webp",
  note: "Drag the timeline slowly.",
  tiro: {
    schema: 1,
    clipper_version: "0.19.0",
    source_url: "https://maps.example.org/roman-battles/#year=-216",
  },
};

describe("site documents", () => {
  test("round-trip through their own file format", () => {
    const text = stringifySite(saved, "509 BC — 27 BC");
    const parsed = parseSite(text);
    expect(parsed.frontmatter).toEqual(saved);
    expect(parsed.body).toBe("509 BC — 27 BC\n");
  });

  test("an empty body leaves the file ending at the fence", () => {
    const text = stringifySite(saved, "");
    expect(text.endsWith("---\n")).toBe(true);
    expect(parseSite(text).body).toBe("");
  });

  // The processor adds what it derives through this schema, and zod drops
  // what it was not told about — so everything the extension writes has to
  // survive the processed schema too.
  test("keep every saved field through the processed schema", () => {
    const processed = SiteFrontmatterSchema.parse({
      ...saved,
      summary: "一张地图。",
      tags: ["可视化"],
      tiro: { ...saved.tiro, processed_at: "2026-10-20T08:20:00.000Z" },
    });
    expect(processed.note).toBe(saved.note);
    expect(processed.preview).toBe(saved.preview);
    expect(processed.description).toBe(saved.description);
    expect(processed.tiro.source_url).toBe(saved.tiro.source_url);
  });

  test("refuse a note or description that is only whitespace", () => {
    expect(() =>
      SiteFrontmatterSchema.parse({ ...saved, note: "  " }),
    ).toThrow();
    expect(() =>
      SiteFrontmatterSchema.parse({ ...saved, description: "" }),
    ).toThrow();
  });

  // Not a hard cap on read: a long hand edit is still the owner's note.
  test("accept a note longer than the popup allows", () => {
    expect(
      SiteFrontmatterSchema.parse({ ...saved, note: "x".repeat(5000) }).note,
    ).toHaveLength(5000);
  });

  // The two documents are told apart by their directory, not by shape, but a
  // site parsed as an article must not quietly pass either: it has no body
  // worth reading, and the article schema has no `preview` or `note`.
  test("are not articles", () => {
    const article = ArticleFrontmatterSchema.parse(
      parseYaml(stringifySite(saved, "").split("---")[1] ?? ""),
    );
    expect("preview" in article).toBe(false);
    expect("note" in article).toBe(false);
  });
});

describe("preview", () => {
  test("names one screenshot in the site's own assets", () => {
    expect(previewFile("./assets/54ea819b7af4.webp")).toBe("54ea819b7af4.webp");
    expect(previewRef("54ea819b7af4.webp")).toBe("./assets/54ea819b7af4.webp");
  });

  test("refuses anything else", () => {
    for (const bad of [
      "assets/54ea819b7af4.webp",
      "./assets/54ea819b7af4.png",
      "./assets/../54ea819b7af4.webp",
      "./assets/54EA819B7AF4.webp",
      "./assets/cover.webp",
      "https://example.com/54ea819b7af4.webp",
    ]) {
      expect(PREVIEW_RE.test(bad)).toBe(false);
      expect(previewFile(bad)).toBeNull();
      expect(() =>
        SiteFrontmatterSchema.parse({ ...saved, preview: bad }),
      ).toThrow();
    }
    expect(previewFile(undefined)).toBeNull();
    expect(() => previewRef("cover.webp")).toThrow();
  });
});
