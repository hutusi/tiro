import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The vault's workflows as wiring: which step calls which script in
 * packages/processor/job, in what order, under what condition — the parts a
 * typo would break without any script's own test noticing.
 */

const REPO = join(import.meta.dir, "../../..");
const WORKFLOWS = join(REPO, "vault-template/.github/workflows");
const ACTIONS = join(REPO, ".github/actions");
const JANUS = join(REPO, "vault-template/.janus");

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Workflow {
  on: { push?: { paths?: string[] } };
  jobs: Record<string, { if?: string; steps: Step[] }>;
}

const read = <T>(path: string): T =>
  Bun.YAML.parse(readFileSync(path, "utf8")) as T;

const workflow = (name: string) => read<Workflow>(join(WORKFLOWS, name));

function step(steps: Step[], name: string): Step {
  const found = steps.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no step named ${name}`);
  return found;
}

/** Every `run:` block a vault workflow or one of tiro's actions hands to a
 * shell, by where it came from. */
function runBlocks(): [string, string][] {
  const blocks: [string, string][] = [];
  for (const file of readdirSync(WORKFLOWS)) {
    const wf = read<Workflow>(join(WORKFLOWS, file));
    for (const [job, { steps }] of Object.entries(wf.jobs)) {
      for (const s of steps) {
        if (s.run !== undefined) blocks.push([`${file} ${job}`, s.run]);
      }
    }
  }
  for (const dir of readdirSync(ACTIONS)) {
    const action = read<{ runs: { steps: Step[] } }>(
      join(ACTIONS, dir, "action.yml"),
    );
    for (const s of action.runs.steps) {
      if (s.run !== undefined) blocks.push([`actions/${dir}`, s.run]);
    }
  }
  return blocks;
}

const JOB = "$GITHUB_WORKSPACE/tiro/packages/processor/job";

/** A GitHub expression as a workflow spells it, `${{ … }}`. */
const expr = (inner: string) => `$${"{{"} ${inner} }}`;

describe("process.yml", () => {
  const steps = workflow("process.yml").jobs.process?.steps ?? [];

  test("runs the processor through process.sh, with its inputs as data", () => {
    const s = step(steps, "Run the processor");
    expect(s.id).toBe("process");
    expect(s.run?.trim()).toBe(
      `bash "${JOB}/process.sh" "$GITHUB_WORKSPACE/vault"`,
    );
    expect(s.env).toEqual({
      TIRO_LLM_API_KEY: expr("secrets.TIRO_LLM_API_KEY"),
      TIRO_FORCE: expr("inputs.force"),
      TIRO_SLUG: expr("inputs.slug"),
    });
  });

  test("asks deploy.sh once the commit succeeded, and lets it decide", () => {
    const s = step(steps, "Trigger site deploy");
    expect(s.if).toBe("always() && steps.commit.outcome == 'success'");
    expect(s.run?.trim()).toBe(`bash "${JOB}/deploy.sh"`);
    expect(s.env).toEqual({
      TIRO_TRIGGER: expr("github.event_name"),
      TIRO_COMMITTED: expr("steps.commit.outputs.committed"),
      TIRO_DISPATCH_TOKEN: expr("secrets.TIRO_DISPATCH_TOKEN"),
    });
  });

  // Invariant 7: by the time the job turns red, its work is committed and
  // the site told.
  test("process, commit, deploy, and only then fail", () => {
    const order = steps
      .map((s) => s.name)
      .filter((name) => name !== undefined && name !== "");
    const at = (name: string) => order.indexOf(name);
    expect(at("Run the processor")).toBeGreaterThanOrEqual(0);
    expect(at("Commit results back")).toBeGreaterThan(at("Run the processor"));
    expect(at("Trigger site deploy")).toBeGreaterThan(
      at("Commit results back"),
    );
    expect(order.at(-1)).toBe("Fail on article errors");
    expect(step(steps, "Fail on article errors").if).toBe(
      "always() && steps.process.outputs.failures != '0'",
    );
  });
});

describe("publish.yml", () => {
  test("deploys through tiro's deploy action, as a collections edit", () => {
    const steps = workflow("publish.yml").jobs.publish?.steps ?? [];
    const s = step(steps, "Trigger site deploy");
    expect(s.uses).toBe("hutusi/tiro/.github/actions/deploy@main");
    expect(s.with).toEqual({
      token: expr("secrets.TIRO_DISPATCH_TOKEN"),
      trigger: "publish",
    });
  });

  test("the deploy action reaches deploy.sh from where it is fetched", () => {
    const action = read<{ runs: { steps: Step[] } }>(
      join(ACTIONS, "deploy/action.yml"),
    );
    const run = action.runs.steps[0]?.run?.trim() ?? "";
    const path = /"\$GITHUB_ACTION_PATH\/([^"]+)"/.exec(run)?.[1];
    expect(path).toBeDefined();
    expect(resolve(ACTIONS, "deploy", path ?? "")).toBe(
      join(REPO, "packages/processor/job/deploy.sh"),
    );
  });
});

// ADR 0046: one variable stands Actions down; a run by hand still runs.
const GATE =
  "vars.TIRO_PROCESSOR != 'external' || github.event_name == 'workflow_dispatch'";

describe("the host switch", () => {
  test("process.yml and publish.yml stand down for another host", () => {
    expect(workflow("process.yml").jobs.process?.if).toBe(GATE);
    expect(workflow("publish.yml").jobs.publish?.if).toBe(GATE);
  });

  test("tokens.yml does not: it checks the token Actions holds", () => {
    expect(workflow("tokens.yml").jobs.check?.if).toBeUndefined();
  });
});

describe("every vault workflow", () => {
  test("no expression reaches a shell", () => {
    for (const [where, run] of runBlocks()) {
      expect({ where, interpolates: run.includes("${{") }).toEqual({
        where,
        interpolates: false,
      });
    }
  });

  test("every job script a step calls exists", () => {
    const called = runBlocks().flatMap(([, run]) =>
      [...run.matchAll(/packages\/processor\/job\/[a-z-]+\.sh/g)].map(
        (m) => m[0],
      ),
    );
    expect(called.length).toBeGreaterThan(0);
    for (const script of called) {
      expect({ script, exists: existsSync(join(REPO, script)) }).toEqual({
        script,
        exists: true,
      });
    }
  });
});

/**
 * The Janus pipelines (ADR 0046), held to the part of Janus's grammar they may
 * use — anything else is a validation error there, found only on the host.
 * `janus validate` is the full check; this keeps the files honest without it.
 */
describe("the Janus pipelines", () => {
  interface Pipeline {
    name: string;
    on: { push?: { branches?: string[]; paths?: string[] } };
    concurrency?: { group?: string; "cancel-in-progress"?: boolean };
    env?: Record<string, string>;
    jobs: Record<string, { steps: Step[] }>;
  }
  const pipelines = Object.fromEntries(
    readdirSync(JANUS).map((file) => [file, read<Pipeline>(join(JANUS, file))]),
  );
  const pipeline = (file: string) => {
    const found = pipelines[file];
    if (found === undefined) throw new Error(`no .janus/${file}`);
    return found;
  };

  test("are process, publish and daily", () => {
    expect(Object.keys(pipelines).sort()).toEqual([
      "daily.yml",
      "process.yml",
      "publish.yml",
    ]);
  });

  test("use only keys and tokens Janus accepts", () => {
    const tokens =
      /^(env\.[A-Za-z_][A-Za-z0-9_]*|ref|sha|short_sha|branch|tag|event)$/;
    for (const [file, p] of Object.entries(pipelines)) {
      expect({ file, keys: Object.keys(p).sort() }).toEqual({
        file,
        keys: ["concurrency", "env", "jobs", "name", "on"],
      });
      expect(Object.keys(p.on)).toEqual(["push"]);
      for (const key of Object.keys(p.on.push ?? {})) {
        expect(["branches", "paths"]).toContain(key);
      }
      for (const key of Object.keys(p.concurrency ?? {})) {
        expect(["group", "cancel-in-progress"]).toContain(key);
      }
      // A group per commit would serialize nothing.
      expect(p.concurrency?.group).not.toMatch(/sha/);
      for (const job of Object.values(p.jobs)) {
        expect(Object.keys(job)).toEqual(["steps"]);
        for (const s of job.steps) {
          expect(Object.keys(s).sort()).toEqual(["run", "shell"]);
          expect(s.shell).toBe("bash");
        }
      }
      const text = readFileSync(join(JANUS, file), "utf8");
      for (const [, inner] of text.matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)) {
        expect({ file, token: inner }).toEqual({
          file,
          token: tokens.test(inner ?? "") ? inner : "(not a Janus token)",
        });
      }
    }
  });

  test("each runs run.sh from a fresh tiro, with its own trigger", () => {
    const triggers = Object.fromEntries(
      Object.entries(pipelines).map(([file, p]) => [file, p.env?.TIRO_TRIGGER]),
    );
    expect(triggers).toEqual({
      "daily.yml": "schedule",
      "process.yml": expr("event"),
      "publish.yml": "publish",
    });
    for (const p of Object.values(pipelines)) {
      const steps = Object.values(p.jobs)[0]?.steps ?? [];
      expect(steps[0]?.run).toContain("rm -rf tiro");
      expect(steps.at(-1)?.run?.trim()).toBe(
        "bash tiro/packages/processor/job/run.sh",
      );
    }
    expect(pipeline("process.yml").env?.TIRO_TRIGGER_SHA).toBe(expr("sha"));
  });

  test("start on the same pushes the workflows do", () => {
    expect(pipeline("process.yml").on.push?.paths).toEqual(
      workflow("process.yml").on.push?.paths,
    );
    expect(pipeline("publish.yml").on.push?.paths).toEqual(
      workflow("publish.yml").on.push?.paths,
    );
  });

  test("the daily run queues with processing; a collections edit does not", () => {
    expect(pipeline("process.yml").concurrency?.group).toBe("tiro-process");
    expect(pipeline("daily.yml").concurrency?.group).toBe("tiro-process");
    expect(pipeline("publish.yml").concurrency).toEqual({
      group: "tiro-publish",
      "cancel-in-progress": true,
    });
  });
});
