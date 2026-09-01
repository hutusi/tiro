import {
  type Block,
  checkAlignment,
  isInlineMathOnlyParagraph,
  joinBlocks,
  splitBlocks,
  VERBATIM_BLOCK_TYPES,
} from "@tiro/shared";
import {
  type Deadline,
  DeadlineExceededError,
  unboundedDeadline,
} from "../deadline.ts";
import type { TranslationCache } from "./cache.ts";
import type { ChatFn } from "./client.ts";

export interface TranslateOptions {
  chat: ChatFn;
  model: string;
  targetLang: string;
  blocks: readonly Block[];
  batchChars?: number;
  /** Blocks longer than this are copied through untranslated — see the config
   * schema for why a single oversized block cannot be handled any other way. */
  maxBlockChars?: number;
  /** Checkpoint of blocks an earlier run already translated. Given one,
   * translation resumes instead of restarting, and flushes as it goes. */
  cache?: TranslationCache;
  /** Run budget. Checked before every LLM call so an over-budget run stops
   * cleanly with its checkpoint intact instead of being killed mid-flight. */
  deadline?: Deadline;
  /** Headroom the deadline must still have for a call to be worth starting —
   * normally the client's per-request timeout, so a call cannot overrun the
   * budget by more than one request. */
  callBudgetMs?: number;
  log?: (message: string) => void;
}

// Seeded from the alignment contract so this can never be the smaller set:
// anything checkAlignment demands back byte-identical must never be sent to
// the model in the first place. The extras are blocks with no prose to
// translate at all.
const VERBATIM_TYPES = new Set([
  ...VERBATIM_BLOCK_TYPES,
  "thematicBreak",
  "html",
]);
const IMAGE_ONLY_RE = /^!\[[^\]]*\]\([^)]*\)$/;
const MARKER = "TIRO_BLOCK";

function isVerbatim(block: Block): boolean {
  if (VERBATIM_TYPES.has(block.type)) return true;
  if (block.type !== "paragraph") return false;
  const text = block.text.trim();
  // Single-line `$$E = mc^2$$` is a paragraph holding one inline-math node,
  // not a math block, so the type check above never catches it.
  return IMAGE_ONLY_RE.test(text) || isInlineMathOnlyParagraph(text);
}

/**
 * Translate a body block-by-block, preserving the 1:1 alignment contract
 * (ADR 0003). Translatable blocks are batched with sentinel markers; a
 * marker mismatch retries once and then falls back to one call per block,
 * which is slow but structurally unbreakable. Returns the translated body,
 * or null when the final alignment gate fails — the caller must then skip
 * writing zh.md entirely rather than ship a misaligned translation.
 *
 * With a `cache` this is resumable: finished blocks are checkpointed as they
 * land, so a run that stops early (budget or crash) hands its work to the
 * next one instead of discarding it (ADR 0008).
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
    maxBlockChars = 20_000,
    cache,
    deadline = unboundedDeadline(),
    callBudgetMs = 0,
    log = () => {},
  } = options;

  const translated: string[] = blocks.map((b) => b.text);
  const candidates = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => !isVerbatim(block));
  const translatable = candidates.filter(
    ({ block }) => block.text.length <= maxBlockChars,
  );
  const oversized = candidates.length - translatable.length;
  if (oversized > 0) {
    log(
      `${oversized} block(s) over ${maxBlockChars} chars kept untranslated — too large to send as one request`,
    );
  }

  // Resume: anything an earlier run already translated is reused as-is and
  // never re-sent, so each run picks up where the last one stopped.
  const todo: Todo[] = [];
  for (const item of translatable) {
    const cached = cache?.get(item.block.text);
    if (cached === undefined) todo.push(item);
    else translated[item.index] = cached;
  }
  const resumed = translatable.length - todo.length;
  if (resumed > 0) {
    log(
      `resuming from checkpoint: ${resumed}/${translatable.length} block(s) already translated`,
    );
  }

  // Every translation lands in the checkpoint as well as the output, so an
  // abandoned run still hands its work to the next one.
  const record = (item: Todo, text: string): void => {
    // Trimmed here rather than at the join, because the join also sees blocks
    // that were never translated. Trimming those strips the leading indent off
    // an *indented* code block, which then re-parses as a paragraph and fails
    // the alignment gate — silently costing the article its whole translation
    // even though the block was never sent anywhere. Verbatim means verbatim.
    const cleaned = text.trim() || item.block.text;
    translated[item.index] = cleaned;
    cache?.set(item.block.text, cleaned);
  };

  /**
   * Decide, in one place, whether a budget stop is honestly resumable.
   *
   * A checkpoint that cannot be written is harmless until the run depends on
   * it, and deferring is that dependency: reporting "resuming next run" with
   * nothing persisted has the next run repeat these same batches, and the one
   * after that, while the log shows steady progress.
   *
   * The budget can end the work in two ways — the check before a call, or the
   * deadline expiring inside one, which the chat client raises. Guarding only
   * the first left the second reporting a resumable skip with nothing saved, so
   * both funnel through here instead. A plain Error, so the pipeline books it
   * as the genuine fault it is rather than as a skip; the original is kept as
   * `cause` and quoted, since it names the batch that was reached.
   */
  const asHardFailureIfUnsaved = (error: unknown): unknown => {
    if (!(error instanceof DeadlineExceededError)) return error;
    const writeError = cache?.writeError;
    if (writeError === undefined) return error;
    return new Error(
      `${String(error)}; the checkpoint could not be written (${String(writeError)}), ` +
        "so this article cannot resume and would repeat this work every run",
      { cause: error },
    );
  };

  // A sentinel collision in the source would corrupt batch parsing.
  const collision = todo.some(({ block }) =>
    block.text.includes(`<<<${MARKER}`),
  );

  try {
    if (collision) {
      log("sentinel collision in source; translating block-by-block");
      for (const item of todo) {
        deadline.check(callBudgetMs, `block ${item.index}`);
        record(
          item,
          await translateSingle(chat, model, targetLang, item.block),
        );
        await cache?.flush();
      }
    } else {
      const batches = packBatches(todo, batchChars);
      for (let b = 0; b < batches.length; b += 1) {
        const batch = batches[b];
        if (batch === undefined) continue;
        deadline.check(callBudgetMs, `batch ${b + 1}/${batches.length}`);
        log(
          `translating batch ${b + 1}/${batches.length} (${batch.length} block(s))`,
        );
        let results: (string | undefined)[] | null;
        try {
          results = await translateBatch(chat, model, targetLang, batch, log);
        } catch (error) {
          // A batch that cannot complete gets the same treatment as one whose
          // markers came back wrong: fall back to per-block. One slow or
          // oversized request used to end the whole article, and with the
          // checkpoint resuming at that same batch it would end every future
          // run too. Per-block requests are far smaller and usually get
          // through. Budget exhaustion is not a transport fault and must not be
          // retried block by block — it has to stay a deferral.
          if (error instanceof DeadlineExceededError) throw error;
          log(`batch ${b + 1}/${batches.length} failed (${String(error)})`);
          results = null;
        }
        if (results === null) {
          log(
            `batch ${b + 1}/${batches.length} falling back to per-block translation`,
          );
        }
        for (let i = 0; i < batch.length; i += 1) {
          const item = batch[i];
          const result = results?.[i];
          if (item === undefined) continue;
          if (result !== undefined) {
            record(item, result);
            continue;
          }
          // The per-block fallback is the slowest path in the pipeline, so
          // checkpoint each one rather than risk repeating them.
          deadline.check(callBudgetMs, `block ${item.index}`);
          record(
            item,
            await translateSingle(chat, model, targetLang, item.block),
          );
          await cache?.flush();
        }
        await cache?.flush();
      }
    }
  } catch (error) {
    // Every way the budget can end this work arrives here — the checks above
    // and a deadline that expired inside a call — so the resumable-or-not
    // question is answered once, in one place.
    throw asHardFailureIfUnsaved(error);
  }

  // Check each translation on its own before joining, and keep the original
  // wherever the shape changed. Building the body out of blocks that have each
  // been verified makes alignment hold by construction, so one bad block costs
  // one untranslated block instead of the article's entire translation.
  //
  // The case this exists for is not a model failure. Turndown converting arXiv
  // MathML can leave a paragraph whose last line is a lone "=" or "-", which
  // markdown reads as a setext heading; the model translates the prose and
  // sensibly drops the stray line, so the block comes back a paragraph. Eight
  // such blocks out of 364 used to reject the whole article, and no prompt can
  // fix a source that means something other than it looks like.
  let reverted = 0;
  const finalText = blocks.map((b, i) => {
    const candidate = translated[i] || b.text;
    if (candidate === b.text) return b.text;
    const reparsed = splitBlocks(candidate);
    if (reparsed.length === 1 && reparsed[0]?.type === b.type) return candidate;
    reverted += 1;
    return b.text;
  });
  if (reverted > 0) {
    log(
      `${reverted} block(s) reverted to the original: the translation changed their markdown shape`,
    );
  }

  const zhBody = joinBlocks(
    blocks.map((b, i) => ({ ...b, text: finalText[i] ?? b.text })),
  );
  const alignment = checkAlignment([...blocks], splitBlocks(zhBody));
  // The checkpoint is deliberately NOT discarded here. Both outcomes below are
  // terminal for this attempt, but neither is durable yet: the caller still has
  // to write zh.md and index.md, and a kill in that window would lose every
  // translated block while leaving the article pending — the exact loss the
  // checkpoint exists to prevent. The caller drops it once index.md lands.
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
    "- Keep inline code spans, URLs, proper nouns, and LaTeX math ($...$ or $$...$$) unchanged, including every backslash and brace.",
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
    "Preserve the markdown structure and keep inline code spans, URLs, proper nouns, and LaTeX math ($...$ or $$...$$) unchanged, including every backslash and brace.",
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
