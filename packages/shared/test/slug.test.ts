import { describe, expect, test } from "bun:test";
import { normalizeUrl, slugForUrl, tagSlug } from "../src/slug.ts";

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

  test("strips the extended referral-param blocklist", () => {
    expect(
      normalizeUrl(
        "https://example.com/post?ref=newsletter&source=tw&from=timeline&si=AbC&spm=a2.b3&scm=x&igshid=123&mc_cid=9&mc_eid=8&wfr=spider&isappinstalled=0",
      ),
    ).toBe("https://example.com/post");
  });

  test("strips trackers but keeps content-identifying params alongside them", () => {
    expect(normalizeUrl("https://example.com/watch?v=abc123&si=share9")).toBe(
      "https://example.com/watch?v=abc123",
    );
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

  test("referral params do not change identity", async () => {
    const clean = await slugForUrl("https://example.com/posts/hello-ai");
    const shared = await slugForUrl(
      "https://example.com/posts/hello-ai?ref=hn&source=rss&from=timeline",
    );
    expect(shared).toBe(clean);
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

  test("survives malformed percent escapes in the path", async () => {
    // decodeURIComponent throws URIError on "%zz"; the slug must still form.
    const slug = await slugForUrl("https://example.com/a%zz-path");
    expect(slug).toMatch(/^example-com-a-zz-path-[0-9a-f]{8}$/);
  });

  test("collapses repeated trailing slashes into one identity (intended)", async () => {
    // /a, /a/, and /a// serve the same page; re-clipping any variant must
    // overwrite the same article — the same reasoning as stripping utm_*
    // params and fragments. Do not "fix" this into slash-count preservation.
    const canonical = await slugForUrl("https://example.com/a");
    expect(await slugForUrl("https://example.com/a/")).toBe(canonical);
    expect(await slugForUrl("https://example.com/a//")).toBe(canonical);
  });
});

describe("arXiv identity", () => {
  // The user-visible promise: however you arrived at the paper, it is one
  // article. Version included — arXiv's own canonical link is versionless.
  test("every URL form of one paper produces one slug", async () => {
    const forms = [
      "https://arxiv.org/abs/2404.19756",
      "https://arxiv.org/abs/2404.19756v1",
      "https://arxiv.org/abs/2404.19756v5?context=cs",
      "https://arxiv.org/pdf/2404.19756v1.pdf",
      "https://arxiv.org/html/2404.19756v1#S3",
      "https://www.arxiv.org/abs/2404.19756",
      "https://ar5iv.labs.arxiv.org/html/2404.19756",
    ];
    const slugs = new Set(await Promise.all(forms.map(slugForUrl)));
    expect([...slugs]).toEqual(["arxiv-org-abs-2404-19756-637af334"]);
  });

  // The two papers already in the vault, pinned: these are the directory names
  // the migration has to produce, so a change here is a change to a rename that
  // has already happened.
  test("pins the slugs the vault migration moves to", async () => {
    expect(await slugForUrl("https://arxiv.org/html/2404.19756v1")).toBe(
      "arxiv-org-abs-2404-19756-637af334",
    );
    expect(await slugForUrl("https://arxiv.org/html/2608.23691v1")).toBe(
      "arxiv-org-abs-2608-23691-de58f2f7",
    );
  });

  test("a pre-2007 paper keeps a readable slug", async () => {
    expect(await slugForUrl("https://arxiv.org/abs/math.GT/0309136")).toBe(
      await slugForUrl("https://arxiv.org/pdf/math/0309136v2"),
    );
  });

  // The blast radius. Canonicalization must not reach any other host, and an
  // arXiv URL that is not a paper must keep behaving like an ordinary page.
  test("leaves non-paper arXiv URLs and other hosts alone", async () => {
    expect(await slugForUrl("https://arxiv.org/list/cs.AI/recent")).toMatch(
      /^arxiv-org-list-cs-ai-recent-[0-9a-f]{8}$/,
    );
    expect(await slugForUrl("https://example.com/abs/2404.19756")).toMatch(
      /^example-com-abs-2404-19756-[0-9a-f]{8}$/,
    );
  });
});

describe("tagSlug", () => {
  test("replaces characters that would break the route", () => {
    expect(tagSlug("ci/cd")).toBe("ci-cd");
    expect(tagSlug("machine learning")).toBe("machine-learning");
    expect(tagSlug("C#")).toBe("c");
    expect(tagSlug("100%")).toBe("100");
  });

  test("never produces a relative path segment", () => {
    expect(tagSlug("..")).toMatch(/^tag-[0-9a-f]{8}$/);
    expect(tagSlug(".hidden")).toBe("hidden");
    expect(tagSlug("../../etc")).toBe("etc");
  });

  test("keeps non-ASCII tags distinct instead of collapsing them", () => {
    expect(tagSlug("人工智能")).toBe("人工智能");
    expect(tagSlug("人工智能")).not.toBe(tagSlug("机器学习"));
  });

  test("falls back to a stable hash when nothing is left", () => {
    expect(tagSlug("///")).toMatch(/^tag-[0-9a-f]{8}$/);
    expect(tagSlug("///")).toBe(tagSlug("///"));
    expect(tagSlug("///")).not.toBe(tagSlug("..."));
  });

  test("is idempotent", () => {
    for (const tag of ["ci/cd", "人工智能", "Machine Learning"]) {
      expect(tagSlug(tagSlug(tag))).toBe(tagSlug(tag));
    }
  });

  test("caps a long tag to a valid path component", () => {
    const bytes = (t: string) => new TextEncoder().encode(t).length;
    // NAME_MAX is 255 bytes; an uncapped tag became a directory name that
    // long and failed the production build outright.
    expect(bytes(tagSlug("x".repeat(300)))).toBeLessThanOrEqual(255);
    // Chinese tags are the reason the cap is measured in bytes, not
    // characters: 100 characters is already 300 bytes.
    expect(bytes(tagSlug("智".repeat(100)))).toBeLessThanOrEqual(255);
  });

  test("does not split a character when truncating", () => {
    const slug = tagSlug("智".repeat(100));
    expect(slug).not.toContain("\uFFFD");
    // Re-encoding is lossless only if every code point survived intact.
    expect(new TextDecoder().decode(new TextEncoder().encode(slug))).toBe(slug);
  });

  test("keeps long tags sharing a prefix distinct", () => {
    const base = "x".repeat(300);
    expect(tagSlug(`${base}a`)).not.toBe(tagSlug(`${base}b`));
  });

  test("caps deterministically", () => {
    expect(tagSlug("x".repeat(300))).toBe(tagSlug("x".repeat(300)));
  });

  test("leaves a tag that already fits untouched", () => {
    expect(tagSlug("ci/cd")).toBe("ci-cd");
    expect(tagSlug("人工智能")).toBe("人工智能");
  });
});
