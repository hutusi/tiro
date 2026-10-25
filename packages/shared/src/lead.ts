import { parse as parseYaml } from "yaml";
import {
  imageOffsets,
  markdownLinks,
  plainText,
  splitBlocks,
} from "./blocks.ts";
import {
  type ArticleFrontmatter,
  ArticleFrontmatterSchema,
  FRONTMATTER_RE,
  parseArticle,
  stringifyArticle,
} from "./frontmatter.ts";

/**
 * Adding an article's lead — its dek and lead picture — to an article already
 * saved without it (ADR 0053).
 *
 * The clipper used to leave out a header set beside the body (ADR 0052), and
 * a code fix only helps the next clip. Re-clipping repairs an old article by
 * replacing its whole body and reprocessing it from nothing, which is the
 * cost this exists to avoid: the rest of the body stays byte for byte as it
 * is, only the missing parts of the lead are inserted at its top, and the
 * article is marked for a run that translates the new blocks and keeps
 * everything else it already wrote (`tiro.refresh`).
 *
 * One rule for every repair — the extension's "Add missing lead" on a page in
 * the reader's own browser, and the sweep's offline passes over saved pages
 * and stored excerpts — so the three cannot disagree about what is missing.
 */

/** The outcome of offering a lead to a saved article. */
export type LeadMerge =
  | {
      kind: "merged";
      /** The new `index.md`. */
      text: string;
      /** The lead blocks inserted, in the order they now stand. */
      added: string[];
    }
  /** Every part of the lead is already in the article. */
  | { kind: "unchanged" }
  | { kind: "refused"; reason: string };

/** Letters a paragraph needs before it can say where an article begins. */
const MIN_START_LETTERS = 30;

/** How much of a paragraph is compared, normalized. */
const KEY_CHARS = 60;

/** A caption shorter than this is not evidence the picture is there. */
const MIN_CAPTION_LETTERS = 10;

/**
 * Insert the parts of `lead` that `indexText`'s article is missing, at the top
 * of its body.
 *
 * `pageMarkdown` is the whole clip the lead came from, lead included — the
 * page the reader is on, or a saved copy of it — and is how the article is
 * known to be the same one: its first paragraph after the lead must be the
 * article's first paragraph after whatever lead it already opens with. A page
 * that has since changed, a paywall stub, an archived copy of another version
 * all fail that, and nothing is written. `null` when the lead came from the
 * article itself (its stored excerpt), which needs no such check.
 *
 * A dek is missing unless its words are already somewhere in the body. A
 * picture is missing unless the article already opens with one, or its
 * address or its caption is already in the body: a saved article names its
 * pictures by downloaded file, so the address alone cannot say.
 *
 * Missing parts go where the page has them relative to the parts that are
 * there — a picture under a dek the article already opens with, a dek above
 * the picture it opens with — and everything else in the body keeps its
 * bytes. The frontmatter loses `tiro.processed_at`, so the next run takes the
 * article (invariant 3), and gains `tiro.refresh: translation` when it had
 * been processed with a summary, so that run keeps the summary.
 */
export function mergeLead(
  indexText: string,
  lead: string,
  pageMarkdown: string | null,
): LeadMerge {
  const leadBlocks = splitBlocks(lead);
  if (leadBlocks.length === 0) return { kind: "unchanged" };
  if (leadBlocks.some((block) => block.type !== "paragraph")) {
    return { kind: "refused", reason: "the lead is not paragraphs" };
  }
  let parsed: ReturnType<typeof parseArticle>;
  try {
    parsed = parseArticle(indexText);
  } catch (error) {
    return {
      kind: "refused",
      reason: `the article cannot be read: ${(error as Error).message}`,
    };
  }
  const { frontmatter, body } = parsed;
  const bodyBlocks = splitBlocks(body);
  const leads = leadBlocks.map((block) => ({
    text: block.text,
    picture: imageOffsets(block.text).length > 0,
    key: keyOf(block.text),
  }));

  // What the article already opens with: blocks matching a dek of this lead,
  // and pictures. Where it stops is where the article proper begins.
  let opening = 0;
  for (const block of bodyBlocks) {
    const isPicture = imageOffsets(block.text).length > 0;
    const isDek = leads.some(
      (part) =>
        !part.picture && part.key !== "" && keyOf(block.text) === part.key,
    );
    if (block.type !== "paragraph" || !(isPicture || isDek)) break;
    opening++;
  }

  if (pageMarkdown !== null) {
    const page = pageMarkdown.startsWith(lead)
      ? pageMarkdown.slice(lead.length)
      : pageMarkdown;
    const pageStart = firstProseKey(splitBlocks(page).map((b) => b.text));
    const articleStart = firstProseKey(
      bodyBlocks.slice(opening).map((b) => b.text),
    );
    if (pageStart === null || pageStart !== articleStart) {
      return {
        kind: "refused",
        reason: "the page no longer begins where the article does",
      };
    }
  }

  const bodyText = normalized(plainText(body));
  const bodyUrls = new Set(markdownLinks(body).map((link) => link.url));
  const anchors: (number | null)[] = [];
  const present: boolean[] = [];
  for (const part of leads) {
    if (part.picture) {
      const at = bodyBlocks
        .slice(0, opening)
        .findIndex((block) => imageOffsets(block.text).length > 0);
      const urls = markdownLinks(part.text)
        .filter((link) => link.type === "image")
        .map((link) => link.url);
      const caption = normalized(plainText(part.text));
      const there =
        at !== -1 ||
        urls.some((url) => bodyUrls.has(url)) ||
        (caption.replace(/ /g, "").length >= MIN_CAPTION_LETTERS &&
          bodyText.includes(caption.slice(0, KEY_CHARS)));
      present.push(there);
      anchors.push(at === -1 ? null : at);
    } else {
      const at = bodyBlocks
        .slice(0, opening)
        .findIndex((block) => keyOf(block.text) === part.key);
      present.push(part.key === "" || bodyText.includes(part.key));
      anchors.push(at === -1 ? null : at);
    }
  }
  if (present.every(Boolean)) return { kind: "unchanged" };

  // Where each missing part goes: after the last part before it that the
  // article already opens with, else at the very top — which puts a picture
  // under a dek the article opens with, and a dek above a picture it opens
  // with, as the page has them.
  const inserts = new Map<number, string[]>();
  const added: string[] = [];
  leads.forEach((part, i) => {
    if (present[i]) return;
    let position = 0;
    for (let j = i - 1; j >= 0; j--) {
      const at = anchors[j];
      if (at !== null && at !== undefined) {
        position = at + 1;
        break;
      }
    }
    inserts.set(position, [...(inserts.get(position) ?? []), part.text]);
    added.push(part.text);
  });

  // Inserted by offset, so every byte of the old body stays as it was.
  const offsets: number[] = [];
  let from = 0;
  for (const block of bodyBlocks) {
    const at = body.indexOf(block.text, from);
    offsets.push(at);
    from = at + block.text.length;
  }
  let newBody = "";
  let cursor = 0;
  for (const position of [...inserts.keys()].sort((a, b) => a - b)) {
    const at =
      position >= bodyBlocks.length ? body.length : (offsets[position] ?? 0);
    newBody += body.slice(cursor, at);
    newBody += (inserts.get(position) ?? []).map((t) => `${t}\n\n`).join("");
    cursor = at;
  }
  newBody += body.slice(cursor);

  // Edited on the frontmatter as written rather than as the schema parses
  // it, which would also reorder its keys and turn a two-line change into a
  // diff of the whole block.
  const raw = parseYaml(indexText.match(FRONTMATTER_RE)?.[1] ?? "") as Record<
    string,
    unknown
  > & { tiro: Record<string, unknown> };
  const { processed_at: processedAt, ...tiro } = raw.tiro;
  const keepSummary =
    processedAt !== undefined &&
    frontmatter.summary !== undefined &&
    frontmatter.tiro.summary_failed !== true;
  const updated = {
    ...raw,
    tiro: {
      ...tiro,
      // An earlier repair's hint, not yet settled, is kept with the rest.
      ...(keepSummary ? { refresh: "translation" } : {}),
    },
  } as ArticleFrontmatter;
  const text = stringifyArticle(updated, newBody);

  // Read back, so a serializer surprise cannot write anything but this.
  const check = parseArticle(text);
  if (check.body.trimEnd() !== newBody.trimEnd()) {
    return { kind: "refused", reason: "the merged body did not read back" };
  }
  if (
    canonical(check.frontmatter) !==
    canonical(ArticleFrontmatterSchema.parse(updated))
  ) {
    return {
      kind: "refused",
      reason: "the merged frontmatter did not read back",
    };
  }
  return { kind: "merged", text, added };
}

/** Text as a key: letters and digits, case-folded, one space between runs. */
function normalized(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A block's prose as a key, alt text left out (`plainText`). */
function keyOf(markdown: string): string {
  return normalized(plainText(markdown)).slice(0, KEY_CHARS);
}

/** The key of the first block that is a paragraph of prose. */
function firstProseKey(blocks: readonly string[]): string | null {
  for (const text of blocks) {
    if (imageOffsets(text).length > 0) continue;
    const prose = normalized(plainText(text));
    if ((prose.match(/\p{L}/gu)?.length ?? 0) < MIN_START_LETTERS) continue;
    return prose.slice(0, KEY_CHARS);
  }
  return null;
}

/** JSON with every object's keys sorted: equal for equal data, whatever
 * order the parser builds an object in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}
