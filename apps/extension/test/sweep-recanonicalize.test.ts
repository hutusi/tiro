import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArticleFrontmatter,
  parseArticle,
  parseSite,
  slugForUrl,
  stringifySite,
} from "@tiro/shared";
import {
  recanonicalize,
  recanonicalizeSite,
  type SavedSite,
} from "../scripts/sweep.ts";
import type { ClipPayload } from "../src/messages.ts";

const frontmatter = (
  url: string,
  domain = "arxiv.org",
): ArticleFrontmatter => ({
  url,
  title: "Old title",
  domain,
  clipped_at: "2026-09-01T06:13:19.432Z",
  author: "Stephen Chung\nThanks: DualverseAI; University of Cambridge",
  excerpt: "††thanks: zmliu@mit.edu",
  tiro: {
    schema: 1,
    clipper_version: "0.9.0",
    processed_at: "2026-09-02T02:28:11.614Z",
    processor_version: "0.1.0",
  },
});

const article = (
  slug: string,
  url: string,
  body = "Body text.\n",
  domain?: string,
) => ({
  slug,
  url,
  body,
  frontmatter: frontmatter(url, domain),
});

const payload = (over: Partial<ClipPayload> = {}): ClipPayload => ({
  url: "https://arxiv.org/abs/2404.19756",
  title: "KAN: Kolmogorov–Arnold Networks",
  excerpt: "Inspired by the representation theorem.",
  author: "Ziming Liu, Yixuan Wang",
  markdown: "# KAN\n",
  readabilityFailed: false,
  hasMath: true,
  pdfViewer: false,
  latexmlFullText: true,
  markdownSource: false,
  ...over,
});

describe("recanonicalize", () => {
  const old = "arxiv-org-html-2404-19756v1-18854016";
  const url = "https://arxiv.org/html/2404.19756v1";

  test("moves the article to the slug its URL now derives to", async () => {
    const plan = await recanonicalize(article(old, url), payload());
    expect(plan?.to).toBe(await slugForUrl(url));
    expect(plan?.to).toBe("arxiv-org-abs-2404-19756-637af334");
  });

  test("files it under the canonical URL and records where it was read", async () => {
    const plan = await recanonicalize(article(old, url), payload());
    const { frontmatter: written } = parseArticle(plan?.index ?? "");
    expect(written.url).toBe("https://arxiv.org/abs/2404.19756");
    expect(written.tiro.source_url).toBe(url);
  });

  // The reason this mode exists rather than a re-clip: the body is what costs
  // an LLM run to reproduce, and it is exactly what does not need to change.
  test("leaves the body byte-identical", async () => {
    const body = "Para one.\n\nPara two.\n";
    const plan = await recanonicalize(article(old, url, body), payload());
    expect(parseArticle(plan?.index ?? "").body).toBe(body);
  });

  test("keeps the article processed, so nothing is re-queued", async () => {
    const plan = await recanonicalize(article(old, url), payload());
    const { frontmatter: written } = parseArticle(plan?.index ?? "");
    expect(written.tiro.processed_at).toBe("2026-09-02T02:28:11.614Z");
  });

  test("refreshes the metadata the fresh clip improved, and says which", async () => {
    const plan = await recanonicalize(article(old, url), payload());
    const { frontmatter: written } = parseArticle(plan?.index ?? "");
    expect(written.author).toBe("Ziming Liu, Yixuan Wang");
    expect(written.excerpt).not.toContain("thanks");
    expect(plan?.refreshed).toEqual(["title", "author", "excerpt"]);
  });

  // A page that no longer loads still has to be moved: left where it is, the
  // next clip of it would create a second article beside this one.
  test("renames without a fresh clip, leaving the metadata alone", async () => {
    const plan = await recanonicalize(article(old, url), null);
    const { frontmatter: written } = parseArticle(plan?.index ?? "");
    expect(plan?.to).toBe("arxiv-org-abs-2404-19756-637af334");
    expect(written.author).toStartWith("Stephen Chung");
    expect(plan?.refreshed).toEqual([]);
  });

  /**
   * `stringifyArticle` trims the body it is handed. If the final block were a
   * code or math block whose last line carried trailing whitespace, that trim
   * would land *inside* the block — and with `zh.md` deliberately untouched,
   * `checkAlignment` would then see a verbatim block that differs, dropping the
   * article out of side-by-side rendering. No file the tooling wrote can be in
   * that state; this guards the one that could reach it, a hand-edited
   * index.md, by refusing rather than writing.
   */
  test("refuses rather than write an article whose body would change", async () => {
    const body = "Intro.\n\n```\nlet x = 1;\n```   \n";
    const plan = await recanonicalize(article(old, url, body), payload());
    expect(plan?.refused).toBe(
      "rewriting the frontmatter would alter the body",
    );
  });

  test("does not refuse the shape that trim cannot reach", async () => {
    // Trailing whitespace *inside* a fence, not on its last line: `trimEnd`
    // only ever reaches the tail, so 17 of the vault's 36 articles carry lines
    // like this and none of them are at risk.
    const body = "Intro.\n\n```\nlet x = 1;   \n```\n";
    const plan = await recanonicalize(article(old, url, body), payload());
    expect(plan?.refused).toBeUndefined();
    expect(parseArticle(plan?.index ?? "").body).toBe(body);
  });

  // The card, the RSS feed and the article page all display `domain`, and
  // buildClipFile takes it from the canonical URL — so carrying the old one
  // over would leave a migrated article disagreeing with a re-clip of itself.
  test("re-derives the domain from the canonical URL", async () => {
    const plan = await recanonicalize(
      article(
        "www-arxiv-org-abs-2404-19756-00000000",
        "https://www.arxiv.org/abs/2404.19756",
        "Body text.\n",
        "www.arxiv.org",
      ),
      null,
    );
    const { frontmatter: written } = parseArticle(plan?.index ?? "");
    expect(written.domain).toBe("arxiv.org");
    expect(written.url).toBe("https://arxiv.org/abs/2404.19756");
  });

  test("leaves the domain of an article whose URL did not move", async () => {
    const plan = await recanonicalize(
      article(
        "stale-name-00000000",
        "https://www.example.com/posts/hello",
        "Body text.\n",
        "www.example.com",
      ),
      null,
    );
    expect(parseArticle(plan?.index ?? "").frontmatter.domain).toBe(
      "www.example.com",
    );
  });

  // The loop used to fetch every article before asking whether any of them
  // moved: 36 requests to migrate 2, each with a 30-second timeout on a cold
  // cache. The slug is a hash of the article's own URL and needs no network.
  test("an article already at its slug is decided without a clip", async () => {
    const settled = "example-com-posts-hello-ai-e8446b12";
    const plan = await recanonicalize(
      article(settled, "https://example.com/posts/hello-ai"),
      null,
    );
    expect(plan).toBeNull();
  });

  test("does nothing for an article already at its slug", async () => {
    const settled = "example-com-posts-hello-ai-e8446b12";
    const plan = await recanonicalize(
      article(settled, "https://example.com/posts/hello-ai"),
      payload(),
    );
    expect(plan).toBeNull();
  });

  // source_url would be noise on an article whose URL was never rewritten.
  test("omits source_url when only the slug rule changed the name", async () => {
    const plan = await recanonicalize(
      article("stale-name-00000000", "https://example.com/posts/hello-ai"),
      null,
    );
    expect(
      parseArticle(plan?.index ?? "").frontmatter.tiro.source_url,
    ).toBeUndefined();
  });
});

const site = (slug: string, url: string, source?: string): SavedSite => ({
  slug,
  body: "509 BC\n",
  frontmatter: {
    url,
    title: "Battles",
    domain: new URL(url).hostname,
    clipped_at: "2026-10-20T08:15:00.000Z",
    description: "An interactive map.",
    preview: "./assets/54ea819b7af4.webp",
    note: "Drag it slowly.",
    tiro: {
      schema: 1,
      ...(source !== undefined ? { source_url: source } : {}),
    },
  },
});

/** ADR 0055: a saved site shares the slug rule, so a rule change moves it. */
describe("recanonicalizeSite", () => {
  test("leaves a site whose slug still matches", async () => {
    const url = "https://maps.example.org/roman-battles";
    expect(
      await recanonicalizeSite(site(await slugForUrl(url), url)),
    ).toBeNull();
  });

  test("moves a site, keeping the address that was saved", async () => {
    const url = "https://maps.example.org/roman-battles?utm_source=x";
    const plan = await recanonicalizeSite(site("old-slug-00000000", url));
    expect(plan?.to).toBe(await slugForUrl(url));
    const written = parseSite(plan?.index ?? "");
    expect(written.frontmatter.url).toBe(
      "https://maps.example.org/roman-battles",
    );
    expect(written.frontmatter.tiro.source_url).toBe(url);
    expect(written.frontmatter.note).toBe("Drag it slowly.");
    expect(written.body).toBe("509 BC\n");
  });

  test("an exact view already recorded is not replaced", async () => {
    const url = "https://maps.example.org/roman-battles";
    const view = "https://maps.example.org/roman-battles/#year=-216";
    const plan = await recanonicalizeSite(site("old-slug-00000000", url, view));
    expect(parseSite(plan?.index ?? "").frontmatter.tiro.source_url).toBe(view);
  });
});

describe("sweep --recanonicalize, over saved sites", () => {
  test("moves the site and its collection membership, never the article's", async () => {
    const vault = mkdtempSync(join(tmpdir(), "tiro-sweep-sites-"));
    try {
      const url = "https://maps.example.org/roman-battles";
      const slug = await slugForUrl(url);
      const old = "maps-example-org-roman-battles-00000000";
      mkdirSync(join(vault, "articles"), { recursive: true });
      mkdirSync(join(vault, "sites", old, "assets"), { recursive: true });
      writeFileSync(
        join(vault, "sites", old, "index.md"),
        stringifySite(site(old, url).frontmatter, "509 BC\n"),
      );
      writeFileSync(
        join(vault, "sites", old, "assets", "54ea819b7af4.webp"),
        "x",
      );
      mkdirSync(join(vault, "collections"));
      writeFileSync(
        join(vault, "collections", "maps.md"),
        `---\ntitle: "Maps"\nitems:\n  - slug: "${old}"\n  - slug: "sites/${old}"\ntiro:\n  schema: 1\n---\n`,
      );
      const run = Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, "../scripts/sweep.ts"),
          "--vault",
          vault,
          "--recanonicalize",
          "--write",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(run.stderr.toString()).toBe("");
      expect(run.exitCode).toBe(0);
      expect(existsSync(join(vault, "sites", old))).toBe(false);
      expect(
        existsSync(join(vault, "sites", slug, "assets", "54ea819b7af4.webp")),
      ).toBe(true);
      const collection = readFileSync(
        join(vault, "collections", "maps.md"),
        "utf8",
      );
      // The bare slug is an article's, and no article moved.
      expect(collection).toContain(`- slug: ${old}`);
      expect(collection).toContain(`- slug: sites/${slug}`);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
