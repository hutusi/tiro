import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTranslationCache,
  TRANSLATION_CACHE_FILE,
} from "../src/llm/cache.ts";

const header = { target: "zh", model: "m" };

function cachePath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "tiro-cache-")),
    TRANSLATION_CACHE_FILE,
  );
}

describe("loadTranslationCache", () => {
  test("round-trips entries through disk", async () => {
    const path = cachePath();
    const first = await loadTranslationCache(path, header);
    expect(first.restored).toBe(0);
    first.set("Hello.", "你好。");
    await first.flush();

    const second = await loadTranslationCache(path, header);
    expect(second.restored).toBe(1);
    expect(second.get("Hello.")).toBe("你好。");
    // Keyed by source text, so an edited block is a miss, not a stale hit.
    expect(second.get("Hello, again.")).toBeUndefined();
  });

  test("flush is a no-op when nothing changed", async () => {
    const path = cachePath();
    const cache = await loadTranslationCache(path, header);
    await cache.flush();
    expect(existsSync(path)).toBe(false);
  });

  test("discards a checkpoint from a different model or target", async () => {
    const path = cachePath();
    const written = await loadTranslationCache(path, header);
    written.set("Hello.", "你好。");
    await written.flush();

    // Switching models in tiro.yml is the operator's way of asking for a
    // better translation; silently resuming the old model's work would defeat
    // that, so the whole checkpoint goes.
    const otherModel = await loadTranslationCache(path, {
      target: "zh",
      model: "different",
    });
    expect(otherModel.restored).toBe(0);
    expect(otherModel.get("Hello.")).toBeUndefined();
  });

  test("treats a corrupt checkpoint as absent rather than failing", async () => {
    const path = cachePath();
    writeFileSync(path, "{ not json at all");
    const cache = await loadTranslationCache(path, header);
    expect(cache.restored).toBe(0);
    // And it recovers: the next flush overwrites the garbage.
    cache.set("Hello.", "你好。");
    await cache.flush();
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });

  test("discard removes the file", async () => {
    const path = cachePath();
    const cache = await loadTranslationCache(path, header);
    cache.set("Hello.", "你好。");
    await cache.flush();
    expect(existsSync(path)).toBe(true);
    await cache.discard();
    expect(existsSync(path)).toBe(false);
    expect(cache.get("Hello.")).toBeUndefined();
  });
});
