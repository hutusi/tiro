import {
  type Block,
  checkAlignment,
  isInlineMathOnlyParagraph,
  joinBlocks,
  mathRanges,
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
  /**
   * Whether `$…$` is math in this article — frontmatter `has_math`. Must match
   * how the site will render it: masking single dollars in an article that
   * never declared them curated would hide "5 to " out of "costs $5 to $10"
   * and leave the price untranslated.
   */
  singleDollarMath?: boolean;
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

/**
 * A figure exactly as the clipper emits it, split into scaffold and caption.
 *
 * Deliberately narrow: it matches the one shape `figureRule` produces and
 * nothing else. Any other raw HTML in the vault stays verbatim, which is the
 * safe direction — this is the only html we know the internal structure of.
 */
const FIGURE_CAPTION_RE =
  /^(<figure>(?:<a\b[^>]*>)?<img\b[^>]*>(?:<\/a>)?<figcaption>)([\s\S]*)(<\/figcaption><\/figure>)$/;

/**
 * Split a caption into its text and its tags, quote-aware.
 *
 * A `/<[^>]+>/` scan reads the first `>` as the tag's end, so
 * `<a title="1 > 0" href="…">` is cut mid-attribute and the href is left in
 * the text handed to the model — which then rewrites it. The clipper escapes
 * that case (`innerHTML` serialisation writes `&gt;`), but the processor also
 * runs over vault HTML nobody generated, so the parse cannot assume canonical
 * input.
 *
 * Returns null when a tag never closes. That is the safe direction: the caller
 * drops the block from translation rather than fall back to sending it whole,
 * and an English caption is a much smaller loss than an invented URL.
 */
function maskTags(
  text: string,
  firstToken: number,
): { masked: string; tags: string[] } | null {
  let masked = "";
  let cursor = 0;
  const tags: string[] = [];
  for (;;) {
    const open = text.indexOf("<", cursor);
    if (open === -1) return { masked: masked + text.slice(cursor), tags };
    masked += text.slice(cursor, open);
    let end = open + 1;
    let quote = "";
    while (end < text.length) {
      const char = text[end] ?? "";
      if (quote !== "") {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
      end += 1;
    }
    if (end >= text.length) return null; // unterminated tag
    masked += MATH_TOKEN(firstToken + tags.length);
    tags.push(text.slice(open, end + 1));
    cursor = end + 1;
  }
}

function isVerbatim(block: Block): boolean {
  // A figure's caption is prose and was translated when it was a paragraph;
  // keeping the whole block verbatim just because it is now html would leave
  // English captions under Chinese figures. Only the caption is sent — see
  // `maskBlock`.
  if (block.type === "html") return !FIGURE_CAPTION_RE.test(block.text.trim());
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
    singleDollarMath = false,
    log = () => {},
  } = options;

  const translated: string[] = blocks.map((b) => b.text);
  // Filter first: masking every block would parse code and top-level math only
  // to discard the result.
  const candidates = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => !isVerbatim(block))
    // flatMap, not map: a block whose markup cannot be masked safely is
    // dropped here and stays in its original language. Translating it anyway
    // would mean handing the model markup to rewrite.
    .flatMap((item) => {
      const masked = maskBlock(item.block.text, singleDollarMath);
      return masked === null ? [] : [{ ...item, ...masked }];
    });
  const translatable = candidates.filter(
    ({ block }) => block.text.length <= maxBlockChars,
  );
  const oversized = candidates.length - translatable.length;
  if (oversized > 0) {
    log(
      `${oversized} block(s) over ${maxBlockChars} chars kept untranslated — too large to send as one request`,
    );
  }

  // A source that already contains a math token would have unmaskMath put a
  // formula where the author wrote prose. Vanishingly unlikely, but the cost
  // of being wrong is a corrupted paragraph, so refuse to mask that block.
  //
  // Refusing to mask means sending the block as written, which is right for a
  // paragraph — every character of it was going to the model anyway. It is
  // wrong for a figure, whose markup is masked precisely so the model never
  // sees it: unmasking there hands over the image path and every href, and a
  // rewritten one publishes, because an html block is compared by type. So a
  // figure is dropped instead, and keeps its original language.
  //
  // This runs before the checkpoint is consulted, not after. A dropped figure
  // must not come back through the cache either: a checkpoint written by an
  // earlier build holds whatever that build produced, and restoring it
  // publishes a rewritten image path with no model call to notice.
  let forgedFigures = 0;
  const maskable = translatable.flatMap((item) => {
    const forged =
      item.formulas.length > 0 && item.block.text.includes("TIROMATH");
    if (!forged) return [item];
    if (FIGURE_CAPTION_RE.test(item.block.text.trim())) {
      forgedFigures += 1;
      return [];
    }
    return [{ ...item, masked: item.block.text, formulas: [] }];
  });
  if (forgedFigures > 0) {
    log(
      `${forgedFigures} figure(s) left untranslated — their caption contains the masking sentinel`,
    );
  }

  // Resume: anything an earlier run already translated is reused as-is and
  // never re-sent, so each run picks up where the last one stopped.
  const todo: Todo[] = [];
  for (const item of maskable) {
    const cached = cache?.get(item.block.text);
    if (cached === undefined) todo.push(item);
    else translated[item.index] = cached;
  }
  const resumed = maskable.length - todo.length;
  if (resumed > 0) {
    log(
      `resuming from checkpoint: ${resumed}/${maskable.length} block(s) already translated`,
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
    // Restored before anything else sees it: the checkpoint is keyed on the
    // original text and must hold a real translation, or a resumed run reads
    // the tokens back out and publishes TIROMATH0 into zh.md.
    const restored = unmaskMath(text.trim(), item.formulas);
    const cleaned = restored?.trim() || item.block.text;
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
          await translateSingle(chat, model, targetLang, item.masked),
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
            await translateSingle(chat, model, targetLang, item.masked),
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
  const mathOf = (text: string): string =>
    mathRanges(text, { singleDollar: singleDollarMath })
      .filter((r) => r.terminated)
      .map((r) => r.value)
      .sort()
      .join("\u0000");
  const finalText = blocks.map((b, i) => {
    const candidate = translated[i] || b.text;
    if (candidate === b.text) return b.text;
    const reparsed = splitBlocks(candidate);
    if (reparsed.length !== 1 || reparsed[0]?.type !== b.type) {
      reverted += 1;
      return b.text;
    }
    // Masking means the formulas should come back untouched; a difference here
    // is the model having invented or destroyed one — most plausibly by
    // dropping the backslash from an escaped `\$`, which would turn a price
    // into a formula in the translated pane alone.
    if (mathOf(candidate) !== mathOf(b.text)) {
      reverted += 1;
      return b.text;
    }
    return candidate;
  });
  if (reverted > 0) {
    log(
      `${reverted} block(s) reverted to the original: the translation changed their markdown shape or their math`,
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
  /** `block.text` with each formula replaced by a token — what gets sent. */
  masked: string;
  /** The formulas, in the order their tokens appear. */
  formulas: string[];
}

/**
 * Opaque and markdown-inert, and deliberately unlike the batch protocol's
 * `<<<TIRO_BLOCK_n>>>` so the two can never be confused for one another.
 *
 * Zero-padded to a fixed width so no token can ever be a prefix of another.
 * Unpadded, `TIROMATH1` is a prefix of `TIROMATH10`, so the uniqueness check
 * in `unmaskMath` saw a duplicate and reverted the block — every paragraph
 * with eleven or more formulas silently stayed in English, which in dense
 * mathematical prose is a common paragraph rather than a rare one.
 */
const TOKEN_DIGITS = 4;
const MAX_MASKED = 10 ** TOKEN_DIGITS;
const MATH_TOKEN = (i: number) =>
  `TIROMATH${String(i).padStart(TOKEN_DIGITS, "0")}`;

/**
 * Replace every inline formula with a token.
 *
 * The prompt asking the model to leave LaTeX alone was the only thing
 * protecting it, and a mangled formula passes every structural gate: the block
 * still parses as a paragraph, so alignment is satisfied and wrong mathematics
 * publishes silently. Backslashes and braces are exactly what a translation
 * pass rewrites. The model cannot mangle what it never sees.
 */
function maskMath(text: string, singleDollar: boolean) {
  // Only closed fences: an unclosed `$$` is prose (see normalizeBlockMath),
  // and hiding it from the model would leave that text untranslated.
  const ranges = mathRanges(text, { singleDollar })
    .filter((r) => r.terminated)
    .sort((a, b) => a.start - b.start);
  // Beyond the token width the padding stops guaranteeing distinct tokens.
  // Leaving such a block unmasked is the safe direction: it falls back to the
  // protection that existed before, rather than to a wrong substitution.
  if (ranges.length === 0 || ranges.length > MAX_MASKED) {
    return { masked: text, formulas: [] };
  }
  let masked = "";
  let cursor = 0;
  const formulas: string[] = [];
  for (const range of ranges) {
    masked += text.slice(cursor, range.start) + MATH_TOKEN(formulas.length);
    formulas.push(text.slice(range.start, range.end));
    cursor = range.end;
  }
  return { masked: masked + text.slice(cursor), formulas };
}

/**
 * Mask a block down to the prose the model should actually see.
 *
 * For everything but a figure this is `maskMath` unchanged. A figure is
 * `<figure><img …><figcaption>` + caption + `</figcaption></figure>`, and only
 * the caption is prose: the scaffolding is masked as two more tokens, so the
 * markup the model never sees is the markup it cannot mangle — the same bargain
 * `maskMath` makes for formulas, reusing the same tokens and the same
 * exactly-once check on the way back.
 *
 * Sending the whole figure instead would put an `<img src>` in front of a
 * translation model, and a mangled one passes every gate: `checkAlignment`
 * asks an html block for its type, not its bytes, so a rewritten path would
 * publish as a broken image rather than fail the run.
 */
function maskBlock(text: string, singleDollar: boolean) {
  const figure = FIGURE_CAPTION_RE.exec(text.trim());
  if (figure === null) return maskMath(text, singleDollar);
  const [, open = "", caption = "", close = ""] = figure;
  const inner = maskMath(caption, singleDollar);
  // Every tag inside the caption is masked too, not just the scaffold. A
  // caption's own markup is usually a credit link, and sending it means
  // sending an href: a model that rewrites one produces a caption pointing
  // somewhere the page never linked, and nothing downstream can tell — an
  // html block is compared by type, so a hallucinated URL passes every gate
  // and publishes. Masking leaves the model exactly the prose to translate.
  const tagged = maskTags(inner.masked, inner.formulas.length);
  if (tagged === null) return null;
  const formulas = [...inner.formulas, ...tagged.tags];
  // The scaffold's two tokens must still fit inside the padded token width.
  // Skipping is the only safe answer: returning the block unmasked would send
  // the whole figure — image path and hrefs included — which is the leak this
  // masking exists to prevent, arriving through a different door.
  if (formulas.length + 2 > MAX_MASKED) return null;
  const first = formulas.length;
  return {
    masked: `${MATH_TOKEN(first)}${tagged.masked}${MATH_TOKEN(first + 1)}`,
    formulas: [...formulas, open, close],
  };
}

/**
 * Put the formulas back. Returns null when the tokens did not survive — the
 * caller then keeps the original block, so a model that mangled a token costs
 * one untranslated paragraph rather than one wrong formula.
 */
function unmaskMath(text: string, formulas: readonly string[]): string | null {
  let out = text;
  for (let i = 0; i < formulas.length; i += 1) {
    const token = MATH_TOKEN(i);
    const first = out.indexOf(token);
    if (first === -1 || out.indexOf(token, first + token.length) !== -1) {
      return null; // dropped, or duplicated into a second formula
    }
    // A callback, never the string: `$$`, `$&`, `` $` `` and `$'` are all
    // replacement syntax, and all of them occur in LaTeX. Passing the formula
    // directly restored `$$O(n)$$` as `$O(n)$`, and `$a$&$b$` as
    // `$aTIROMATH0000$b$` — the token put back into the text by `$&`.
    out = out.replace(token, () => formulas[i] ?? "");
  }
  return out;
}

function packBatches(todo: readonly Todo[], batchChars: number): Todo[][] {
  const batches: Todo[][] = [];
  let current: Todo[] = [];
  let size = 0;
  for (const item of todo) {
    if (current.length > 0 && size + item.masked.length > batchChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.masked.length;
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
    .map((item, i) => `<<<${MARKER}_${i}>>>\n${item.masked}`)
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
  blockText: string,
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
      { role: "user", content: blockText },
    ],
  });
  return raw.trim();
}
