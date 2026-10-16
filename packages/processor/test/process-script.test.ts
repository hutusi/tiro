import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * packages/processor/job/process.sh, with a stand-in for `bun` on the PATH:
 * what reaches the processor, and from where.
 */

const REPO = join(import.meta.dir, "../../..");
const SCRIPT = join(REPO, "packages/processor/job/process.sh");

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(env: Record<string, string>, args: string[] = ["vault"]) {
  const root = mkdtempSync(join(tmpdir(), "tiro-process-sh-"));
  sandboxes.push(root);
  mkdirSync(join(root, "vault"));
  mkdirSync(join(root, "bin"));
  const seen = join(root, "seen");
  // Records what it was given, one argument per line, and exits as told.
  writeFileSync(
    join(root, "bin", "bun"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > "${seen}.args"`,
      `printf '%s' "$TIRO_COMMIT" > "${seen}.commit"`,
      `pwd > "${seen}.cwd"`,
      '[ -n "$SHIM_EXIT" ] || SHIM_EXIT=0',
      'exit "$SHIM_EXIT"',
    ].join("\n"),
  );
  chmodSync(join(root, "bin", "bun"), 0o755);
  const r = Bun.spawnSync(["bash", SCRIPT, ...args], {
    cwd: root,
    env: {
      PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: root,
      ...env,
    },
  });
  const read = (suffix: string) =>
    existsSync(`${seen}.${suffix}`)
      ? readFileSync(`${seen}.${suffix}`, "utf8")
      : undefined;
  return {
    root,
    exitCode: r.exitCode,
    log: r.stdout.toString() + r.stderr.toString(),
    args: read("args")?.split("\n").slice(0, -1),
    commit: read("commit"),
    cwd: read("cwd")?.trim(),
  };
}

describe("process.sh", () => {
  test("runs the processor from tiro over the vault, by absolute path", () => {
    const r = run({});
    expect(r.exitCode).toBe(0);
    expect(r.args).toEqual([
      "run",
      "packages/processor/src/cli.ts",
      "run",
      "--vault",
      realpathSync(join(r.root, "vault")),
    ]);
    expect(r.cwd).toBe(REPO);
  });

  test("records which tiro it is, for the articles saved links become", () => {
    const r = run({});
    const described = Bun.spawnSync(["git", "describe", "--always"], {
      cwd: REPO,
    });
    expect(r.commit).toBe(described.stdout.toString().trim());
  });

  test("passes force and a slug as arguments, never as source", () => {
    const r = run({ TIRO_FORCE: "true", TIRO_SLUG: "$(touch pwned)" });
    expect(r.args?.slice(-3)).toEqual(["--force", "--slug", "$(touch pwned)"]);
    expect(existsSync(join(r.root, "pwned"))).toBe(false);
    expect(existsSync(join(REPO, "pwned"))).toBe(false);
  });

  test("only true forces", () => {
    const r = run({ TIRO_FORCE: "false", TIRO_SLUG: "" });
    expect(r.args).not.toContain("--force");
    expect(r.args).not.toContain("--slug");
  });

  test("exits as the processor did", () => {
    expect(run({ SHIM_EXIT: "3" }).exitCode).toBe(3);
  });

  test("a call without one vault is a usage error", () => {
    const r = run({}, []);
    expect(r.exitCode).toBe(2);
    expect(r.args).toBeUndefined();
  });
});
