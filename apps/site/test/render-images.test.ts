import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderBlockHtml } from "../src/lib/render.ts";

// A fixture article whose asset is a real 640×400 JPEG.
const SLUG = "example-net-papers-attention-notes-278b43cb";
const JPEG = "./assets/5b0e1f7c2a91.jpg";

// The fixture vault is what an unset TIRO_VAULT_DIR resolves to.
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.TIRO_VAULT_DIR;
  delete process.env.TIRO_VAULT_DIR;
});
afterEach(() => {
  if (previous !== undefined) process.env.TIRO_VAULT_DIR = previous;
});

describe("article images", () => {
  test("a vault asset is lazy and carries its size", () => {
    const html = renderBlockHtml(`![chart](${JPEG})`, SLUG);
    expect(html).toContain(`src="/vault-assets/${SLUG}/5b0e1f7c2a91.jpg"`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('width="640"');
    expect(html).toContain('height="400"');
    // Its own site's image: nothing to withhold.
    expect(html).not.toContain("referrerpolicy");
  });

  test("a hotlinked image is lazy and sends no referer", () => {
    for (const src of ["https://cdn.example/a.png", "//cdn.example/a.png"]) {
      const html = renderBlockHtml(`<img src="${src}" alt="">`, SLUG);
      expect(html).toContain('referrerpolicy="no-referrer"');
      expect(html).toContain('loading="lazy"');
      expect(html).not.toContain("width=");
    }
  });

  test("a size the clipped markup carries is kept", () => {
    const html = renderBlockHtml(`<img src="${JPEG}" width="320">`, SLUG);
    expect(html).toContain('width="320"');
    expect(html).not.toContain("height=");
    expect(html).toContain('loading="lazy"');
  });

  test("an asset that is missing or unmeasurable just goes unsized", () => {
    for (const block of [
      "![gone](./assets/not-there.png)",
      `![elsewhere](./assets/5b0e1f7c2a91.jpg)`,
    ]) {
      // The second names a real file under another article's slug.
      const html = renderBlockHtml(block, "no-such-article-00000000");
      expect(html).toContain('loading="lazy"');
      expect(html).not.toContain("width=");
    }
  });
});
