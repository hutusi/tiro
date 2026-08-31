import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  test("never leaves the live checkpoint truncated (write-then-rename)", async () => {
    // The failure this prevents: timeout-minutes kills the job partway through
    // overwriting the file, the next run reads truncated JSON as "no
    // checkpoint", and the article restarts from batch 1 — in exactly the
    // scenario the checkpoint exists for.
    const path = cachePath();
    const first = await loadTranslationCache(path, header);
    for (let i = 0; i < 400; i += 1) first.set(`block ${i}`, `译文 ${i}`);
    await first.flush();
    const sizeAfterFirst = statSync(path).size;
    expect(sizeAfterFirst).toBeGreaterThan(1000);

    // A second, larger flush must land whole or not at all.
    const second = await loadTranslationCache(path, header);
    expect(second.restored).toBe(400);
    for (let i = 400; i < 800; i += 1) second.set(`block ${i}`, `译文 ${i}`);
    await second.flush();

    const reread = await loadTranslationCache(path, header);
    expect(reread.restored).toBe(800);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
    // The staging file must not survive a successful write.
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  test("cleans up staging debris from a run killed mid-write", async () => {
    const path = cachePath();
    const cache = await loadTranslationCache(path, header);
    cache.set("Hello.", "你好。");
    await cache.flush();

    // What a kill between write and rename leaves behind. The vault workflow
    // runs `git add -A`, so litter here would be committed.
    writeFileSync(`${path}.tmp`, '{ "version": 1, "blocks": { "trunc');

    const reloaded = await loadTranslationCache(path, header);
    expect(reloaded.get("Hello.")).toBe("你好。"); // real checkpoint intact
    expect(existsSync(`${path}.tmp`)).toBe(false); // debris gone
  });

  test("discard removes the staging file too", async () => {
    const path = cachePath();
    const cache = await loadTranslationCache(path, header);
    cache.set("Hello.", "你好。");
    await cache.flush();
    writeFileSync(`${path}.tmp`, "debris");
    await cache.discard();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
