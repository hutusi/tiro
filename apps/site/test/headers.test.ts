import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `public/_headers` as path → header lines, the way Cloudflare Pages reads it. */
function rules(): Map<string, string[]> {
  const text = readFileSync(
    join(import.meta.dir, "../public/_headers"),
    "utf8",
  );
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = [];
      out.set(line.trim(), current);
    } else current?.push(line.trim());
  }
  return out;
}

test("fingerprinted build output is cached for good", () => {
  expect(rules().get("/_astro/*")).toContain(
    "Cache-Control: public, max-age=31536000, immutable",
  );
});

// The names hash the image's source URL, not its bytes, so the same name can
// carry new bytes after a re-clip. Immutable would pin the old picture.
test("vault assets are cached, but never as immutable", () => {
  const assets = rules().get("/vault-assets/*") ?? [];
  expect(assets.some((line) => line.startsWith("Cache-Control:"))).toBe(true);
  expect(assets.join("\n")).not.toContain("immutable");
});
