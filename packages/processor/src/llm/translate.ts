import {
  type Block,
  checkAlignment,
  joinBlocks,
  splitBlocks,
} from "@tiro/shared";
import type { ChatFn } from "./client.ts";

export interface TranslateOptions {
  chat: ChatFn;
  model: string;
  targetLang: string;
  blocks: readonly Block[];
  batchChars?: number;
  log?: (message: string) => void;
}

const VERBATIM_TYPES = new Set(["code", "thematicBreak", "html"]);
const IMAGE_ONLY_RE = /^!\[[^\]]*\]\([^)]*\)$/;
const MARKER = "TIRO_BLOCK";

function isVerbatim(block: Block): boolean {
  if (VERBATIM_TYPES.has(block.type)) return true;
  return block.type === "paragraph" && IMAGE_ONLY_RE.test(block.text.trim());
}

/**
 * Translate a body block-by-block, preserving the 1:1 alignment contract
 * (ADR 0003). Translatable blocks are batched with sentinel markers; a
 * marker mismatch retries once and then falls back to one call per block,
 * which is slow but structurally unbreakable. Returns the translated body,
 * or null when the final alignment gate fails — the caller must then skip
 * writing zh.md entirely rather than ship a misaligned translation.
 */
export async function translateBlocks(
  options: TranslateOptions,
): Promise<string | null> {
  const {
    chat,
    model,
    targetLang,
    blocks,
    batchChars = 10_000,
    log = () => {},
  } = options;

  const translated: string[] = blocks.map((b) => b.text);
  const todo = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => !isVerbatim(block));

  // A sentinel collision in the source would corrupt batch parsing.
  const collision = todo.some(({ block }) =>
    block.text.includes(`<<<${MARKER}`),
  );

  if (collision) {
    log("sentinel collision in source; translating block-by-block");
    for (const { block, index } of todo) {
      translated[index] = await translateSingle(chat, model, targetLang, block);
    }
  } else {
    const batches = packBatches(todo, batchChars);
    for (let b = 0; b < batches.length; b += 1) {
      const batch = batches[b];
      if (batch === undefined) continue;
      log(
        `translating batch ${b + 1}/${batches.length} (${batch.length} block(s))`,
      );
      const results = await translateBatch(chat, model, targetLang, batch, log);
      if (results === null) {
        log(
          `batch ${b + 1}/${batches.length} falling back to per-block translation`,
        );
      }
      for (let i = 0; i < batch.length; i += 1) {
        const item = batch[i];
        const result = results?.[i];
        if (item === undefined) continue;
        translated[item.index] =
          result ??
          (await translateSingle(chat, model, targetLang, item.block));
      }
    }
  }

  const zhBody = joinBlocks(
    blocks.map((b, i) => ({
      ...b,
      text: (translated[i] ?? b.text).trim() || b.text,
    })),
  );
  const alignment = checkAlignment([...blocks], splitBlocks(zhBody));
  if (!alignment.ok) {
    log(
      `translation misaligned, refusing to write zh.md: ${alignment.errors.join("; ")}`,
    );
    return null;
  }
  return zhBody;
}

interface Todo {
  block: Block;
  index: number;
}

function packBatches(todo: readonly Todo[], batchChars: number): Todo[][] {
  const batches: Todo[][] = [];
  let current: Todo[] = [];
  let size = 0;
  for (const item of todo) {
    if (current.length > 0 && size + item.block.text.length > batchChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.block.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function batchSystemPrompt(targetLang: string): string {
  return [
    `You translate markdown blocks into the language "${targetLang}".`,
    "Rules:",
    "- Translate each block independently; never merge, split, reorder, or drop blocks.",
    "- Preserve markdown structure: a heading stays a heading of the same level, a list stays a list with the same items, a table keeps its rows and columns.",
    "- Keep inline code spans, URLs, and proper nouns unchanged.",
    "- Reproduce each block's marker line exactly as given, followed by that block's translation.",
    "- Output nothing before the first marker and nothing after the last block's translation.",
  ].join("\n");
}

async function translateBatch(
  chat: ChatFn,
  model: string,
  targetLang: string,
  batch: readonly Todo[],
  log: (message: string) => void,
): Promise<(string | undefined)[] | null> {
  const input = batch
    .map((item, i) => `<<<${MARKER}_${i}>>>\n${item.block.text}`)
    .join("\n");
  const messages = [
    { role: "system" as const, content: batchSystemPrompt(targetLang) },
    { role: "user" as const, content: input },
  ];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const raw = await chat({ model, messages });
    const parsed = parseBatchResponse(raw, batch.length);
    if (parsed !== null) return parsed;
    log(`batch marker mismatch (attempt ${attempt})`);
  }
  return null; // caller falls back to per-block translation
}

function parseBatchResponse(
  raw: string,
  expected: number,
): (string | undefined)[] | null {
  const re = new RegExp(`<<<${MARKER}_(\\d+)>>>\\n?`, "g");
  const parts: (string | undefined)[] = new Array(expected).fill(undefined);
  const matches = [...raw.matchAll(re)];
  if (matches.length !== expected) return null;
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const next = matches[i + 1];
    if (match?.index === undefined) return null;
    const idx = Number(match[1]);
    if (idx !== i || idx >= expected) return null;
    const start = match.index + match[0].length;
    const end = next?.index ?? raw.length;
    parts[idx] = raw.slice(start, end).trim();
  }
  return parts.every((p) => p !== undefined && p !== "") ? parts : null;
}

async function translateSingle(
  chat: ChatFn,
  model: string,
  targetLang: string,
  block: Block,
): Promise<string> {
  const system = [
    `You translate one markdown block into the language "${targetLang}".`,
    "Preserve the markdown structure and keep inline code spans, URLs, and proper nouns unchanged.",
    "Respond with the translated block only — no commentary, no fences.",
  ].join("\n");
  const raw = await chat({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: block.text },
    ],
  });
  return raw.trim();
}
