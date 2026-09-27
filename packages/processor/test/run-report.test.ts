import { describe, expect, test } from "bun:test";
import type { PipelineReport } from "../src/pipeline.ts";
import {
  failureCount,
  formatRunSummary,
  publishRunReport,
} from "../src/run-report.ts";

function report(overrides: Partial<PipelineReport> = {}): PipelineReport {
  return {
    processed: [],
    translated: [],
    summaryFailed: [],
    translationFailed: [],
    errored: [],
    skipped: [],
    halted: [],
    inbox: { saved: [], existing: [], rejected: [] },
    fetchFailed: [],
    invalid: [],
    imagesDownloaded: 0,
    imagesFailed: 0,
    imagesPruned: 0,
    ...overrides,
  };
}

describe("failureCount", () => {
  test("counts hard failures and unreadable articles", () => {
    expect(
      failureCount(
        report({
          errored: [
            { slug: "a", error: "provider says 503", staysPending: true },
            { slug: "b", error: "disk full", staysPending: false },
          ],
          invalid: [{ path: "articles/c/index.md", error: "bad yaml" }],
        }),
      ),
    ).toBe(3);
  });

  test("a deferral or a settled marker is not a failure", () => {
    // Each of these is recorded somewhere that outlives the run — a checkpoint
    // the next run resumes, or a marker in the article — so none of them is
    // "look at this now".
    expect(
      failureCount(
        report({
          processed: ["a", "b"],
          summaryFailed: ["a"],
          translationFailed: ["b"],
          skipped: ["c"],
        }),
      ),
    ).toBe(0);
  });
});

describe("formatRunSummary", () => {
  test("a quiet run is a table and nothing else", () => {
    const text = formatRunSummary(report({ processed: ["a"] }));
    expect(text).toContain("| Processed | 1 |");
    expect(text).not.toContain("**Failed**");
    expect(text).not.toContain("**Needs a look**");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("names every failure and says whether it will be retried", () => {
    const text = formatRunSummary(
      report({
        errored: [
          { slug: "retried", error: "503", staysPending: true },
          { slug: "stuck", error: "EACCES", staysPending: false },
        ],
      }),
    );
    expect(text).toContain("`retried` (stays pending, retried next run): 503");
    expect(text).toContain(
      "`stuck` (will NOT be retried by an ordinary run): EACCES",
    );
  });

  test("keeps an error message on one line of its list item", () => {
    const text = formatRunSummary(
      report({
        errored: [
          {
            slug: "a",
            error: "first line\nsecond `quoted` line",
            staysPending: true,
          },
        ],
      }),
    );
    const item = text.split("\n").find((line) => line.startsWith("- `a`"));
    expect(item).toBe(
      "- `a` (stays pending, retried next run): first line second 'quoted' line",
    );
  });

  test("cuts a very long error message", () => {
    const text = formatRunSummary(
      report({
        errored: [{ slug: "a", error: "x".repeat(1000), staysPending: true }],
      }),
    );
    const item = text.split("\n").find((line) => line.startsWith("- `a`"));
    expect(item?.endsWith("…")).toBe(true);
    expect(item?.length).toBeLessThan(400);
  });

  test("lists settled markers and deferrals apart from failures", () => {
    const text = formatRunSummary(
      report({
        summaryFailed: ["s"],
        translationFailed: ["t"],
        skipped: ["long"],
      }),
    );
    expect(text).toContain("- summary fallback: `s`");
    expect(text).toContain("- translation failed: `t`");
    expect(text).toContain(
      "**Left for the next run** (budget reached): `long`",
    );
    expect(text).not.toContain("**Failed**");
  });
});

describe("saved links in the run report", () => {
  const inbox = {
    saved: [
      {
        file: "inbox/a",
        slug: "example-net-a-12345678",
        url: "https://example.net/a",
      },
    ],
    existing: [{ file: "inbox/b", slug: "example-net-b-12345678" }],
    rejected: [{ file: "inbox/c", reason: "no http(s) link in it" }],
  };

  test("a save that held no link fails the run", () => {
    // It is deleted, and this is the only place it is ever mentioned again.
    expect(failureCount(report({ inbox }))).toBe(1);
  });

  test("lists what each saved link became", () => {
    const text = formatRunSummary(report({ inbox }));
    expect(text).toContain(
      "- `example-net-a-12345678` from https://example.net/a",
    );
    expect(text).toContain("`example-net-b-12345678` was already in the vault");
    expect(text).toContain("- `inbox/c`: no http(s) link in it");
  });
});

describe("formatRunSummary when the provider stopped the run", () => {
  test("says why the rest were not attempted", () => {
    const text = formatRunSummary(
      report({
        errored: [
          { slug: "a", error: "503", staysPending: true },
          { slug: "b", error: "503", staysPending: true },
          { slug: "c", error: "503", staysPending: true },
        ],
        halted: ["d", "e"],
      }),
    );
    expect(text).toContain("| Not attempted | 2 |");
    expect(text).toContain(
      "**Stopped early** — the provider failed 3 articles in a row; not attempted, still pending: `d`, `e`",
    );
  });

  test("a halted article is not itself a failure", () => {
    // The outages that stopped the run are failures and already count; the
    // articles never started are pending work, like a budget deferral.
    expect(failureCount(report({ halted: ["d", "e"] }))).toBe(0);
  });
});

describe("publishRunReport", () => {
  const failing = report({
    errored: [{ slug: "a", error: "503", staysPending: true }],
  });

  test("outside Actions it writes nothing", () => {
    const writes: string[] = [];
    publishRunReport(failing, {}, (path) => writes.push(path));
    expect(writes).toEqual([]);
  });

  test("in Actions it writes the summary and the failure count", () => {
    const writes: [string, string][] = [];
    publishRunReport(
      failing,
      { GITHUB_STEP_SUMMARY: "/summary", GITHUB_OUTPUT: "/output" },
      (path, text) => writes.push([path, text]),
    );
    expect(writes.map(([path]) => path)).toEqual(["/summary", "/output"]);
    expect(writes[0]?.[1]).toContain("### Tiro processing run");
    expect(writes[1]?.[1]).toBe("failures=1\n");
  });

  test("a clean run still writes failures=0", () => {
    // Zero, not nothing: a missing value in the workflow should only ever mean
    // the report was not written, never that the run went fine.
    const writes: string[] = [];
    publishRunReport(report(), { GITHUB_OUTPUT: "/output" }, (_, text) =>
      writes.push(text),
    );
    expect(writes).toEqual(["failures=0\n"]);
  });

  test("a write that fails warns and never throws", () => {
    // Throwing here would crash a run whose articles are already written, and
    // turn it red for a reason that has nothing to do with them.
    const warnings: string[] = [];
    expect(() =>
      publishRunReport(
        failing,
        { GITHUB_STEP_SUMMARY: "/summary", GITHUB_OUTPUT: "/output" },
        () => {
          throw new Error("EROFS");
        },
        (message) => warnings.push(message),
      ),
    ).not.toThrow();
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("failure count");
  });
});
