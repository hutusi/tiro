import { splitBlocks } from "@tiro/shared";

const HAN_RE = /\p{Script=Han}/u;
const LETTER_RE = /\p{L}/u;

/**
 * CJK-codepoint-ratio language heuristic — no LLM call. Code blocks are
 * excluded so an English article full of source code (or a Chinese article
 * quoting English identifiers) classifies by its prose.
 */
export function cjkRatio(body: string): number {
  let han = 0;
  let letters = 0;
  for (const block of splitBlocks(body)) {
    if (block.type === "code") continue;
    for (const ch of block.text) {
      if (!LETTER_RE.test(ch)) continue;
      letters += 1;
      if (HAN_RE.test(ch)) han += 1;
    }
  }
  return letters === 0 ? 0 : han / letters;
}

/** "zh" when the Han ratio reaches the threshold; otherwise "en" (meaning
 * "not the translation target", not a real language detection). */
export function detectLang(body: string, threshold: number): "zh" | "en" {
  return cjkRatio(body) >= threshold ? "zh" : "en";
}
