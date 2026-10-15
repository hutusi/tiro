import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * packages/processor/job/run.sh — the whole vault job on a host without
 * Actions (ADR 0046) — run for real: real git against a scratch remote, a
 * stand-in for GitHub's dispatch API, and a stand-in bun that plays the
 * processor (fixtures/job/bun). What it has to get right is what the workflow
 * gets from its steps: the run's work reaches main whatever the processor
 * did, the deploy follows ADR 0032's rule, and a failure is reported after
 * both, never instead of them.
 */

const REPO = join(import.meta.dir, "../../..");
const RUN = join(REPO, "packages/processor/job/run.sh");
const SHIM = join(import.meta.dir, "fixtures/job/bun");
const PINNED = (
  JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    packageManager: string;
  }
).packageManager.replace(/^bun@/, "");

const dispatches: string[] = [];
let dispatchStatus = 204;
const github = Bun.serve({
  port: 0,
  fetch(request) {
    dispatches.push(new URL(request.url).pathname);
    return new Response(null, { status: dispatchStatus });
  },
});
afterAll(() => github.stop(true));
beforeEach(() => {
  dispatches.length = 0;
  dispatchStatus = 204;
});

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const VAULT = {
  "articles/a/index.md": "a, as clipped\n",
  "config/tiro.yml": "llm: {}\n",
};

/** The processor writing one article's translation. */
const TRANSLATES_A = "echo translated > articles/a/zh.md";

/**
 * A vault on a bare remote, this host's (not yet made) checkout of it, and
 * another clone for whoever else pushes. Git is isolated from the machine
 * running the tests, and nothing else of its environment gets through — a
 * proxy setting would send the dispatch somewhere else.
 */
function sandbox(initial: Record<string, string> = VAULT) {
  const root = mkdtempSync(join(tmpdir(), "tiro-job-"));
  sandboxes.push(root);
  const remote = join(root, "remote.git");
  const vault = join(root, "host", "vault");
  const other = join(root, "other");
  const bin = join(root, "bin");
  const shimLog = join(root, "shim");
  mkdirSync(bin);
  copyFileSync(SHIM, join(bin, "bun"));
  chmodSync(join(bin, "bun"), 0o755);
  const gitconfig = join(root, "gitconfig");
  writeFileSync(gitconfig, "");
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    LANG: "C",
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };

  const git = (cwd: string, ...args: string[]): string => {
    const r = Bun.spawnSync(["git", ...args], { cwd, env: base });
    if (r.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
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
  git(root, "clone", "-q", `file://${remote}`, other);

  /** Someone commits and pushes to main, as `author`; returns the commit. */
  const pushAs = (
    author: string,
    files: Record<string, string | null>,
    message = "elsewhere",
  ): string => {
    if (git(other, "ls-remote", "origin", "main") !== "") {
      git(other, "pull", "-q", "--rebase", "origin", "main");
    }
    write(other, files);
    git(other, "add", "-A");
    git(
      other,
      "-c",
      `user.name=${author}`,
      "-c",
      "user.email=someone@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      message,
    );
    git(other, "push", "-q", "origin", "HEAD:main");
    return git(other, "rev-parse", "HEAD").trim();
  };
  pushAs("someone", initial, "seed");

  const read = (suffix: string) =>
    existsSync(`${shimLog}.${suffix}`)
      ? readFileSync(`${shimLog}.${suffix}`, "utf8")
      : undefined;

  return {
    root,
    remote,
    vault,
    git,
    write,
    pushAs,
    async run(env: Record<string, string> = {}) {
      const run = Bun.spawn(["bash", RUN], {
        env: {
          ...base,
          PATH: `${bin}:${base.PATH}`,
          TIRO_VAULT_DIR: vault,
          TIRO_VAULT_REMOTE: `file://${remote}`,
          TIRO_GITHUB_API: `http://127.0.0.1:${github.port}`,
          TIRO_DISPATCH_TOKEN: "t0ken",
          TIRO_PROCESS_TIMEOUT: "",
          SHIM_BUN_VERSION: PINNED,
          SHIM_LOG: shimLog,
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
    },
    /** `author: subject`, newest first. */
    remoteLog(): string[] {
      return git(remote, "log", "--format=%an: %s", "main")
        .split("\n")
        .filter((line) => line !== "");
    },
    remoteFile(path: string): string | undefined {
      const r = Bun.spawnSync(["git", "show", `main:${path}`], {
        cwd: remote,
        env: base,
      });
      return r.exitCode === 0 ? r.stdout.toString() : undefined;
    },
    shim: {
      runs: () => read("runs")?.split("\n").filter(Boolean).length ?? 0,
      args: () => read("args")?.split("\n").slice(0, -1),
      dispatchEnv: () => read("dispatch-env")?.trim(),
    },
  };
}

const PROCESSED =
  "tiro-processor: process: summarize and translate new articles";

describe("run.sh", () => {
  test("a push with work: processed, committed as the processor, deployed", async () => {
    const s = sandbox();
    const r = await s.run({
      TIRO_TRIGGER: "push",
      SHIM_SCENARIO: TRANSLATES_A,
    });
    expect(r.exitCode).toBe(0);
    expect(s.remoteFile("articles/a/zh.md")).toBe("translated\n");
    expect(s.remoteLog()[0]).toBe(PROCESSED);
    expect(dispatches).toEqual(["/repos/hutusi/tiro/dispatches"]);
    // The processor's own report, in the job's log.
    expect(r.log).toContain("### Tiro processing run");
  });

  test("a push with nothing to process still deploys: it was a hand edit", async () => {
    const s = sandbox();
    const r = await s.run({ TIRO_TRIGGER: "push" });
    expect(r.exitCode).toBe(0);
    expect(s.remoteLog()).toEqual(["someone: seed"]);
    expect(dispatches.length).toBe(1);
  });

  test("the daily run deploys only what it committed", async () => {
    const s = sandbox();
    expect((await s.run({ TIRO_TRIGGER: "schedule" })).exitCode).toBe(0);
    expect(dispatches).toEqual([]);
    const r = await s.run({
      TIRO_TRIGGER: "schedule",
      SHIM_SCENARIO: TRANSLATES_A,
    });
    expect(r.exitCode).toBe(0);
    expect(dispatches.length).toBe(1);
  });

  test("article failures turn the run red only after it committed and deployed", async () => {
    const s = sandbox();
    const r = await s.run({
      TIRO_TRIGGER: "push",
      SHIM_SCENARIO: TRANSLATES_A,
      SHIM_FAILURES: "2",
    });
    expect(r.exitCode).toBe(1);
    expect(s.remoteFile("articles/a/zh.md")).toBe("translated\n");
    expect(dispatches.length).toBe(1);
    expect(r.log).toContain("::error::2 article(s) failed");
  });

  test("a processor that crashed: what it wrote is committed, and the outcome is unknown", async () => {
    const s = sandbox();
    const r = await s.run({
      TIRO_TRIGGER: "push",
      SHIM_SCENARIO: TRANSLATES_A,
      SHIM_EXIT: "1",
      SHIM_NO_REPORT: "1",
    });
    expect(r.exitCode).toBe(1);
    expect(s.remoteFile("articles/a/zh.md")).toBe("translated\n");
    expect(r.log).toContain("::error::The processor exited 1");
    expect(r.log).toContain("outcome is unknown");
  });

  test("starts from main as it is now, on a checkout it keeps", async () => {
    const s = sandbox();
    await s.run({ TIRO_TRIGGER: "push" });
    s.pushAs("someone", { "articles/c/index.md": "c\n" }, "clip: c");
    const r = await s.run({
      TIRO_TRIGGER: "push",
      SHIM_SCENARIO: "cp articles/c/index.md articles/c/zh.md",
    });
    expect(r.exitCode).toBe(0);
    expect(s.remoteFile("articles/c/zh.md")).toBe("c\n");
  });

  test("commits what a killed run left before it starts", async () => {
    const s = sandbox();
    await s.run({ TIRO_TRIGGER: "push" });
    // As a run killed mid-way leaves the checkout: its work, uncommitted, and
    // the commit it started from.
    const head = s.git(s.vault, "rev-parse", "HEAD").trim();
    s.write(s.vault, { "articles/a/zh.md": "from the killed run\n" });
    writeFileSync(join(s.vault, ".git", "tiro-run-base"), `${head}\n`);
    dispatches.length = 0;
    const r = await s.run({ TIRO_TRIGGER: "schedule" });
    expect(r.exitCode).toBe(0);
    expect(r.log).toContain("The last run here did not finish");
    expect(s.remoteFile("articles/a/zh.md")).toBe("from the killed run\n");
    // Its commit is this run's to publish.
    expect(dispatches.length).toBe(1);
    expect(existsSync(join(s.vault, ".git", "tiro-run-base"))).toBe(false);
  });

  /** As commit-back.sh commits, so the processor's own rules apply to it. */
  const commitAsProcessor = (s: ReturnType<typeof sandbox>) => {
    s.git(s.vault, "add", "-A");
    s.git(
      s.vault,
      "-c",
      "user.name=tiro-processor",
      "-c",
      "user.email=p@example.com",
      "commit",
      "-q",
      "-m",
      "process: summarize and translate new articles",
    );
  };

  // A run killed after its commit-back rebased: its commit sits on a main
  // newer than the one it started from. Recommitting its changes measured
  // from that start would carry main's newer commits along as if they were
  // the run's, and -X theirs would then put them back over anything newer.
  test("a run killed after its rebase is recommitted on its own parent, and main's newer edits stand", async () => {
    const s = sandbox({ ...VAULT, "config/tiro.yml": "v: 0\n" });
    await s.run({ TIRO_TRIGGER: "push" });
    const base = s.git(s.vault, "rev-parse", "HEAD").trim();
    s.write(s.vault, { "articles/a/zh.md": "translated\n" });
    commitAsProcessor(s);
    s.pushAs("someone", { "config/tiro.yml": "v: 1\n" }, "config: 1");
    s.git(s.vault, "fetch", "-q", "origin", "main");
    s.git(
      s.vault,
      "-c",
      "user.name=tiro-processor",
      "-c",
      "user.email=p@example.com",
      "rebase",
      "-q",
      "FETCH_HEAD",
    );
    writeFileSync(join(s.vault, ".git", "tiro-run-base"), `${base}\n`);
    s.pushAs("someone", { "config/tiro.yml": "v: 2\n" }, "config: 2");
    const r = await s.run({ TIRO_TRIGGER: "schedule" });
    expect(r.exitCode).toBe(0);
    expect(s.remoteFile("config/tiro.yml")).toBe("v: 2\n");
    expect(s.remoteFile("articles/a/zh.md")).toBe("translated\n");
  });

  test("a run killed after it pushed is not committed again, and the site is told", async () => {
    const s = sandbox();
    await s.run({ TIRO_TRIGGER: "push" });
    const base = s.git(s.vault, "rev-parse", "HEAD").trim();
    s.write(s.vault, { "articles/a/zh.md": "translated\n" });
    commitAsProcessor(s);
    s.git(s.vault, "push", "-q", "origin", "HEAD:main");
    writeFileSync(join(s.vault, ".git", "tiro-run-base"), `${base}\n`);
    dispatches.length = 0;
    const r = await s.run({ TIRO_TRIGGER: "schedule" });
    expect(r.exitCode).toBe(0);
    expect(s.remoteLog()).toEqual([PROCESSED, "someone: seed"]);
    expect(dispatches.length).toBe(1);
  });

  // Recovery itself can be killed, once it has taken the run's commit apart
  // and before it has committed again: HEAD is then a commit main already
  // has, with the run's work staged on it, and the marker still names the
  // older start.
  test("a recovery killed half-way is finished by the next run", async () => {
    const s = sandbox();
    await s.run({ TIRO_TRIGGER: "push" });
    const base = s.git(s.vault, "rev-parse", "HEAD").trim();
    // The killed run: its commit, rebased onto a newer main…
    s.write(s.vault, { "articles/a/zh.md": "translated\n" });
    commitAsProcessor(s);
    s.pushAs("someone", { "articles/c/index.md": "c\n" }, "clip: c");
    s.git(s.vault, "fetch", "-q", "origin", "main");
    s.git(
      s.vault,
      "-c",
      "user.name=tiro-processor",
      "-c",
      "user.email=p@example.com",
      "rebase",
      "-q",
      "FETCH_HEAD",
    );
    writeFileSync(join(s.vault, ".git", "tiro-run-base"), `${base}\n`);
    // …then a recovery that took the commit apart, and was killed.
    s.git(s.vault, "reset", "-q", "--soft", "HEAD^");
    dispatches.length = 0;
    const r = await s.run({ TIRO_TRIGGER: "schedule" });
    expect(r.exitCode).toBe(0);
    expect(s.remoteFile("articles/a/zh.md")).toBe("translated\n");
    expect(s.remoteFile("articles/c/index.md")).toBe("c\n");
    expect(dispatches.length).toBe(1);
  });

  test("a deploy that could not be sent is owed until one is", async () => {
    const s = sandbox();
    dispatchStatus = 401;
    const failed = await s.run({
      TIRO_TRIGGER: "push",
      SHIM_SCENARIO: TRANSLATES_A,
    });
    expect(failed.exitCode).toBe(1);
    dispatchStatus = 204;
    dispatches.length = 0;
    // The processor's own push comes back with nothing new to process, which
    // would otherwise deploy nothing.
    const own = s.git(s.remote, "rev-parse", "main").trim();
    const owed = await s.run({ TIRO_TRIGGER: "push", TIRO_TRIGGER_SHA: own });
    expect(owed.exitCode).toBe(0);
    expect(owed.log).toContain("still owed");
    expect(dispatches.length).toBe(1);
    dispatches.length = 0;
    expect((await s.run({ TIRO_TRIGGER: "schedule" })).exitCode).toBe(0);
    expect(dispatches).toEqual([]);
  });

  test("changes no run recorded are discarded, not committed", async () => {
    const s = sandbox();
    await s.run({ TIRO_TRIGGER: "push" });
    s.write(s.vault, { "articles/a/zh.md": "stray\n" });
    const r = await s.run({ TIRO_TRIGGER: "schedule" });
    expect(r.exitCode).toBe(0);
    expect(r.log).toContain("changes no run recorded; discarding them");
    expect(s.remoteFile("articles/a/zh.md")).toBeUndefined();
  });

  describe("the processor's own push", () => {
    test("is processed, but deploys only what this run commits", async () => {
      const s = sandbox();
      const own = s.pushAs("tiro-processor", { "articles/a/zh.md": "x\n" });
      const r = await s.run({ TIRO_TRIGGER: "push", TIRO_TRIGGER_SHA: own });
      expect(r.exitCode).toBe(0);
      expect(r.log).toContain("This push is the processor's own commit");
      expect(s.shim.runs()).toBe(1);
      expect(dispatches).toEqual([]);
    });

    test("a clip it overtook in the queue is still processed and deployed", async () => {
      const s = sandbox();
      s.pushAs("someone", { "articles/c/index.md": "c\n" }, "clip: c");
      const own = s.pushAs("tiro-processor", { "articles/a/zh.md": "x\n" });
      const r = await s.run({
        TIRO_TRIGGER: "push",
        TIRO_TRIGGER_SHA: own,
        SHIM_SCENARIO: "cp articles/c/index.md articles/c/zh.md",
      });
      expect(r.exitCode).toBe(0);
      expect(s.remoteFile("articles/c/zh.md")).toBe("c\n");
      expect(dispatches.length).toBe(1);
    });

    test("three of its own commits in a row stop the chain", async () => {
      const s = sandbox();
      s.pushAs("tiro-processor", { "articles/a/zh.md": "1\n" });
      s.pushAs("tiro-processor", { "articles/a/zh.md": "2\n" });
      const own = s.pushAs("tiro-processor", { "articles/a/zh.md": "3\n" });
      const r = await s.run({
        TIRO_TRIGGER: "push",
        TIRO_TRIGGER_SHA: own,
        SHIM_SCENARIO: TRANSLATES_A,
      });
      expect(r.exitCode).toBe(0);
      expect(r.log).toContain("leaving the rest to the daily run");
      expect(s.shim.runs()).toBe(0);
      expect(dispatches).toEqual([]);
    });

    test("anyone else's commit on top resets the count", async () => {
      const s = sandbox();
      s.pushAs("tiro-processor", { "articles/a/zh.md": "1\n" });
      s.pushAs("tiro-processor", { "articles/a/zh.md": "2\n" });
      s.pushAs("someone", { "articles/c/index.md": "c\n" }, "clip: c");
      const own = s.pushAs("tiro-processor", { "articles/a/zh.md": "3\n" });
      await s.run({ TIRO_TRIGGER: "push", TIRO_TRIGGER_SHA: own });
      expect(s.shim.runs()).toBe(1);
    });
  });

  test("force and a slug reach the processor as data", async () => {
    const s = sandbox();
    const r = await s.run({
      TIRO_FORCE: "true",
      TIRO_SLUG: "$(touch pwned)",
    });
    expect(r.exitCode).toBe(0);
    expect(s.shim.args()?.slice(-3)).toEqual([
      "--force",
      "--slug",
      "$(touch pwned)",
    ]);
    expect(existsSync(join(REPO, "pwned"))).toBe(false);
    expect(existsSync(join(s.vault, "pwned"))).toBe(false);
  });

  test("the processor never holds the token that can write to the site", async () => {
    const s = sandbox();
    const token = join(s.root, "token");
    writeFileSync(token, "t0ken\n");
    await s.run({ TIRO_DISPATCH_TOKEN_FILE: token });
    expect(s.shim.dispatchEnv()).toBe("0");
    expect(dispatches.length).toBe(1);
  });

  test("a bun that is not the pinned one processes nothing, and a push still deploys", async () => {
    const s = sandbox();
    const r = await s.run({
      TIRO_TRIGGER: "push",
      SHIM_BUN_VERSION: "0.0.1",
      SHIM_SCENARIO: TRANSLATES_A,
    });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain(`bun is 0.0.1 here, but tiro pins ${PINNED}`);
    expect(s.shim.runs()).toBe(0);
    expect(dispatches.length).toBe(1);
  });

  test("a failed install processes nothing", async () => {
    const s = sandbox();
    const r = await s.run({ SHIM_INSTALL_FAILS: "1" });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain("bun install --frozen-lockfile failed");
    expect(s.shim.runs()).toBe(0);
  });

  test("a refused commit is reported, and nothing is deployed", async () => {
    const s = sandbox();
    const hook = join(s.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const r = await s.run({
      TIRO_TRIGGER: "push",
      SHIM_SCENARIO: TRANSLATES_A,
    });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain("The commit-back failed");
    expect(dispatches).toEqual([]);
  });

  test("a refused dispatch is reported after the commit", async () => {
    const s = sandbox();
    dispatchStatus = 401;
    const r = await s.run({
      TIRO_TRIGGER: "push",
      SHIM_SCENARIO: TRANSLATES_A,
    });
    expect(r.exitCode).toBe(1);
    expect(s.remoteFile("articles/a/zh.md")).toBe("translated\n");
    expect(r.log).toContain("The site was not told to rebuild");
  });

  test("a collections edit only deploys, and needs no vault", async () => {
    const s = sandbox();
    const r = await s.run({
      TIRO_TRIGGER: "publish",
      TIRO_VAULT_DIR: "",
      TIRO_VAULT_REMOTE: "",
    });
    expect(r.exitCode).toBe(0);
    expect(dispatches.length).toBe(1);
    expect(existsSync(s.vault)).toBe(false);
  });

  test("reads its settings from TIRO_JOB_ENV", async () => {
    const s = sandbox();
    const settings = join(s.root, "job.env");
    writeFileSync(
      settings,
      `TIRO_VAULT_DIR=${s.vault}\nTIRO_VAULT_REMOTE=file://${s.remote}\n`,
    );
    const r = await s.run({
      TIRO_JOB_ENV: settings,
      TIRO_VAULT_DIR: "",
      TIRO_VAULT_REMOTE: "",
      SHIM_SCENARIO: TRANSLATES_A,
    });
    expect(r.exitCode).toBe(0);
    expect(s.remoteFile("articles/a/zh.md")).toBe("translated\n");
  });

  test("misconfigured, it does nothing and says so", async () => {
    const s = sandbox();
    const r = await s.run({ TIRO_VAULT_DIR: "" });
    expect(r.exitCode).toBe(2);
    expect(r.log).toContain("Set TIRO_VAULT_DIR and TIRO_VAULT_REMOTE");
    expect((await s.run({ TIRO_TRIGGER: "merge_request" })).exitCode).toBe(2);
    expect(dispatches).toEqual([]);
  });

  test.skipIf(Bun.which("timeout") === null)(
    "a processor that overstays is stopped, and what it finished is committed",
    async () => {
      const s = sandbox();
      const r = await s.run({
        TIRO_TRIGGER: "push",
        TIRO_PROCESS_TIMEOUT: "1",
        SHIM_SCENARIO: `${TRANSLATES_A} && sleep 20`,
      });
      expect(r.exitCode).toBe(1);
      expect(r.log).toContain("ran past 1s and was stopped");
      expect(s.remoteFile("articles/a/zh.md")).toBe("translated\n");
      expect(dispatches.length).toBe(1);
    },
    15_000,
  );

  test.skipIf(Bun.which("flock") === null)(
    "holds a lock beside the checkout",
    async () => {
      const s = sandbox();
      expect((await s.run()).exitCode).toBe(0);
      expect(existsSync(`${s.vault}.lock`)).toBe(true);
    },
  );
});
