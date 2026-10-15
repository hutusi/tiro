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
