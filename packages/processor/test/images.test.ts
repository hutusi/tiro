import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findImageUrls, processImages } from "../src/images.ts";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/ok.png")
        return new Response(PNG_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      if (path === "/page")
        return new Response("<html></html>", {
          headers: { "Content-Type": "text/html" },
        });
      if (path === "/huge.png")
        return new Response(PNG_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      if (path === "/noext")
        return new Response(PNG_BYTES, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function tempAssetsDir(): string {
  return mkdtempSync(join(tmpdir(), "tiro-images-"));
}

const options = (body: string, assetsDirAbs: string) => ({
  body,
  articleUrl: "https://example.com/posts/hello",
  assetsDirAbs,
  maxBytes: 1024 * 1024,
  timeoutMs: 5000,
  log: () => {},
});

describe("findImageUrls", () => {
  test("finds markdown and inline <img> URLs, skipping relative and data URIs", () => {
    const body = [
      "![a](https://a.example/x.png)",
      '<img src="https://b.example/y.jpg" alt="b">',
      "![local](./assets/z.png)",
      "![data](data:image/png;base64,AAAA)",
    ].join("\n\n");
    expect(findImageUrls(body).sort()).toEqual([
      "https://a.example/x.png",
      "https://b.example/y.jpg",
    ]);
  });
});

describe("processImages", () => {
  test("downloads an image and rewrites every occurrence of its URL", async () => {
    const dir = tempAssetsDir();
    const body = `![cover](${base}/ok.png)\n\nSee [the image](${base}/ok.png) again.`;
    const result = await processImages(options(body, dir));
    expect(result.downloaded).toBe(1);
    expect(result.failed).toBe(0);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{12}\.png$/);
    expect(result.body).not.toContain(base);
    expect(result.body.match(/\.\/assets\//g)).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps the hotlink on 404, wrong content type, and oversize", async () => {
    const dir = tempAssetsDir();
    const body = [
      `![gone](${base}/missing.png)`,
      `![page](${base}/page)`,
      `![huge](${base}/huge.png)`,
    ].join("\n\n");
    // maxBytes below the PNG size so /huge.png trips the size cap.
    const result = await processImages({ ...options(body, dir), maxBytes: 10 });
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.body).toBe(body);
    expect(readdirSync(dir)).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("skips URLs with no recognizable image extension", async () => {
    const dir = tempAssetsDir();
    const result = await processImages(options(`![x](${base}/noext)`, dir));
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("is idempotent: an already-rewritten body is untouched", async () => {
    const dir = tempAssetsDir();
    const body = "![cover](./assets/abc123def456.png)";
    const result = await processImages(options(body, dir));
    expect(result).toEqual({ body, downloaded: 0, failed: 0 });
    rmSync(dir, { recursive: true, force: true });
  });
});
