import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
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

  // Stored 400×200 and turned a quarter by EXIF, so a browser shows it
  // 200×400. Sized from the stored header, it would be drawn twice as wide.
  test("an EXIF-turned photo is sized as it is shown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tiro-render-images-"));
    try {
      mkdirSync(join(dir, "articles/turned/assets"), { recursive: true });
      writeFileSync(
        join(dir, "articles/turned/assets/photo.jpg"),
        await sharp({
          create: { width: 400, height: 200, channels: 3, background: "#888" },
        })
          .jpeg()
          .withMetadata({ orientation: 6 })
          .toBuffer(),
      );
      process.env.TIRO_VAULT_DIR = dir;
      const html = renderBlockHtml("![p](./assets/photo.jpg)", "turned");
      expect(html).toContain('width="200"');
      expect(html).toContain('height="400"');
    } finally {
      delete process.env.TIRO_VAULT_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The src pattern matches before decoding, so `..%2F` reads as one name.
  // Decoded, it would size a file outside the article's assets/ and publish
  // its dimensions.
  test("a src that decodes out of assets/ is not read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tiro-render-images-"));
    try {
      const png = await sharp({
        create: { width: 321, height: 123, channels: 3, background: "#888" },
      })
        .png()
        .toBuffer();
      mkdirSync(join(dir, "articles/a/assets"), { recursive: true });
      mkdirSync(join(dir, "assets"), { recursive: true });
      writeFileSync(join(dir, "articles/a/assets/inside.png"), png);
      writeFileSync(join(dir, "articles/outside.png"), png);
      writeFileSync(join(dir, "assets/outside.png"), png);
      process.env.TIRO_VAULT_DIR = dir;
      for (const src of [
        "/vault-assets/a/..%2F..%2Foutside.png",
        "/vault-assets/../outside.png",
      ]) {
        const html = renderBlockHtml(`<img src="${src}" alt="">`, "a");
        expect(html).toContain('loading="lazy"');
        expect(html).not.toContain('width="321"');
      }
      // The same file inside assets/ is still measured.
      expect(renderBlockHtml("![i](./assets/inside.png)", "a")).toContain(
        'width="321"',
      );
    } finally {
      delete process.env.TIRO_VAULT_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
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
