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
  test("decodes the ampersands an HTML attribute has to escape", () => {
    // A src holding a query string must spell & as &amp; to be valid HTML.
    // Fetched literally that is a different URL: the CDN ignores the
    // parameters or 404s, and the image falls back to a hotlink for nothing.
    const body =
      '<figure><img src="https://cdn.ex.com/i.png?w=800&amp;format=webp" alt="x"><figcaption>C</figcaption></figure>';
    expect(findImageUrls(body)).toEqual([
      "https://cdn.ex.com/i.png?w=800&format=webp",
    ]);
  });

  test("leaves a markdown image URL exactly as written", () => {
    // Only HTML attributes are obliged to escape the ampersand; decoding a
    // markdown URL would rewrite one the author spelled deliberately.
    const body = "![x](https://cdn.ex.com/i.png?a=1&amp;b=2)";
    expect(findImageUrls(body)).toEqual([
      "https://cdn.ex.com/i.png?a=1&amp;b=2",
    ]);
  });

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

  test("gives up on a slow resolver instead of outrunning the stage budget", async () => {
    const dir = tempAssetsDir();
    let fetched = false;
    const result = await processImages({
      ...options("![x](https://cdn.example/x.png)", dir),
      allowPrivateHosts: false,
      stageTimeoutMs: 50,
      // A resolver slower than the whole stage budget. Nothing else bounds it:
      // the abort signal reaches fetch only, and resolution happens first.
      resolveHost: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(["93.184.216.34"]), 2000);
        }),
      fetchImpl: async () => {
        fetched = true;
        return new Response(PNG_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      },
    });
    expect(fetched).toBe(false);
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(1);
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

  test("rejects IPv6 literals that are not public either", async () => {
    const dir = tempAssetsDir();
    const hosts = [
      "[ff02::1]", // multicast — IPv4 already rejected its a >= 224 counterpart
      "[ff05::2]", // site-local multicast
      "[::127.0.0.1]", // deprecated IPv4-compatible form wrapping loopback
      "[::1]", // loopback
      "[fc00::1]", // unique-local
      "[fe80::1]", // link-local
    ];
    const body = hosts.map((h) => `![x](https://${h}/x.png)`).join("\n\n");
    const reached: string[] = [];
    const result = await processImages({
      ...options(body, dir),
      allowPrivateHosts: false,
      fetchImpl: async (input) => {
        reached.push(String(input));
        return new Response(PNG_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      },
    });
    expect(reached).toEqual([]);
    expect(result.failed).toBe(hosts.length);
    expect(result.body).toBe(body);
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects every non-public IPv6 range", async () => {
    const dir = tempAssetsDir();
    const hosts = [
      "[fec0::1]", // site-local, deprecated
      "[fed0::1]", // site-local
      "[2002:7f00:1::1]", // 6to4 wrapping 127.0.0.1
      "[64:ff9b::7f00:1]", // NAT64 wrapping 127.0.0.1
      "[2001::1]", // Teredo
      "[100::1]", // discard-only
      "[2001:db8::1]", // documentation
      "[ff02::1]", // multicast
      "[::7f00:1]", // IPv4-compatible
      "[::ffff:7f00:1]", // IPv4-mapped
      "[fc00::1]", // unique-local
      "[fe80::1]", // link-local
      "[::1]", // loopback
      "[0:0:0:0:0:0:0:1]", // loopback, uncompressed spelling
      "[64:ff9b:1::7f00:1]", // local-use NAT64 — the /96 rule missed this
      "[100:0:0:1::1]", // dummy prefix, RFC 9780
      "[3fff::1]", // documentation, RFC 9637
      "[4000::1]", // unassigned — outside global unicast
      "[c000::1]", // unassigned
      "[1000::1]", // unassigned
    ];
    const body = hosts.map((h) => `![x](https://${h}/x.png)`).join("\n\n");
    const reached: string[] = [];
    const result = await processImages({
      ...options(body, dir),
      allowPrivateHosts: false,
      fetchImpl: async (input) => {
        reached.push(String(input));
        return new Response(PNG_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      },
    });
    expect(reached).toEqual([]);
    expect(result.failed).toBe(hosts.length);
    rmSync(dir, { recursive: true, force: true });
  });

  test("still allows public IPv6 addresses that look nearby", async () => {
    const dir = tempAssetsDir();
    // 2001:db8::/32 and 2001::/32 are rejected above; these must not be.
    const hosts = ["[2606:4700::1111]", "[2001:4860:4860::8888]"];
    const body = hosts.map((h) => `![x](https://${h}/x.png)`).join("\n\n");
    const result = await processImages({
      ...options(body, dir),
      allowPrivateHosts: false,
      fetchImpl: async () =>
        new Response(PNG_BYTES, { headers: { "Content-Type": "image/png" } }),
    });
    expect(result.downloaded).toBe(hosts.length);
    rmSync(dir, { recursive: true, force: true });
  });

  test("still allows a public IPv6 literal", async () => {
    const dir = tempAssetsDir();
    const result = await processImages({
      ...options("![x](https://[2606:4700::1111]/x.png)", dir),
      allowPrivateHosts: false,
      fetchImpl: async () =>
        new Response(PNG_BYTES, { headers: { "Content-Type": "image/png" } }),
    });
    expect(result.downloaded).toBe(1);
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

describe("reconcileAssets keep-set breadth", () => {
  const NAME = "abc123def456.png";

  // The processor only ever emits markdown/`<img src>` references, so these
  // arrive by hand-edit or via the extension's raw-body fallback, which
  // preserves a source site's markup verbatim. Deleting a live file is the
  // worst thing this function can do, so the scan errs toward keeping.
  const references: [label: string, body: string][] = [
    ['<img srcset="…">', `<img srcset="./assets/${NAME} 2x">`],
    ["a plain link", `[download](./assets/${NAME})`],
    ["a bare mention", `See ./assets/${NAME} for the diagram.`],
    ["an HTML anchor", `<a href="./assets/${NAME}">figure</a>`],
  ];

  for (const [label, body] of references) {
    test(`keeps a file referenced only by ${label}`, async () => {
      const dir = tempAssetsDir();
      writeFileSync(join(dir, NAME), PNG_BYTES);
      expect(await reconcileAssets(dir, body)).toBe(0);
      expect(readdirSync(dir)).toEqual([NAME]);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  test("still removes a file nothing mentions", async () => {
    const dir = tempAssetsDir();
    writeFileSync(join(dir, NAME), PNG_BYTES);
    expect(await reconcileAssets(dir, "A body with no assets at all.")).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("does not keep a file that merely shares a digest", async () => {
    const dir = tempAssetsDir();
    // Two digest names can never be prefixes of one another — same length —
    // so the only near-miss left is the same digest with another extension.
    writeFileSync(join(dir, "abc123def456.jpg"), PNG_BYTES);
    expect(await reconcileAssets(dir, `![x](./assets/${NAME})`)).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("reconcileAssets reference boundaries", () => {
  const NAME = "abc123def456.png";

  // Every one of these is a way a reference can end. A scan that has to guess
  // the boundary gets a new deletion bug per punctuation mark, so the check
  // asks the filesystem instead: does the body contain this exact filename?
  const bodies: [label: string, body: string][] = [
    [
      "a comma-separated srcset",
      `<img srcset="./assets/${NAME}, ./assets/b.png 2x">`,
    ],
    ["a srcset with a descriptor", `<img srcset="./assets/${NAME} 2x">`],
    ["a mention ending a sentence", `Shown in ./assets/${NAME}.`],
    ["a mention before a comma", `Both ./assets/${NAME}, and the other one.`],
    ["a parenthesised mention", `(see ./assets/${NAME})`],
    ["a reference before a tag", `<a href="./assets/${NAME}">fig</a>`],
    ["a markdown image", `![x](./assets/${NAME})`],
    ["a markdown image with a title", `![x](./assets/${NAME} "caption")`],
    ["a plain link", `[dl](./assets/${NAME})`],
    ["a semicolon", `See ./assets/${NAME}; also the other.`],
  ];

  for (const [label, body] of bodies) {
    test(`keeps a file referenced by ${label}`, async () => {
      const dir = tempAssetsDir();
      writeFileSync(join(dir, NAME), PNG_BYTES);
      expect(await reconcileAssets(dir, body)).toBe(0);
      expect(readdirSync(dir)).toEqual([NAME]);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  test("keeps a percent-encoded reference to a name with a space", async () => {
    const dir = tempAssetsDir();
    writeFileSync(join(dir, "my file.png"), PNG_BYTES);
    expect(await reconcileAssets(dir, "![x](./assets/my%20file.png)")).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps a name carrying a malformed escape", async () => {
    const dir = tempAssetsDir();
    writeFileSync(join(dir, "100%.png"), PNG_BYTES);
    expect(await reconcileAssets(dir, "![x](./assets/100%.png)")).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("still deletes a file nothing references", async () => {
    const dir = tempAssetsDir();
    writeFileSync(join(dir, NAME), PNG_BYTES);
    writeFileSync(join(dir, "999999999999.png"), PNG_BYTES);
    expect(await reconcileAssets(dir, `![x](./assets/${NAME})`)).toBe(1);
    expect(readdirSync(dir)).toEqual([NAME]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("reconcileAssets ownership", () => {
  // Every asset the processor writes is a 12-hex digest plus a known
  // extension, so anything else in assets/ was put there by someone else and
  // is not ours to delete. That bounds the damage a missed reference can do,
  // rather than trying to recognise every way one can be spelled.
  const NOT_OURS: [label: string, name: string, body: string][] = [
    ["an HTML entity", "a&b.png", '<img src="./assets/a&amp;b.png">'],
    ["a space", "my file.png", "![x](./assets/my file.png)"],
    ["a CJK name", "中文.png", "![x](./assets/中文.png)"],
    ["a name we cannot match at all", "hand-made.png", "nothing refers to it"],
  ];

  for (const [label, name, body] of NOT_OURS) {
    test(`never deletes a file we did not create: ${label}`, async () => {
      const dir = tempAssetsDir();
      writeFileSync(join(dir, name), PNG_BYTES);
      expect(await reconcileAssets(dir, body)).toBe(0);
      expect(readdirSync(dir)).toEqual([name]);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  test("still deletes an orphan it did create", async () => {
    const dir = tempAssetsDir();
    writeFileSync(join(dir, "abc123def456.png"), PNG_BYTES);
    writeFileSync(join(dir, "deadbeefdead.png"), PNG_BYTES);
    expect(await reconcileAssets(dir, "![x](./assets/abc123def456.png)")).toBe(
      1,
    );
    expect(readdirSync(dir)).toEqual(["abc123def456.png"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps a name of ours written percent-encoded", async () => {
    const dir = tempAssetsDir();
    // %61 is "a", which is also a hex digit — so a digest name genuinely can
    // arrive escaped, and percent-decoding still earns its place.
    writeFileSync(join(dir, "abc123def456.png"), PNG_BYTES);
    expect(
      await reconcileAssets(dir, "![x](./assets/%61bc123def456.png)"),
    ).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("ignores a file with an extension we never write", async () => {
    const dir = tempAssetsDir();
    writeFileSync(join(dir, "abc123def456.txt"), "notes");
    expect(await reconcileAssets(dir, "")).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
