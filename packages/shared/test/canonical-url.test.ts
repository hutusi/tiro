import { describe, expect, test } from "bun:test";
import {
  arxivAbsUrl,
  arxivHtmlUrl,
  canonicalizeUrl,
  githubBlobUrl,
  githubRawUrl,
  parseArxivUrl,
  parseGitHubMarkdownUrl,
} from "../src/canonical-url.ts";

describe("parseArxivUrl", () => {
  // The whole point of the module: one paper, however you arrived at it.
  const samePaper = [
    "https://arxiv.org/abs/2404.19756",
    "https://arxiv.org/abs/2404.19756v1",
    "https://arxiv.org/abs/2404.19756v5",
    "https://arxiv.org/pdf/2404.19756",
    "https://arxiv.org/pdf/2404.19756v1",
    "https://arxiv.org/pdf/2404.19756v1.pdf",
    "https://arxiv.org/pdf/2404.19756.PDF",
    "https://arxiv.org/html/2404.19756",
    "https://arxiv.org/html/2404.19756v1",
    "https://arxiv.org/format/2404.19756",
    "https://arxiv.org/ps/2404.19756",
    "https://arxiv.org/src/2404.19756",
    "https://arxiv.org/e-print/2404.19756",
    "https://www.arxiv.org/abs/2404.19756",
    "https://export.arxiv.org/abs/2404.19756",
    "https://browse.arxiv.org/html/2404.19756v1",
    "https://ar5iv.org/abs/2404.19756",
    "https://ar5iv.labs.arxiv.org/html/2404.19756",
    "http://arxiv.org/abs/2404.19756",
    "https://arxiv.org/abs/2404.19756?context=cs",
    "https://arxiv.org/html/2404.19756v1#S3",
    "https://arxiv.org/html/2404.19756v1/",
  ];
  for (const url of samePaper) {
    test(`reads 2404.19756 out of ${url}`, () => {
      expect(parseArxivUrl(url)?.id).toBe("2404.19756");
    });
  }

  test("keeps the version the URL named, and only then", () => {
    expect(parseArxivUrl("https://arxiv.org/abs/2404.19756v3")?.version).toBe(
      3,
    );
    expect(
      parseArxivUrl("https://arxiv.org/abs/2404.19756")?.version,
    ).toBeUndefined();
  });

  test("accepts the five-digit ids arXiv has issued since 2015", () => {
    expect(parseArxivUrl("https://arxiv.org/abs/2501.12345")?.id).toBe(
      "2501.12345",
    );
  });

  // Pre-2007 ids span two path segments, which is why the tail is rejoined
  // before matching rather than read one segment at a time.
  test("reads a pre-2007 identifier", () => {
    expect(parseArxivUrl("https://arxiv.org/abs/hep-th/9901001")?.id).toBe(
      "hep-th/9901001",
    );
  });

  // arxiv.org redirects /abs/math.GT/0309136 to /abs/math/0309136 itself.
  test("drops the subject class from a pre-2007 identifier, as arXiv does", () => {
    expect(parseArxivUrl("https://arxiv.org/abs/math.GT/0309136")?.id).toBe(
      "math/0309136",
    );
    expect(parseArxivUrl("https://arxiv.org/abs/math.gt/0309136")?.id).toBe(
      "math/0309136",
    );
  });

  test("handles a subject class that itself contains a dash", () => {
    expect(
      parseArxivUrl("https://arxiv.org/abs/cond-mat.stat-mech/0309136")?.id,
    ).toBe("cond-mat/0309136");
  });

  test("reads a version off a pre-2007 identifier", () => {
    const paper = parseArxivUrl("https://arxiv.org/pdf/hep-th/9901001v2.pdf");
    expect(paper?.id).toBe("hep-th/9901001");
    expect(paper?.version).toBe(2);
  });

  // The grammar is the safety. These are arXiv URLs that are not papers, and
  // rewriting one would merge unrelated pages into a single article.
  const notPapers = [
    "https://arxiv.org/list/cs.AI/recent",
    "https://arxiv.org/a/liu_z_1",
    "https://arxiv.org/",
    "https://arxiv.org/abs/",
    "https://arxiv.org/abs/not-an-id",
    "https://arxiv.org/abs/2404.197",
    "https://arxiv.org/abs/24045.19756",
    "https://arxiv.org/abs/hep-th/99010011",
    "https://arxiv.org/search/?query=kan",
    "https://arxiv.org/help/api",
    "https://blog.arxiv.org/abs/2404.19756",
    "https://example.com/abs/2404.19756",
    "ftp://arxiv.org/abs/2404.19756",
    "not a url at all",
  ];
  for (const url of notPapers) {
    test(`declines ${url}`, () => {
      expect(parseArxivUrl(url)).toBeNull();
    });
  }
});

describe("arxivAbsUrl / arxivHtmlUrl", () => {
  test("the abs URL is the identity: no version, no host variance", () => {
    expect(arxivAbsUrl({ id: "2404.19756", version: 3 })).toBe(
      "https://arxiv.org/abs/2404.19756",
    );
  });

  // The reader asked for a specific version; the body they get should be that
  // one even though the article it lands in is versionless.
  test("the html URL keeps the version when there is one", () => {
    expect(arxivHtmlUrl({ id: "2404.19756", version: 1 })).toBe(
      "https://arxiv.org/html/2404.19756v1",
    );
    expect(arxivHtmlUrl({ id: "2404.19756" })).toBe(
      "https://arxiv.org/html/2404.19756",
    );
    expect(arxivHtmlUrl({ id: "hep-th/9901001" })).toBe(
      "https://arxiv.org/html/hep-th/9901001",
    );
  });
});

describe("canonicalizeUrl", () => {
  test("collapses every arXiv form onto the abs URL", () => {
    expect(canonicalizeUrl("https://arxiv.org/pdf/2404.19756v2.pdf")).toBe(
      "https://arxiv.org/abs/2404.19756",
    );
    expect(
      canonicalizeUrl("https://ar5iv.labs.arxiv.org/html/2404.19756"),
    ).toBe("https://arxiv.org/abs/2404.19756");
  });

  test("collapses every GitHub markdown form onto the blob URL", () => {
    expect(
      canonicalizeUrl(
        "https://raw.githubusercontent.com/o/r/refs/heads/main/docs/README.md",
      ),
    ).toBe("https://github.com/o/r/blob/main/docs/README.md");
    expect(
      canonicalizeUrl(
        "https://github.com/o/r/blob/main/docs/README.md?plain=1",
      ),
    ).toBe("https://github.com/o/r/blob/main/docs/README.md");
  });

  test("returns anything else byte-identical", () => {
    const untouched = [
      "https://example.com/posts/hello?page=2",
      "https://arxiv.org/list/cs.AI/recent",
      "https://blog.arxiv.org/2024/04/30/kan/",
      "https://github.com/hutusi/tiro",
      "https://github.com/hutusi/tiro/blob/main/apps/extension/src/clip.ts",
    ];
    for (const url of untouched) expect(canonicalizeUrl(url)).toBe(url);
  });
});

describe("parseGitHubMarkdownUrl", () => {
  const TAIL = ["master", "Hickey_Rich", "SimpleMadeEasy.md"];

  // One file, however you arrived at it: the bytes, the page it is presented
  // on, and every way a ref can be spelled in front of the path.
  const sameFile = [
    "https://raw.githubusercontent.com/matthiasn/talk-transcripts/refs/heads/master/Hickey_Rich/SimpleMadeEasy.md",
    "https://raw.githubusercontent.com/matthiasn/talk-transcripts/master/Hickey_Rich/SimpleMadeEasy.md",
    "https://github.com/matthiasn/talk-transcripts/blob/master/Hickey_Rich/SimpleMadeEasy.md",
    "https://github.com/matthiasn/talk-transcripts/blob/refs/heads/master/Hickey_Rich/SimpleMadeEasy.md",
    "https://github.com/matthiasn/talk-transcripts/raw/master/Hickey_Rich/SimpleMadeEasy.md",
    "https://www.github.com/matthiasn/talk-transcripts/blob/master/Hickey_Rich/SimpleMadeEasy.md",
    "http://github.com/matthiasn/talk-transcripts/blob/master/Hickey_Rich/SimpleMadeEasy.md",
    "https://github.com/matthiasn/talk-transcripts/blob/master/Hickey_Rich/SimpleMadeEasy.md?plain=1",
    "https://github.com/matthiasn/talk-transcripts/blob/master/Hickey_Rich/SimpleMadeEasy.md#L10",
    "https://github.com/matthiasn/talk-transcripts/blob/master/Hickey_Rich/SimpleMadeEasy.md/",
  ];
  for (const url of sameFile) {
    test(`reads one file out of ${url}`, () => {
      expect(parseGitHubMarkdownUrl(url)?.tail).toEqual(TAIL);
    });
  }

  test("a tag prefix is stripped the same way a branch prefix is", () => {
    expect(
      parseGitHubMarkdownUrl(
        "https://raw.githubusercontent.com/o/r/refs/tags/v1.0/README.md",
      )?.tail,
    ).toEqual(["v1.0", "README.md"]);
  });

  // The reason the tail is never split. Both forms put the same segments after
  // their own prefix, so both land on the same article without anyone having
  // to decide where `feature/x` ends.
  test("a ref containing a slash stays consistent across forms", () => {
    const raw = parseGitHubMarkdownUrl(
      "https://raw.githubusercontent.com/o/r/refs/heads/feature/x/README.md",
    );
    const blob = parseGitHubMarkdownUrl(
      "https://github.com/o/r/blob/feature/x/README.md",
    );
    expect(raw?.tail).toEqual(["feature", "x", "README.md"]);
    expect(blob?.tail).toEqual(raw?.tail);
  });

  // A ref is a pin, not a variant — unlike an arXiv version, which the
  // publisher declares subordinate to the paper. Two refs are two documents.
  test("a different ref is a different file", () => {
    const at = (ref: string): string =>
      canonicalizeUrl(`https://github.com/o/r/blob/${ref}/README.md`);
    expect(new Set([at("main"), at("v2.0"), at("a1b2c3d")]).size).toBe(3);
  });

  test("keeps path segments exactly as the URL encoded them", () => {
    expect(
      parseGitHubMarkdownUrl(
        "https://github.com/o/r/blob/main/a%20b/R%C3%A9adme.md",
      )?.tail,
    ).toEqual(["main", "a%20b", "R%C3%A9adme.md"]);
  });

  // The grammar is the safety. Rewriting any of these would file unrelated
  // pages — or a file the clipper cannot read — under one article.
  const notDocs = [
    "https://github.com/matthiasn/talk-transcripts",
    "https://github.com/o/r/tree/master/Hickey_Rich",
    "https://github.com/o/r/blob/main/setup.py",
    "https://github.com/o/r/blob/main/README.mdx",
    "https://github.com/o/r/blob/main/README.md.txt",
    "https://github.com/o/r/blob/main",
    "https://github.com/o/r/issues/12",
    "https://github.com/o/r/releases/tag/v1.0",
    "https://github.com/o/r/commit/a1b2c3d",
    "https://github.com/",
    "https://gist.github.com/o/5d9c6f1e2b.md",
    "https://raw.githubusercontent.com/o/r",
    "https://raw.githubusercontent.com/o/r/main",
    "https://raw.githubusercontent.com/o/r/main/script.sh",
    "https://example.com/o/r/blob/main/README.md",
    "ftp://github.com/o/r/blob/main/README.md",
    "not a url at all",
  ];
  for (const url of notDocs) {
    test(`declines ${url}`, () => {
      expect(parseGitHubMarkdownUrl(url)).toBeNull();
    });
  }
});

describe("githubBlobUrl / githubRawUrl", () => {
  const doc = { owner: "o", repo: "r", tail: ["main", "docs", "README.md"] };

  test("the blob URL is the identity: the page, not the bytes", () => {
    expect(githubBlobUrl(doc)).toBe(
      "https://github.com/o/r/blob/main/docs/README.md",
    );
  });

  // What the clipper reads, and the base a repo-relative image resolves
  // against — the blob URL as a base would point an image at an HTML page.
  test("the raw URL is where the bytes are", () => {
    expect(githubRawUrl(doc)).toBe(
      "https://raw.githubusercontent.com/o/r/main/docs/README.md",
    );
  });
});
