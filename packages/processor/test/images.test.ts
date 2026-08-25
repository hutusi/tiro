import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findImageUrls,
  processImages,
  reconcileAssets,
} from "../src/images.ts";
import type { FetchLike } from "../src/llm/client.ts";

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
      if (path === "/ok.png" || path === "/ok2.png" || path === "/ok3.png")
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
      if (path === "/stream.png") {
        // Streamed body with no Content-Length, far larger than the cap in
        // the test: only the incremental byte cap can stop it early. Bounded
        // (not infinite) so a bug hangs an assertion, not the event loop.
        let sent = 0;
        const stream = new ReadableStream({
          pull(controller) {
            if (sent >= 5000) {
              controller.close();
              return;
            }
            sent += 1;
            controller.enqueue(PNG_BYTES);
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "image/png" },
        });
      }
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
  // The fixture server listens on localhost, which production would reject.
  allowPrivateHosts: true,
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
  test("downloads an image, rewriting image syntax but not plain links", async () => {
    const dir = tempAssetsDir();
    const body = `![cover](${base}/ok.png)\n\nSee [the image](${base}/ok.png) again.`;
    const result = await processImages(options(body, dir));
    expect(result.downloaded).toBe(1);
    expect(result.failed).toBe(0);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{12}\.png$/);
    expect(result.body).toContain(`![cover](./assets/${files[0]})`);
    // Plain links keep pointing at the source.
    expect(result.body).toContain(`[the image](${base}/ok.png)`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("does not corrupt longer URLs sharing the downloaded URL as a prefix", async () => {
    const dir = tempAssetsDir();
    const body = `![cover](${base}/ok.png)\n\n![broken](${base}/ok.pngx.html)`;
    const result = await processImages(options(body, dir));
    expect(result.downloaded).toBe(1);
    expect(result.failed).toBe(1);
    // The failing longer URL must survive byte-identically.
    expect(result.body).toContain(`![broken](${base}/ok.pngx.html)`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects non-public hosts unless explicitly allowed", async () => {
    const dir = tempAssetsDir();
    const body = [
      `![loop](${base}/ok.png)`,
      "![meta](http://169.254.169.254/latest/meta-data.png)",
      "![lan](https://10.0.0.5/x.png)",
      "![name](https://vault.internal/x.png)",
    ].join("\n\n");
    const result = await processImages({
      ...options(body, dir),
      allowPrivateHosts: false,
    });
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(4);
    expect(result.body).toBe(body);
    expect(readdirSync(dir)).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("caps a stream that never declares its length", async () => {
    const dir = tempAssetsDir();
    const result = await processImages({
      ...options(`![endless](${base}/stream.png)`, dir),
      maxBytes: 4096,
    });
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(1);
    expect(readdirSync(dir)).toHaveLength(0);
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

  test("stops at the image count cap, hotlinking the rest", async () => {
    const dir = tempAssetsDir();
    const body = [
      `![a](${base}/ok.png)`,
      `![b](${base}/ok2.png)`,
      `![c](${base}/ok3.png)`,
    ].join("\n\n");
    const result = await processImages({
      ...options(body, dir),
      maxCount: 2,
    });
    expect(result.downloaded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.body).toContain(`![c](${base}/ok3.png)`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("stops once the total byte budget is spent", async () => {
    const dir = tempAssetsDir();
    const body = [
      `![a](${base}/ok.png)`,
      `![b](${base}/ok2.png)`,
      `![c](${base}/ok3.png)`,
    ].join("\n\n");
    // Room for one PNG and no more.
    const result = await processImages({
      ...options(body, dir),
      totalMaxBytes: PNG_BYTES.byteLength,
    });
    expect(result.downloaded).toBe(1);
    expect(result.failed).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("re-checks the host on every redirect hop", async () => {
    const dir = tempAssetsDir();
    const META = "http://169.254.169.254/latest/meta-data.png";
    const requested: string[] = [];
    // Stands in for real fetch, which follows redirects itself unless the
    // caller opts out. Without that opt-out the guard only ever sees the URL
    // the article named.
    const fetchImpl: FetchLike = async (input, init) => {
      let url = String(input);
      for (;;) {
        requested.push(url);
        if (url !== "https://cdn.example/x.png") {
          return new Response(PNG_BYTES, {
            headers: { "Content-Type": "image/png" },
          });
        }
        const redirect = new Response(null, {
          status: 302,
          headers: { location: META },
        });
        if (init?.redirect === "manual") return redirect;
        url = META;
      }
    };
    const result = await processImages({
      ...options("![x](https://cdn.example/x.png)", dir),
      allowPrivateHosts: false,
      // Public for the first hop; the redirect target is a literal address,
      // so it is judged by name and never reaches the resolver.
      resolveHost: async () => ["93.184.216.34"],
      fetchImpl,
    });
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(1);
    // The metadata endpoint was never requested.
    expect(requested).toEqual(["https://cdn.example/x.png"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a response that declares no content type", async () => {
    const dir = tempAssetsDir();
    const fetchImpl: FetchLike = async () => new Response(PNG_BYTES);
    const result = await processImages({
      ...options("![x](https://cdn.example/x.png)", dir),
      fetchImpl,
    });
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(1);
    expect(readdirSync(dir)).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("does not delete anything itself", async () => {
    const dir = tempAssetsDir();
    // Reconciliation is the pipeline's job, after the article is written —
    // the stage runs before fallible LLM calls and must not touch the disk
    // on behalf of a body that may never be committed.
    writeFileSync(join(dir, "deadbeefdead.png"), PNG_BYTES);
    await processImages(options(`![a](${base}/ok.png)`, dir));
    expect(readdirSync(dir)).toContain("deadbeefdead.png");
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a name that resolves into carrier-grade NAT space", async () => {
    const dir = tempAssetsDir();
    let fetched = false;
    const fetchImpl: FetchLike = async () => {
      fetched = true;
      return new Response(PNG_BYTES, {
        headers: { "Content-Type": "image/png" },
      });
    };
    const result = await processImages({
      ...options("![x](https://cdn.example/x.png)", dir),
      allowPrivateHosts: false,
      // 100.64/10 is real infrastructure a resolver can answer with, unlike
      // the documentation ranges.
      resolveHost: async () => ["100.64.0.1"],
      fetchImpl,
    });
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(1);
    expect(fetched).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects literal addresses across the non-public ranges", async () => {
    const dir = tempAssetsDir();
    const hosts = [
      "100.64.0.1", // carrier-grade NAT
      "192.0.0.1", // IETF protocol assignments
      "198.18.0.1", // benchmarking
      "192.0.2.1", // TEST-NET-1
      "198.51.100.1", // TEST-NET-2
      "203.0.113.1", // TEST-NET-3
      "240.0.0.1", // reserved
    ];
    const body = hosts.map((h) => `![x](https://${h}/x.png)`).join("\n\n");
    const reached: string[] = [];
    const result = await processImages({
      ...options(body, dir),
      allowPrivateHosts: false,
      fetchImpl: async (input) => {
        // A throwing fetch would also produce failed === hosts.length, so the
        // assertion that matters is that no request was made at all.
        reached.push(String(input));
        return new Response(PNG_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      },
    });
    expect(reached).toEqual([]);
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(hosts.length);
    expect(result.body).toBe(body);
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a public name that resolves to a private address", async () => {
    const dir = tempAssetsDir();
    let fetched = false;
    const fetchImpl: FetchLike = async () => {
      fetched = true;
      return new Response(PNG_BYTES, {
        headers: { "Content-Type": "image/png" },
      });
    };
    const result = await processImages({
      ...options("![x](https://127.0.0.1.nip.io/x.png)", dir),
      allowPrivateHosts: false,
      resolveHost: async () => ["127.0.0.1"],
      fetchImpl,
    });
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(1);
    expect(fetched).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("allows a public name that resolves to a public address", async () => {
    const dir = tempAssetsDir();
    const fetchImpl: FetchLike = async () =>
      new Response(PNG_BYTES, { headers: { "Content-Type": "image/png" } });
    const result = await processImages({
      ...options("![x](https://cdn.example/x.png)", dir),
      allowPrivateHosts: false,
      resolveHost: async () => ["93.184.216.34"],
      fetchImpl,
    });
    expect(result.downloaded).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("reconcileAssets", () => {
  test("removes a file the body no longer references", async () => {
    const dir = tempAssetsDir();
    writeFileSync(join(dir, "deadbeefdead.png"), PNG_BYTES);
    writeFileSync(join(dir, "abc123def456.png"), PNG_BYTES);
    const pruned = await reconcileAssets(
      dir,
      "![live](./assets/abc123def456.png)",
    );
    expect(pruned).toBe(1);
    expect(readdirSync(dir)).toEqual(["abc123def456.png"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("is idempotent", async () => {
    const dir = tempAssetsDir();
    writeFileSync(join(dir, "abc123def456.png"), PNG_BYTES);
    const body = "![live](./assets/abc123def456.png)";
    expect(await reconcileAssets(dir, body)).toBe(0);
    expect(await reconcileAssets(dir, body)).toBe(0);
    expect(readdirSync(dir)).toEqual(["abc123def456.png"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps a file referenced from an <img> tag", async () => {
    const dir = tempAssetsDir();
    writeFileSync(join(dir, "abc123def456.png"), PNG_BYTES);
    const pruned = await reconcileAssets(
      dir,
      '<img src="./assets/abc123def456.png" alt="x">',
    );
    expect(pruned).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("survives a malformed percent-escape instead of wedging the article", async () => {
    const dir = tempAssetsDir();
    // The extension's raw-body fallback keeps a source site's relative URLs
    // verbatim, so this reaches the vault. decodeURIComponent throws on it,
    // and this runs outside the per-image fallback — an unguarded decode left
    // the article pending on every retry, forever.
    writeFileSync(join(dir, "100%.png"), PNG_BYTES);
    const pruned = await reconcileAssets(dir, "![x](./assets/100%.png)");
    expect(pruned).toBe(0);
    expect(readdirSync(dir)).toEqual(["100%.png"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps a file whether the body escapes its name or not", async () => {
    const dir = tempAssetsDir();
    writeFileSync(join(dir, "my file.png"), PNG_BYTES);
    expect(await reconcileAssets(dir, "![x](./assets/my%20file.png)")).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("leaves a stray subdirectory alone", async () => {
    const dir = tempAssetsDir();
    mkdirSync(join(dir, "nested"));
    expect(await reconcileAssets(dir, "")).toBe(0);
    expect(readdirSync(dir)).toContain("nested");
    rmSync(dir, { recursive: true, force: true });
  });

  test("is a no-op when there is no assets directory", async () => {
    expect(await reconcileAssets("/nonexistent/assets", "")).toBe(0);
  });
});
