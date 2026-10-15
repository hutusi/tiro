import { readFileSync } from "node:fs";

export type Secret = { ok: true; value: string } | { ok: false; why: string };

/**
 * A secret from the environment variable named `name` — or, when that is unset
 * or empty, from the file `<name>_FILE` names. The file form is for hosts that
 * hand a job files rather than environment: Janus passes a job almost none of
 * its own environment, and a secret written into a pipeline file would be
 * committed with it. Any `llm.api_key_env` gets the file form for free, so
 * nothing has to read the vault's config to find the name.
 *
 * Only a trailing line ending is dropped from the file, so a secret that
 * really ends in spaces survives being saved by an editor.
 */
export function readSecret(
  name: string,
  env: Record<string, string | undefined> = process.env,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Secret {
  const direct = env[name];
  if (direct !== undefined && direct !== "") return { ok: true, value: direct };
  const path = env[`${name}_FILE`];
  if (path === undefined || path === "") {
    return {
      ok: false,
      why: `set the ${name} environment variable, or ${name}_FILE to a file holding it`,
    };
  }
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    return {
      ok: false,
      why: `${name} is unset and ${name}_FILE (${path}) cannot be read: ${String(error)}`,
    };
  }
  const value = text.replace(/\r?\n$/, "");
  if (value === "") {
    return {
      ok: false,
      why: `${name} is unset and ${name}_FILE (${path}) is empty`,
    };
  }
  return { ok: true, value };
}
