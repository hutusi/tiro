import { describe, expect, test } from "bun:test";
import { normalizeUrl, slugForUrl } from "../src/slug.ts";

describe("normalizeUrl", () => {
  test("strips fragments, tracking params, and trailing slashes", () => {
    expect(
      normalizeUrl(
        "https://Example.COM/Posts/Hello/?utm_source=x&utm_medium=y&fbclid=abc#section",
      ),
    ).toBe("https://example.com/Posts/Hello");
  });

  test("keeps meaningful query params", () => {
    expect(
      normalizeUrl("https://example.com/search?q=llm&utm_campaign=z"),
    ).toBe("https://example.com/search?q=llm");
  });

  test("keeps the root path slash and drops default ports", () => {
    expect(normalizeUrl("https://example.com:443/")).toBe(
      "https://example.com/",
    );
  });
});

describe("slugForUrl", () => {
  test("is deterministic", async () => {
    const a = await slugForUrl("https://example.com/posts/hello-ai");
    const b = await slugForUrl("https://example.com/posts/hello-ai");
    expect(a).toBe(b);
  });

  test("ignores tracking noise, fragments, and trailing slashes", async () => {
    const clean = await slugForUrl("https://example.com/posts/hello-ai");
    const noisy = await slugForUrl(
      "https://example.com/posts/hello-ai/?utm_source=tw#intro",
    );
    expect(noisy).toBe(clean);
  });

  test("www differs in identity (hash) but not in the readable base", async () => {
    const bare = await slugForUrl("https://example.com/posts/hello-ai");
    const www = await slugForUrl("https://www.example.com/posts/hello-ai");
    expect(www).not.toBe(bare);
    expect(www.slice(0, -9)).toBe(bare.slice(0, -9));
  });

  test("distinct URLs get distinct slugs", async () => {
    const a = await slugForUrl("https://example.com/posts?page=1");
    const b = await slugForUrl("https://example.com/posts?page=2");
    expect(a).not.toBe(b);
  });

  test("has the shape base-hash8 and respects the length cap", async () => {
    const slug = await slugForUrl(
      "https://example.com/a-very-long-path-segment-that-goes-on-and-on-and-on-far-beyond-sixty-characters",
    );
    const match = slug.match(/^([a-z0-9-]+)-([0-9a-f]{8})$/);
    expect(match).not.toBeNull();
    const base = match?.[1] ?? "";
    expect(base.length).toBeLessThanOrEqual(60);
    expect(base.endsWith("-")).toBe(false);
  });

  test("degrades to a hash-dominant slug for non-ASCII paths", async () => {
    const slug = await slugForUrl("https://example.cn/文章/标题");
    expect(slug).toMatch(/^example-cn-[0-9a-f]{8}$/);
  });

  test("handles the bare root URL", async () => {
    const slug = await slugForUrl("https://example.com");
    expect(slug).toMatch(/^example-com-[0-9a-f]{8}$/);
  });
});
