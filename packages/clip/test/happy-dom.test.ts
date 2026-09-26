import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { clipPage } from "../src/clip-page.ts";
import { plainTextShell, withHtmlDocument } from "../src/happy-dom.ts";

describe("withHtmlDocument", () => {
  test("gives the clipper the page, at its own URL", async () => {
    const markdown = await withHtmlDocument(
      "<html><head><title>T</title></head><body><article><h1>Title</h1><p>" +
        "Some prose long enough to be an article, with a <a href='/rel'>relative link</a>. ".repeat(
          8,
        ) +
        "</p></article></body></html>",
      "https://example.test/posts/one",
      (doc) => clipPage(doc, "https://example.test/posts/one").markdown,
    );
    expect(markdown).toContain("https://example.test/rel");
  });

  test("a page's own scripts do not run, through parsing or clipping", async () => {
    // The processor parses pages nobody vetted in a job holding secrets. A
    // script parsed through innerHTML never runs — here, as in a browser — and
    // nothing the clipper does to the document changes that.
    const page = `<html><head><title>untouched</title></head><body><article>
      <p>${"Prose long enough to be read as the article. ".repeat(20)}</p>
      <script>document.title = "pwned by script"</script>
      <img src="data:," onerror="document.title = 'pwned by handler'">
      </article></body></html>`;
    const title = await withHtmlDocument(
      page,
      "https://example.test/",
      async (doc) => {
        clipPage(doc.cloneNode(true) as Document, "https://example.test/");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return doc.title;
      },
    );
    expect(title).toBe("untouched");
  });

  test("and would not if something ever connected one", async () => {
    // The one way a script runs in happy-dom is a script element created and
    // connected, which the clipper never does today. Evaluation is switched
    // off explicitly so that a future change doing it — copying a page's code
    // into a new element, say — still runs nothing.
    const title = await withHtmlDocument(
      '<html><head><title>untouched</title></head><body><script>document.title = "pwned"</script></body></html>',
      "https://example.test/",
      async (doc) => {
        const script = doc.createElement("script");
        script.textContent = doc.querySelector("script")?.textContent ?? "";
        doc.body.appendChild(script);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return doc.title;
      },
    );
    expect(title).toBe("untouched");
  });

  describe("and a page that names resources elsewhere", () => {
    // A real server, so the test counts requests that actually left rather
    // than trusting a setting to mean what it says.
    let hits = 0;
    let server: ReturnType<typeof Bun.serve>;
    beforeAll(() => {
      server = Bun.serve({
        port: 0,
        fetch() {
          hits += 1;
          return new Response("body{}", {
            headers: { "content-type": "text/css" },
          });
        },
      });
    });
    afterAll(() => server.stop(true));

    test("fetches none of them", async () => {
      const base = `http://127.0.0.1:${server.port}`;
      await withHtmlDocument(
        `<html><head>
          <link rel="stylesheet" href="${base}/a.css">
          <link rel="preload" as="script" href="${base}/b.js">
          <link rel="preload" as="style" href="${base}/c.css">
          <script src="${base}/d.js"></script>
          <meta http-equiv="refresh" content="0; url=${base}/e">
        </head><body>
          <img src="${base}/f.png"><iframe src="${base}/g"></iframe>
          <p>body</p>
        </body></html>`,
        "https://example.test/",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      );
      expect(hits).toBe(0);
    });
  });

  test("passes on what the callback throws", async () => {
    // And closes the window on the way out: `finally`, which a throw cannot
    // skip. A leaked window per failed article is a leak per run.
    await expect(
      withHtmlDocument("<p>x</p>", "https://example.test/", () => {
        throw new Error("clip failed");
      }),
    ).rejects.toThrow("clip failed");
  });
});

describe("plainTextShell", () => {
  /**
   * Chrome shows `text/plain` as a single `<pre>`, which is what the clipper's
   * markdown branch keys on. Parsed as HTML instead, a markdown file is not a
   * markdown file at all — `# Heading` is not a tag.
   */
  test("reaches the clipper the way the extension sees it", async () => {
    const payload = await withHtmlDocument(
      plainTextShell("# Guide\n\nProse."),
      "https://raw.example.test/docs/GUIDE.md",
      (doc) => clipPage(doc, "https://raw.example.test/docs/GUIDE.md"),
    );
    expect(payload.markdown).toBe("# Guide\n\nProse.");
    expect(payload.markdownSource).toBe(true);
  });

  // Markup in the file is content, not markup: escaping is what keeps an
  // inline `<div>` in a README from becoming part of the shell.
  test("escapes the file rather than letting it close the pre", () => {
    const shell = plainTextShell("a & b <pre></pre> <script>x</script>");
    expect(shell).toContain(
      "a &amp; b &lt;pre>&lt;/pre> &lt;script>x&lt;/script>",
    );
    expect(shell.match(/<pre>/g)).toHaveLength(1);
  });
});
