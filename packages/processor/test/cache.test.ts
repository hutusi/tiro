import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
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
  test("rejects a checkpoint whose entries are not all strings", async () => {
    // Valid JSON that clears every structural guard. A non-string value would
    // reach translateBlocks' join as `translated[i].trim()` and throw, which
    // escapes processOne and leaves the article pending — then throws again on
    // every later run from the same file, so the failure never clears.
    const path = cachePath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        target: "zh",
        model: "m",
        blocks: { good: "你好。", bad: 42 },
      }),
    );
    const cache = await loadTranslationCache(path, header);
    // Whole checkpoint rejected, not filtered: one wrong entry means it is not
    // a checkpoint worth resuming from, same as a header mismatch.
    expect(cache.restored).toBe(0);
    expect(cache.get("good")).toBeUndefined();
  });

  test("rejects null and nested-object entries too", async () => {
    for (const bad of [null, { nested: true }, ["a"]]) {
      const path = cachePath();
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          target: "zh",
          model: "m",
          blocks: { k: bad },
        }),
      );
      expect((await loadTranslationCache(path, header)).restored).toBe(0);
    }
  });
  test("an unwritable checkpoint path costs resumability, not the article", async () => {
    // Same contract as a corrupt checkpoint on read: this is an optimisation.
    // Throwing here would fail an article mid-translation over a file it does
    // not need, and keep failing it while the path stays unwritable.
    const path = cachePath();
    mkdirSync(join(`${path}.tmp`, "wedged"), { recursive: true });
    const logged: string[] = [];
    const cache = await loadTranslationCache(path, header, (m) =>
      logged.push(m),
    );
    cache.set("Hello.", "你好。");
    await cache.flush(); // must not throw
    expect(logged.join("\n")).toContain("could not write checkpoint");
    // In-memory state still serves this run, it just will not survive it.
    expect(cache.get("Hello.")).toBe("你好。");
    // Recorded, so a caller about to defer can tell there is nothing to resume
    // from — swallowing this silently is what let an oversized article repeat
    // the same batches every run while the log claimed progress.
    expect(cache.writeError).toBeDefined();
  });

  test("writeError stays clear while writes succeed", async () => {
    const path = cachePath();
    const cache = await loadTranslationCache(path, header);
    expect(cache.writeError).toBeUndefined();
    cache.set("Hello.", "你好。");
    await cache.flush();
    expect(cache.writeError).toBeUndefined();
  });
});
