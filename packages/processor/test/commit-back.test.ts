import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The vault's "Commit results back" step, run for real.
 *
 * Not a copy of its shell: the block is read out of the template's
 * `process.yml` and run the way GitHub runs it, against real repositories — a
 * bare remote standing in for the vault, a shallow clone standing in for the
 * run's checkout, and a second clone for whoever else pushes meanwhile. What
 * it has to get right is what a run cannot afford to get wrong: every article
 * the run finished reaches `main` (invariant 8), and an article `main` deleted
 * while the run worked on it stays deleted (ADR 0036).
 */

const WORKFLOW = join(
  import.meta.dir,
  "../../../vault-template/.github/workflows/process.yml",
);

interface Step {
  id?: string;
  if?: string;
  shell?: string;
  run?: string;
  "working-directory"?: string;
}

function commitStep(): Step {
  const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as {
    jobs: { process: { steps: Step[] } };
  };
  const step = workflow.jobs.process.steps.find((s) => s.id === "commit");
  if (step?.run === undefined) throw new Error("no commit step with a run:");
  return step;
}

/** How GitHub runs a `run:` block on Linux, by the step's `shell:` key. A step
 * that names none runs under `bash -e`, without pipefail. */
function shellCommand(shell: string | undefined, file: string): string[] {
  if (shell === undefined) return ["bash", "-e", file];
  if (shell === "bash") {
    return ["bash", "--noprofile", "--norc", "-eo", "pipefail", file];
  }
  throw new Error(`no test mapping for shell: ${shell}`);
}

interface StepResult {
  exitCode: number;
  log: string;
  outputs: Record<string, string>;
}

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A vault on a bare remote, the run's shallow checkout of it, and another
 * clone. Git is isolated from the machine running the tests — no global or
 * system config, so a developer's `commit.gpgsign` or `pull.rebase` cannot
 * change what is being measured.
 */
function sandbox(initial: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "tiro-commit-back-"));
  sandboxes.push(root);
  const remote = join(root, "remote.git");
  const run = join(root, "vault");
  const other = join(root, "other");
  const output = join(root, "github-output");
  const emptyConfig = join(root, "gitconfig");
  writeFileSync(emptyConfig, "");
  writeFileSync(output, "");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    LANG: "C",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };

  const git = (cwd: string, ...args: string[]): string => {
    const r = Bun.spawnSync(["git", ...args], { cwd, env });
    if (r.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed in ${cwd}: ${r.stderr.toString()}`,
      );
    }
    return r.stdout.toString();
  };

  const write = (repo: string, files: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(files)) {
      const full = join(repo, path);
      if (text === null) {
        rmSync(full, { recursive: true, force: true });
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
    }
  };

  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(root, "seed");
  git(root, "clone", "-q", remote, seed);
  write(seed, initial);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "HEAD:main");
  // As actions/checkout makes it: one commit deep, on main.
  git(
    root,
    "clone",
    "-q",
    "--depth",
    "1",
    "--branch",
    "main",
    `file://${remote}`,
    run,
  );
  git(root, "clone", "-q", `file://${remote}`, other);

  return {
    remote,
    run,
    other,
    git,
    write,
    /** What another writer does meanwhile: commit and push to main. */
    push(files: Record<string, string | null>, message = "elsewhere") {
      write(other, files);
      git(other, "add", "-A");
      git(other, "commit", "-q", "-m", message);
      git(other, "push", "-q", "origin", "HEAD:main");
    },
    /** A move, as `sweep --recanonicalize` makes one. */
    pushMove(from: string, to: string) {
      git(other, "mv", from, to);
      git(other, "commit", "-q", "-m", `move ${from}`);
      git(other, "push", "-q", "origin", "HEAD:main");
    },
    /** Files on the remote's main, by path. */
    remoteFiles(): Map<string, string> {
      const names = git(remote, "ls-tree", "-r", "--name-only", "main")
        .split("\n")
        .filter((line) => line !== "");
      return new Map(
        names.map((name) => [name, git(remote, "show", `main:${name}`)]),
      );
    },
    remoteLog(): string[] {
      return git(remote, "log", "--format=%s", "main")
        .split("\n")
        .filter((line) => line !== "");
    },
    /** A hook script in a repository's hooks directory. */
    hook(repoGitDir: string, name: string, body: string) {
      const path = join(repoGitDir, "hooks", name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
    },
    runStep(): StepResult {
      const step = commitStep();
      const script = join(root, "commit-step.sh");
      writeFileSync(script, step.run ?? "");
      const r = Bun.spawnSync(shellCommand(step.shell, script), {
        cwd: run,
        env: { ...env, GITHUB_OUTPUT: output, OTHER: other },
      });
      const outputs: Record<string, string> = {};
      for (const line of readFileSync(output, "utf8").split("\n")) {
        const at = line.indexOf("=");
        if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
      }
      return {
        exitCode: r.exitCode ?? -1,
        log: r.stdout.toString() + r.stderr.toString(),
        outputs,
      };
    },
  };
}

const VAULT = {
  "articles/a/index.md": "a, as clipped\n",
  "articles/b/index.md": "b, as clipped\n",
  "config/tiro.yml": "llm: {}\n",
};

/** What a processing run leaves in its checkout for `a` and `b`. */
const PROCESSED_A = {
  "articles/a/index.md": "a, summarized\n",
  "articles/a/zh.md": "a, translated\n",
  "articles/a/.tiro-zh-cache.json": "{}\n",
  "articles/a/assets/figure.png": "png\n",
};
const PROCESSED_B = {
  "articles/b/index.md": "b, summarized\n",
  "articles/b/zh.md": "b, translated\n",
};

const underA = (files: Map<string, string>) =>
  [...files.keys()].filter((path) => path.startsWith("articles/a/"));

describe("the commit-back step", () => {
  test("is the step these tests run: always runs, and no expression reaches the shell", () => {
    const step = commitStep();
    expect(step.if).toBe("always()");
    expect(step["working-directory"]).toBe("vault");
    expect(step.run).not.toContain("${{");
  });

  test("pushes the run's work when nothing else committed", () => {
    const s = sandbox(VAULT);
    s.write(s.run, { ...PROCESSED_A, ...PROCESSED_B });
    const r = s.runStep();
    expect(r.exitCode).toBe(0);
    expect(r.outputs.committed).toBe("true");
    const files = s.remoteFiles();
    expect(files.get("articles/a/zh.md")).toBe("a, translated\n");
    expect(files.get("articles/b/index.md")).toBe("b, summarized\n");
  });

  test("commits nothing when the run changed nothing", () => {
    const s = sandbox(VAULT);
    const r = s.runStep();
    expect(r.exitCode).toBe(0);
    expect(r.outputs.committed).toBe("false");
    expect(s.remoteLog()).toEqual(["seed"]);
  });

  test("rebases over an unrelated commit, and both survive", () => {
    const s = sandbox(VAULT);
    s.write(s.run, PROCESSED_B);
    s.push({ "articles/c/index.md": "c, clipped meanwhile\n" }, "clip: c");
    const r = s.runStep();
    expect(r.exitCode).toBe(0);
    expect(r.outputs.committed).toBe("true");
    const files = s.remoteFiles();
    expect(files.get("articles/c/index.md")).toBe("c, clipped meanwhile\n");
    expect(files.get("articles/b/zh.md")).toBe("b, translated\n");
  });

  test("keeps the run's version of an article re-clipped meanwhile (-X theirs)", () => {
    const s = sandbox(VAULT);
    s.write(s.run, PROCESSED_B);
    s.push({ "articles/b/index.md": "b, re-clipped\n" }, "clip: b");
    const r = s.runStep();
    expect(r.exitCode).toBe(0);
    expect(s.remoteFiles().get("articles/b/index.md")).toBe("b, summarized\n");
  });

  test("an article main deleted while the run changed it stays deleted, and the rest lands", () => {
    const s = sandbox(VAULT);
    s.write(s.run, { ...PROCESSED_A, ...PROCESSED_B });
    s.push({ "articles/a": null }, "remove: a");
    const r = s.runStep();
    expect(r.exitCode).toBe(0);
    expect(r.outputs.committed).toBe("true");
    expect(r.log).toContain("::notice::articles/a was deleted on main");
    const files = s.remoteFiles();
    expect(underA(files)).toEqual([]);
    expect(files.get("articles/b/index.md")).toBe("b, summarized\n");
    expect(files.get("articles/b/zh.md")).toBe("b, translated\n");
  });

  test("files the run only added under a deleted article do not come back as an orphan", () => {
    const s = sandbox(VAULT);
    // A budget deferral: a checkpoint and an image, index.md untouched.
    s.write(s.run, {
      "articles/a/.tiro-zh-cache.json": "{}\n",
      "articles/a/assets/figure.png": "png\n",
      ...PROCESSED_B,
    });
    s.push({ "articles/a": null }, "remove: a");
    const r = s.runStep();
    expect(r.exitCode).toBe(0);
    const files = s.remoteFiles();
    expect(underA(files)).toEqual([]);
    expect(files.get("articles/b/zh.md")).toBe("b, translated\n");
  });

  test("a run whose whole work was under deleted articles commits nothing", () => {
    const s = sandbox(VAULT);
    s.write(s.run, PROCESSED_A);
    s.push({ "articles/a": null }, "remove: a");
    const r = s.runStep();
    expect(r.exitCode).toBe(0);
    expect(r.outputs.committed).toBe("false");
    expect(s.remoteLog()).toEqual(["remove: a", "seed"]);
  });

  test("a slug move counts as a deletion of the old directory", () => {
    const s = sandbox(VAULT);
    s.write(s.run, { ...PROCESSED_A, ...PROCESSED_B });
    s.pushMove("articles/a", "articles/a2");
    const r = s.runStep();
    expect(r.exitCode).toBe(0);
    const files = s.remoteFiles();
    expect(underA(files)).toEqual([]);
    // As the move left it: the run's work there is redone at the new slug.
    expect(files.get("articles/a2/index.md")).toBe("a, as clipped\n");
    expect(files.get("articles/b/zh.md")).toBe("b, translated\n");
  });

  test("a deletion that lands between two attempts is caught too", () => {
    const s = sandbox(VAULT);
    s.write(s.run, { ...PROCESSED_A, ...PROCESSED_B });
    // The first push is refused by an unrelated commit; the deletion lands
    // while the second is under way, after the run already rebased once.
    s.push({ "articles/c/index.md": "c\n" }, "clip: c");
    const count = join(s.run, ".git", "pre-push-count");
    s.hook(
      join(s.run, ".git"),
      "pre-push",
      [
        `echo x >> "${count}"`,
        `if [ "$(wc -l < "${count}")" -eq 2 ]; then`,
        "  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE",
        '  git -C "$OTHER" pull -q --rebase origin main',
        '  git -C "$OTHER" rm -q -r articles/a',
        '  git -C "$OTHER" commit -q -m "remove: a"',
        '  git -C "$OTHER" push -q origin HEAD:main',
        "fi",
      ].join("\n"),
    );
    const r = s.runStep();
    expect(r.exitCode).toBe(0);
    // The race this test exists for: rebased once, then refused again.
    expect(r.log).toContain("push rejected (attempt 2)");
    expect(r.log).toContain("::notice::articles/a was deleted on main");
    const files = s.remoteFiles();
    expect(underA(files)).toEqual([]);
    expect(files.get("articles/c/index.md")).toBe("c\n");
    expect(files.get("articles/b/zh.md")).toBe("b, translated\n");
  });

  test("gives up after four refused pushes, without claiming a commit", () => {
    const s = sandbox(VAULT);
    s.write(s.run, PROCESSED_B);
    const count = join(s.remote, "pushes");
    s.hook(s.remote, "pre-receive", `echo x >> "${count}"\nexit 1`);
    const r = s.runStep();
    expect(r.exitCode).not.toBe(0);
    expect(r.outputs.committed).toBeUndefined();
    expect(readFileSync(count, "utf8").split("\n").length - 1).toBe(4);
  });
});
