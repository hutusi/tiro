import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * packages/processor/job/deploy.sh, run for real against a stand-in for
 * GitHub's API: whether a run deploys (ADR 0032), and the request it sends.
 */

const SCRIPT = join(import.meta.dir, "../job/deploy.sh");

interface Request {
  method: string;
  path: string;
  authorization: string | null;
  accept: string | null;
  body: string;
}

const seen: Request[] = [];
let status = 204;
const github = Bun.serve({
  port: 0,
  async fetch(request) {
    seen.push({
      method: request.method,
      path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"),
      accept: request.headers.get("accept"),
      body: await request.text(),
    });
    return new Response(null, { status });
  },
});

const scratch = mkdtempSync(join(tmpdir(), "tiro-deploy-"));
afterAll(() => {
  github.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  seen.length = 0;
  status = 204;
});

/** The script, async: the stand-in answers on this same event loop. Nothing
 * from the machine's environment — a proxy setting would send the request
 * somewhere else. */
async function deploy(
  env: Record<string, string>,
): Promise<{ exitCode: number; log: string }> {
  const run = Bun.spawn(["bash", SCRIPT], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TIRO_GITHUB_API: `http://127.0.0.1:${github.port}`,
      TIRO_DISPATCH_TOKEN: "t0ken",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  return { exitCode: await run.exited, log: out + err };
}

describe("deploy.sh", () => {
  test("asks the site to rebuild with one vault-updated dispatch", async () => {
    const r = await deploy({ TIRO_TRIGGER: "push", TIRO_COMMITTED: "true" });
    expect(r.exitCode).toBe(0);
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/repos/hutusi/tiro/dispatches",
        authorization: "Bearer t0ken",
        accept: "application/vnd.github+json",
        body: '{"event_type":"vault-updated"}',
      },
    ]);
  });

  // ADR 0032 §1: a push, a manual run or a collections edit publishes even
  // when it committed nothing; the daily run only what it committed itself.
  for (const [trigger, committed, deploys] of [
    ["push", "false", true],
    ["workflow_dispatch", "false", true],
    ["manual", "false", true],
    ["publish", "false", true],
    ["schedule", "true", true],
    ["schedule", "false", false],
    ["schedule", "", false],
  ] as const) {
    test(`${trigger}, committed "${committed}": ${deploys ? "deploys" : "does not"}`, async () => {
      const r = await deploy({
        TIRO_TRIGGER: trigger,
        TIRO_COMMITTED: committed,
      });
      expect(r.exitCode).toBe(0);
      expect(seen.length).toBe(deploys ? 1 : 0);
      if (!deploys) expect(r.log).toContain("Not deploying");
    });
  }

  test("a trigger it does not know is an error, not a guess", async () => {
    const r = await deploy({ TIRO_TRIGGER: "merge_request" });
    expect(r.exitCode).toBe(2);
    expect(seen).toEqual([]);
  });

  test("names the site's repository it is given", async () => {
    await deploy({ TIRO_TRIGGER: "push", TIRO_SITE_REPO: "someone/site" });
    expect(seen.map((s) => s.path)).toEqual(["/repos/someone/site/dispatches"]);
  });

  test("reads the token from a file, without its line ending", async () => {
    const file = join(scratch, "token");
    writeFileSync(file, "f1le-t0ken\r\n");
    const r = await deploy({
      TIRO_TRIGGER: "push",
      TIRO_DISPATCH_TOKEN: "",
      TIRO_DISPATCH_TOKEN_FILE: file,
    });
    expect(r.exitCode).toBe(0);
    expect(seen.map((s) => s.authorization)).toEqual(["Bearer f1le-t0ken"]);
  });

  test("the token in the environment wins over a file", async () => {
    await deploy({
      TIRO_TRIGGER: "push",
      TIRO_DISPATCH_TOKEN_FILE: join(scratch, "absent"),
    });
    expect(seen.map((s) => s.authorization)).toEqual(["Bearer t0ken"]);
  });

  test("without a token it fails, and sends nothing", async () => {
    const r = await deploy({ TIRO_TRIGGER: "push", TIRO_DISPATCH_TOKEN: "" });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain("::error::No dispatch token");
    expect(seen).toEqual([]);
  });

  test("a token file it cannot read fails, and sends nothing", async () => {
    const r = await deploy({
      TIRO_TRIGGER: "push",
      TIRO_DISPATCH_TOKEN: "",
      TIRO_DISPATCH_TOKEN_FILE: join(scratch, "absent"),
    });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain("::error::Could not read TIRO_DISPATCH_TOKEN_FILE");
    expect(seen).toEqual([]);
  });

  test("a refused dispatch fails, with the status", async () => {
    status = 401;
    const r = await deploy({ TIRO_TRIGGER: "push" });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain("refused the deploy dispatch (HTTP 401)");
  });

  test("an API it cannot reach fails", async () => {
    const r = await deploy({
      TIRO_TRIGGER: "push",
      // Nothing listens on the discard port.
      TIRO_GITHUB_API: "http://127.0.0.1:9",
    });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain("::error::Could not reach");
  });
});
