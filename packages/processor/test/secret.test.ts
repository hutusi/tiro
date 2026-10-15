import { describe, expect, test } from "bun:test";
import { readSecret } from "../src/secret.ts";

const files =
  (contents: Record<string, string>) =>
  (path: string): string => {
    const text = contents[path];
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    return text;
  };

describe("readSecret", () => {
  test("the variable itself wins over a file", () => {
    expect(
      readSecret(
        "KEY",
        { KEY: "from-env", KEY_FILE: "/key" },
        files({ "/key": "from-file\n" }),
      ),
    ).toEqual({ ok: true, value: "from-env" });
  });

  test("an unset or empty variable falls back to the file, without its line ending", () => {
    for (const env of [{ KEY_FILE: "/key" }, { KEY: "", KEY_FILE: "/key" }]) {
      expect(readSecret("KEY", env, files({ "/key": "s3cret\r\n" }))).toEqual({
        ok: true,
        value: "s3cret",
      });
    }
  });

  test("only a line ending goes: a secret ending in spaces keeps them", () => {
    expect(
      readSecret("KEY", { KEY_FILE: "/key" }, files({ "/key": "s3cret  \n" })),
    ).toEqual({ ok: true, value: "s3cret  " });
  });

  test("neither set says how to set either", () => {
    const secret = readSecret("TIRO_LLM_API_KEY", {}, files({}));
    expect(secret).toEqual({
      ok: false,
      why: "set the TIRO_LLM_API_KEY environment variable, or TIRO_LLM_API_KEY_FILE to a file holding it",
    });
  });

  test("a file it cannot read is named, with both variables", () => {
    const secret = readSecret("KEY", { KEY_FILE: "/absent" }, files({}));
    expect(secret.ok).toBe(false);
    if (!secret.ok) {
      expect(secret.why).toContain("KEY is unset and KEY_FILE (/absent)");
      expect(secret.why).toContain("ENOENT");
    }
  });

  test("an empty file is as good as none", () => {
    expect(
      readSecret("KEY", { KEY_FILE: "/key" }, files({ "/key": "\n" })),
    ).toEqual({ ok: false, why: "KEY is unset and KEY_FILE (/key) is empty" });
  });
});
