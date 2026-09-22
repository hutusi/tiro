import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCollections } from "../scripts/sweep.ts";

describe("loadCollections", () => {
  test("a vault with no collections directory has none", async () => {
    const vault = mkdtempSync(join(tmpdir(), "tiro-sweep-"));
    try {
      expect(await loadCollections(vault)).toEqual([]);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("reads each collection under its filename's id", async () => {
    const vault = mkdtempSync(join(tmpdir(), "tiro-sweep-"));
    try {
      mkdirSync(join(vault, "collections"));
      writeFileSync(
        join(vault, "collections", "favorites.md"),
        '---\ntitle: "收藏"\nitems:\n  - slug: "a"\ntiro:\n  schema: 1\n---\n',
      );
      const [favorites] = await loadCollections(vault);
      expect(favorites?.id).toBe("favorites");
      expect(favorites?.frontmatter.items).toEqual([{ slug: "a" }]);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  // Skipping it would let the migration move articles out from under its
  // members and leave them dangling — the thing reading collections prevents.
  test("refuses to go on past one it cannot read", async () => {
    const vault = mkdtempSync(join(tmpdir(), "tiro-sweep-"));
    try {
      mkdirSync(join(vault, "collections"));
      writeFileSync(
        join(vault, "collections", "broken.md"),
        "no frontmatter\n",
      );
      await expect(loadCollections(vault)).rejects.toThrow("broken.md");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
