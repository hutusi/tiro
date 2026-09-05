#!/usr/bin/env bun
/**
 * Regenerate the site's brand assets — run `bun run brand` in apps/site after
 * changing the mark. brand/README.md says what each file is for.
 *
 * The mark is the oxblood monogram of ADR 0014: a rounded square carrying
 * Spectral's "T". The glyph is outlined from the webfont into a <path>, so
 * favicon.svg needs no font at render time (browsers draw SVG favicons
 * without webfonts, and a system-serif fallback would change the letter).
 * The rasters come from headless Chrome, the one renderer this repo already
 * relies on for icons (apps/extension/icons/README.md explains the wrapper
 * trick: sizing an <img> in CSS is what makes viewport and drawing agree).
 */
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "opentype.js";

const site = resolve(import.meta.dirname, "..");
const publicDir = join(site, "public");
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const OXBLOOD = "#8f2f2f";
const CREAM = "#f4efe4";
const INK = "#1e1b16";
const INK_SOFT = "#5a544a";

// opentype.js reads WOFF (v1), not WOFF2; fontsource ships both.
const woff = readFileSync(
  join(
    site,
    "node_modules/@fontsource/spectral/files/spectral-latin-600-normal.woff",
  ),
);
const spectral = parse(
  woff.buffer.slice(woff.byteOffset, woff.byteOffset + woff.byteLength),
);

/** Outline `text` at `size`px, its bounding box centred in a `box`px square
 * and nudged up by `lift`px — the design sets the T with 4px of bottom
 * padding, which reads as optically centred. */
function centred(
  text: string,
  size: number,
  box: number,
  lift: number,
): string {
  const probe = spectral.getPath(text, 0, 0, size).getBoundingBox();
  const dx = (box - (probe.x2 - probe.x1)) / 2 - probe.x1;
  const dy = (box - (probe.y2 - probe.y1)) / 2 - probe.y1 - lift;
  return spectral.getPath(text, dx, dy, size).toPathData(2);
}

/** The monogram on a 72-unit canvas; `radius` 16 is the design's badge,
 * 0 the full-bleed square iOS wants (it applies its own corner mask). */
function monogram(radius: number): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" width="72" height="72">',
    "  <title>Tiro</title>",
    `  <rect width="72" height="72" rx="${radius}" fill="${OXBLOOD}"/>`,
    `  <path fill="${CREAM}" d="${centred("T", 46, 72, 2)}"/>`,
    "</svg>",
    "",
  ].join("\n");
}

/** The 1200×630 social card: paper, the mark, the wordmark outlined from
 * Spectral, and the tagline in the system CJK sans (rendered by Chrome, so it
 * needs macOS for PingFang SC — the same constraint the old og.png had). */
function socialCard(): string {
  const mark = 160;
  const gap = 28;
  const wordSize = 96;
  const tagSize = 34;
  const word = spectral.getPath("Tiro", 0, 0, wordSize, {
    letterSpacing: -0.015,
  });
  const box = word.getBoundingBox();
  const wordH = box.y2 - box.y1;
  const total = mark + gap + wordH + gap + tagSize;
  const top = (630 - total) / 2;
  const wordTop = top + mark + gap;
  const wordPath = spectral
    .getPath(
      "Tiro",
      600 - (box.x2 - box.x1) / 2 - box.x1,
      wordTop - box.y1,
      wordSize,
      { letterSpacing: -0.015 },
    )
    .toPathData(2);
  const tagBaseline = wordTop + wordH + gap + tagSize * 0.85;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">',
    `  <rect width="1200" height="630" fill="${CREAM}"/>`,
    `  <svg x="${600 - mark / 2}" y="${top}" width="${mark}" height="${mark}" viewBox="0 0 72 72">`,
    `    <rect width="72" height="72" rx="16" fill="${OXBLOOD}"/>`,
    `    <path fill="${CREAM}" d="${centred("T", 46, 72, 2)}"/>`,
    "  </svg>",
    `  <path fill="${INK}" d="${wordPath}"/>`,
    `  <text x="600" y="${tagBaseline}" text-anchor="middle" font-family="-apple-system, 'PingFang SC', 'Hiragino Sans GB', sans-serif" font-size="${tagSize}" fill="${INK_SOFT}">个人稍后读知识库</text>`,
    "</svg>",
    "",
  ].join("\n");
}

const work = mkdtempSync(join(tmpdir(), "tiro-brand-"));

/** Rasterize an SVG at w×h with headless Chrome into public/<name>.png. */
function rasterize(svg: string, name: string, w: number, h: number): string {
  const svgPath = join(work, `${name}.svg`);
  writeFileSync(svgPath, svg);
  const htmlPath = join(work, `${name}.html`);
  writeFileSync(
    htmlPath,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}img{display:block;width:${w}px;height:${h}px}</style><img src="file://${svgPath}" alt="">`,
  );
  const out = join(publicDir, `${name}.png`);
  const run = Bun.spawnSync([
    CHROME,
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    // No --user-data-dir: a throwaway profile makes Chrome write the file and
    // then sit in first-run/updater work until killed.
    "--default-background-color=00000000",
    "--force-device-scale-factor=1",
    `--window-size=${w},${h}`,
    `--screenshot=${out}`,
    `file://${htmlPath}`,
  ]);
  if (run.exitCode !== 0) {
    throw new Error(`chrome exited ${run.exitCode} for ${name}: ${run.stderr}`);
  }
  return out;
}

writeFileSync(join(publicDir, "favicon.svg"), monogram(16));
const favicon32 = rasterize(monogram(16), "favicon-32", 32, 32);
// PNG bytes behind the .ico path: every current browser accepts that, and it
// spares the repo an ico toolchain for the one path browsers request blindly.
copyFileSync(favicon32, join(publicDir, "favicon.ico"));
rasterize(monogram(0), "apple-touch-icon", 180, 180);
rasterize(socialCard(), "og", 1200, 630);
console.log(`brand assets written to ${publicDir} (scratch: ${work})`);
