import { describe, expect, test } from "bun:test";
import { parseGitHubMarkdownUrl } from "@tiro/shared";
import type { FetchLike } from "../src/github.ts";
import { clipGitHubDoc, needsRawFetch, RAW_ORIGIN } from "../src/github-doc.ts";

const DOC = parseGitHubMarkdownUrl(
  "https://github.com/o/r/blob/main/docs/GUIDE.md",
);
if (DOC === null) throw new Error("fixture URL must parse");

const RAW = "https://raw.githubusercontent.com/o/r/main/docs/GUIDE.md";

/** Serves one body at one URL and refuses everything else, so a test cannot
 * pass by fetching a URL nobody meant to build. */
function serving(
  bodies: Record<string, string>,
  init: ResponseInit = {},
): FetchLike {
  return (input) => {
    const url = String(input);
    const body = bodies[url];
    if (body === undefined) {
      return Promise.resolve(new Response("no", { status: 404 }));
    }
    return Promise.resolve(new Response(body, init));
  };
}

describe("clipGitHubDoc", () => {
  test("reads the bytes, not the page", async () => {
    const clip = await clipGitHubDoc(DOC, {
      fetch: serving({ [RAW]: "# The Guide\n\nProse." }),
    });
    expect(clip.payload.markdown).toBe("# The Guide\n\nProse.");
    expect(clip.payload.title).toBe("The Guide");
    expect(clip.payload.markdownSource).toBe(true);
  });

  // The article is the page a reader should open; the bytes are where it was
  // read from. `buildClipFile` records the second only because they differ.
  test("files under the blob page and records the raw URL", async () => {
    const clip = await clipGitHubDoc(DOC, {
      fetch: serving({ [RAW]: "# T" }),
    });
    expect(clip.payload.url).toBe(
      "https://github.com/o/r/blob/main/docs/GUIDE.md",
    );
    expect(clip.sourceUrl).toBe(RAW);
  });

  // Resolving against the blob page would point the image at an HTML page.
  test("resolves a repo-relative image against the raw URL", async () => {
    const clip = await clipGitHubDoc(DOC, {
      fetch: serving({ [RAW]: "![a](img/a.png)" }),
    });
    expect(clip.payload.markdown).toBe(
      "![a](https://raw.githubusercontent.com/o/r/main/docs/img/a.png)",
    );
  });

  test("throws rather than commit a rendering when the fetch fails", () => {
    return expect(clipGitHubDoc(DOC, { fetch: serving({}) })).rejects.toThrow(
      "404",
    );
  });

  test("throws when the connection does", () => {
    return expect(
      clipGitHubDoc(DOC, {
        fetch: () => Promise.reject(new Error("offline")),
      }),
    ).rejects.toThrow("offline");
  });

  // A generated API reference is not an article, and the Contents API would
  // carry it base64-encoded into the vault forever.
  test("refuses a file too large to be an article", () => {
    return expect(
      clipGitHubDoc(DOC, {
        fetch: serving(
          { [RAW]: "x".repeat(3 * 1024 * 1024) },
          { headers: { "content-length": String(3 * 1024 * 1024) } },
        ),
      }),
    ).rejects.toThrow("too large");
  });

  test("refuses one that only turns out to be too large while reading", () => {
    return expect(
      clipGitHubDoc(DOC, {
        fetch: serving({ [RAW]: "x".repeat(3 * 1024 * 1024) }),
      }),
    ).rejects.toThrow("too large");
  });
});

describe("needsRawFetch", () => {
  // A blob page's markdown is GitHub's rendering run back through Turndown,
  // and committing it would replace a clip of the file itself.
  test("a rendering of a GitHub file owes a fetch", () => {
    expect(needsRawFetch({ markdownSource: false }, true)).toBe(true);
  });

  // The reader is already on the raw URL: the tab holds the bytes, and making
  // them grant a permission to clip what is in front of them would be absurd.
  test("the file itself owes nothing", () => {
    expect(needsRawFetch({ markdownSource: true }, true)).toBe(false);
  });

  test("an ordinary page owes nothing", () => {
    expect(needsRawFetch({ markdownSource: false }, false)).toBe(false);
  });
});

describe("RAW_ORIGIN", () => {
  // Exported so the manifest and the request cannot drift; asserted so a typo
  // in either is a failing test rather than a permission prompt that never
  // matches.
  test("matches the manifest's optional host permission", async () => {
    const manifest = (await Bun.file(
      "apps/extension/manifest.json",
    ).json()) as {
      optional_host_permissions?: string[];
    };
    expect(manifest.optional_host_permissions).toContain(RAW_ORIGIN);
  });
});
