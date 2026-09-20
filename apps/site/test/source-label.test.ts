import { describe, expect, test } from "bun:test";
import { sourceLabel } from "../src/lib/source-label.ts";

describe("sourceLabel", () => {
  test("links a web article to its origin", () => {
    expect(
      sourceLabel({
        url: "https://example.com/posts/a",
        domain: "example.com",
      }),
    ).toEqual({ name: "example.com", href: "https://example.com/posts/a" });
  });

  test("names an imported document instead of linking it", () => {
    // A local: URL opens nothing, and a chip that looks like a link and does
    // nothing is worse than a label (ADR 0027).
    expect(
      sourceLabel({ url: "local:stacked-prs-guide.pdf", domain: "local" }),
    ).toEqual({ name: "stacked-prs-guide.pdf", href: null });
  });

  test("shows the filename rather than the stored sentinel", () => {
    // "local" is the right thing to keep in the vault and the wrong thing to
    // show a reader: the filename is the only part that says which document
    // this is.
    expect(
      sourceLabel({ url: "local:Q3%20Report.pdf", domain: "local" }).name,
    ).toBe("Q3 Report.pdf");
  });

  test("keeps a CJK name legible even though the slug loses it", () => {
    expect(
      sourceLabel({
        url: "local:%E5%90%8C%E6%AD%A5%E8%AE%BE%E8%AE%A1.pdf",
        domain: "local",
      }).name,
    ).toBe("同步设计.pdf");
  });

  test("is not fooled by a web URL that mentions local:", () => {
    const label = sourceLabel({
      url: "https://example.com/local:a.pdf",
      domain: "example.com",
    });
    expect(label.href).not.toBeNull();
  });
});
