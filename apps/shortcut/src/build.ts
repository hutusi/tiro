/**
 * Build the "Save to Tiro" shortcut into `dist/`, and sign it on a Mac.
 *
 *   bun run --cwd apps/shortcut build -- --repo <owner>/tiro-vault
 *
 * An iPhone imports only a signed shortcut, and only macOS can sign one
 * (`shortcuts sign`). The signed file carries a signature tied to the Apple
 * account that made it, so it is a build output — `dist/` is ignored — and
 * never shared: AirDrop it to your own phone.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { saveToTiroWorkflow, toPlistXml } from "./workflow.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { repo: { type: "string" } },
});

const dist = join(import.meta.dir, "..", "dist");
mkdirSync(dist, { recursive: true });
const unsigned = join(dist, "Save to Tiro (unsigned).shortcut");
const signed = join(dist, "Save to Tiro.shortcut");

const workflow = saveToTiroWorkflow(
  values.repo !== undefined ? { repo: values.repo } : {},
);
await Bun.write(unsigned, toPlistXml(workflow));
console.log(`wrote ${unsigned}`);

if (process.platform !== "darwin") {
  console.log(
    "not on macOS: sign it there with `shortcuts sign --mode anyone`",
  );
  process.exit(0);
}
const sign = Bun.spawnSync([
  "shortcuts",
  "sign",
  "--mode",
  "anyone",
  "--input",
  unsigned,
  "--output",
  signed,
]);
if (sign.exitCode !== 0) {
  console.error(`shortcuts sign failed: ${sign.stderr.toString().trim()}`);
  process.exit(1);
}
console.log(`signed ${signed} — AirDrop it to your iPhone and import it`);
