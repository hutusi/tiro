import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitBlocks } from "@tiro/shared";
import {
  loadTranslationCache,
  TRANSLATION_CACHE_FILE,
} from "../src/llm/cache.ts";
import { checkpointKey, liveKeys } from "../src/llm/checkpoint-key.ts";
import type { ChatFn } from "../src/llm/client.ts";
import { translateBlocks } from "../src/llm/translate.ts";
import { makeFakeChat } from "./helpers.ts";

const header = { target: "zh", model: "m" };

function cachePath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "tiro-checkpoint-key-")),
    TRANSLATION_CACHE_FILE,
  );
}

const HOTLINKED =
  "![](https://cdn.example/media/img/river.jpg)  \nA steamboat on the river at dawn.";
const DOWNLOADED =
  "![](./assets/6295da668701.jpg)  \nA steamboat on the river at dawn.";

/** Translate `text` as a one-block body against the checkpoint at `path`,
 * returning the translation and what the model was sent. */
async function translateOne(
  path: string,
  text: string,
  chat?: ChatFn,
): Promise<{ zh: string; sent: string }> {
  const seen: string[] = [];
  const zh = await translateBlocks({
    chat:
      chat ??
      makeFakeChat({
        onRequest: (r) => seen.push(r.messages.at(-1)?.content ?? ""),
      }),
    model: "m",
    targetLang: "zh",
    blocks: splitBlocks(text),
    cache: await loadTranslationCache(path, header),
  });
  return { zh: (zh ?? "").trimEnd(), sent: seen.join("\n") };
}

/** Translate, then settle the checkpoint the way the pipeline does on success. */
async function settle(path: string, text: string): Promise<void> {
  const cache = await loadTranslationCache(path, header);
  await translateBlocks({
    chat: makeFakeChat(),
    model: "m",
    targetLang: "zh",
    blocks: splitBlocks(text),
    cache,
  });
  cache.retain(liveKeys(cache, [text]));
  await cache.flush();
}

function entries(path: string): Record<string, string> {
  return JSON.parse(readFileSync(path, "utf8")).blocks;
}

describe("checkpointKey", () => {
  test("sets aside where links and pictures point, and nothing else", () => {
    const { key, destinations } = checkpointKey(
      'See ![a map](./assets/x.png), [the report](https://a.example/r "The report") and [a page](<https://a.example/with space>).',
    );
    expect(destinations).toEqual([
      "./assets/x.png",
      "https://a.example/r",
      "<https://a.example/with space>",
    ]);
    // The words stay in the key: alt text, link text, a title.
    expect(key).toContain("![a map](TIRODEST0000)");
    expect(key).toContain('[the report](TIRODEST0001 "The report")');
  });

  test("reads an address with its own parentheses, and raw HTML", () => {
    expect(
      checkpointKey("A [wiki page](https://w.example/Foo_(bar)) here.")
        .destinations,
    ).toEqual(["https://w.example/Foo_(bar)"]);
    expect(
      checkpointKey('A caption <img src="https://cdn.example/a.jpg"> here.')
        .destinations,
    ).toEqual(["https://cdn.example/a.jpg"]);
  });

  test("keeps a block that points nowhere under its own text", () => {
    for (const text of [
      "Plain words with nothing to point at.",
      "An autolink <https://a.example/> is its own text.",
      "A block that already says TIRODEST0000 [here](https://a.example/).",
    ]) {
      expect(checkpointKey(text)).toEqual({ key: text, destinations: [] });
    }
  });
});

describe("a checkpoint keyed on words, not addresses", () => {
  test("reuses a caption whose picture moved to ./assets", async () => {
    const path = cachePath();
    await settle(path, HOTLINKED);
    const { zh, sent } = await translateOne(path, DOWNLOADED);
    expect(sent).toBe("");
    // The translation points where the source now does.
    expect(zh).toBe(
      "中文：![](./assets/6295da668701.jpg)  \n中文：A steamboat on the river at dawn.",
    );
  });

  test("reuses a block whose link was retargeted", async () => {
    const path = cachePath();
    await settle(path, "Read [the first part](https://a.example/1) first.");
    const { zh, sent } = await translateOne(
      path,
      "Read [the first part](https://tiro.example/s/abc) first.",
    );
    expect(sent).toBe("");
    expect(zh).toBe(
      "中文：Read [the first part](https://tiro.example/s/abc) first.",
    );
  });

  test("translates again when the words change, or the markup does", async () => {
    for (const changed of [
      "![](./assets/6295da668701.jpg)  \nA steamboat on the river at dusk.",
      "![](./assets/6295da668701.jpg)  \nA steamboat on the *river* at dawn.",
      "![a steamboat](./assets/6295da668701.jpg)  \nA steamboat on the river at dawn.",
    ]) {
      const path = cachePath();
      await settle(path, HOTLINKED);
      expect((await translateOne(path, changed)).sent).not.toBe("");
    }
  });

  test("reuses an entry from before, and moves it to its new key", async () => {
    const path = cachePath();
    const old = await loadTranslationCache(path, header);
    old.set(
      HOTLINKED,
      "![](https://cdn.example/media/img/river.jpg)  \n黎明时河上的一艘汽船。",
    );
    await old.flush();

    // Read as it always was, for its exact text.
    const cache = await loadTranslationCache(path, header);
    const zh = await translateBlocks({
      chat: makeFakeChat({
        onRequest: () => {
          throw new Error("sent to the model");
        },
      }),
      model: "m",
      targetLang: "zh",
      blocks: splitBlocks(HOTLINKED),
      cache,
    });
    expect(zh).toContain("黎明时河上的一艘汽船。");
    cache.retain(liveKeys(cache, [HOTLINKED]));
    await cache.flush();
    // Moved, not copied: one entry, and the picture moving next finds it.
    expect(Object.keys(entries(path))).toHaveLength(1);
    const moved = await translateOne(path, DOWNLOADED);
    expect(moved.sent).toBe("");
    expect(moved.zh).toBe(
      "![](./assets/6295da668701.jpg)  \n黎明时河上的一艘汽船。",
    );
  });

  test("keeps a translation whose address the model changed under its exact text", async () => {
    const path = cachePath();
    // The model drops a character from the address.
    const altering: ChatFn = async (request) => {
      const user = request.messages.at(-1)?.content ?? "";
      return user
        .replace("river.jpg", "rivr.jpg")
        .replace(/A steamboat/g, "汽船");
    };
    const cache = await loadTranslationCache(path, header);
    await translateBlocks({
      chat: altering,
      model: "m",
      targetLang: "zh",
      blocks: splitBlocks(HOTLINKED),
      cache,
    });
    cache.retain(liveKeys(cache, [HOTLINKED]));
    await cache.flush();
    // The same text is still reused, exactly as before this change…
    expect((await translateOne(path, HOTLINKED)).sent).toBe("");
    // …but no other address is ever filled into it.
    expect((await translateOne(path, DOWNLOADED)).sent).not.toBe("");
  });

  test("never fills a stored translation whose tokens do not fit", async () => {
    const path = cachePath();
    const seeded = await loadTranslationCache(path, header);
    seeded.set(
      checkpointKey(DOWNLOADED).key,
      "TIRODEST0000  \n黎明时河上的一艘汽船。TIRODEST0001",
    );
    await seeded.flush();
    const { zh, sent } = await translateOne(path, DOWNLOADED);
    expect(sent).not.toBe("");
    expect(zh).not.toContain("TIRODEST");
  });

  test("keeps a block naming one address twice under its exact text", async () => {
    const twice =
      "Read [part one](https://a.example/1) and [the same part](https://a.example/1) again.";
    const path = cachePath();
    await settle(path, twice);
    expect(Object.keys(entries(path))).toHaveLength(1);
    expect((await translateOne(path, twice)).sent).toBe("");
    expect(
      (await translateOne(path, twice.replace(/a\.example\/1/g, "b.example/2")))
        .sent,
    ).not.toBe("");
  });
});
