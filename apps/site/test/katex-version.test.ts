import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * The article page imports KaTeX's stylesheet from the site's own `katex`
 * dependency, while the markup comes from the copy rehype-katex resolves. The
 * two must be one release: KaTeX renames its classes between minors (0.18 made
 * `.strut`/`.base`/`.sizing` into `.katex-strut`/…), and a stylesheet from one
 * against markup from the other leaves every formula mis-set — struts set no
 * height, scripts stop shrinking — while every build and render test passes.
 * The site shipped exactly that from the day math landed.
 */
function versionFrom(resolveFrom: string): string {
  const require = createRequire(resolveFrom);
  const manifest = require.resolve("katex/package.json");
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string })
    .version;
}

test("the KaTeX stylesheet matches the KaTeX that renders the math", () => {
  const site = versionFrom(fileURLToPath(import.meta.url));
  const renderer = versionFrom(
    fileURLToPath(import.meta.resolve("rehype-katex")),
  );
  expect(site).toBe(renderer);
});
