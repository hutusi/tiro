#!/usr/bin/env bun
/**
 * Regenerate the site's brand assets — run `bun run brand` in apps/site after
 * changing the mark. brand/README.md says what each file is for.
 *
 * The mark is the two-bar tile of ADR 0018 — a cream rounded square carrying
 * an ink bar and an oxblood bar, the same pair the site header sets beside the
 * wordmark. It supersedes the oxblood "T" monogram of ADR 0014.
 *
 * Spectral is still parsed here, but only for the social card's wordmark: it
 * is outlined from the webfont into a <path> because these files are drawn
 * without webfonts, and a system-serif fallback would change the letterforms.
 * The mark itself is rectangles and needs no font.
 *
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
import { basename, join, resolve } from "node:path";
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

/** The design's tile radius on the 64-unit canvas. The same proportion the
 * oxblood badge used at 16/72, so the silhouette in a tab strip is unchanged. */
const TILE_RADIUS = 14;

/**
 * The two-bar mark on a 64-unit canvas — the design project's own
 * `favicon.svg`, copied rather than re-derived: bars 12 wide and 36 tall, 8
 * apart, centred both ways (16 of margin to either side, 14 above and below).
 *
 * `radius` is `TILE_RADIUS` for the badge and 0 for the full-bleed square iOS
 * wants — it applies its own corner mask, and transparent corners would come
 * out black.
 *
 * This replaces the oxblood "T" monogram (ADR 0018). Two things that mattered
 * for the monogram no longer apply: the glyph had to be outlined from Spectral
 * with opentype.js because browsers draw SVG favicons without webfonts, and it
 * needed a 2px optical lift to sit right in the square. Rectangles need
 * neither, which is why `centred()` and `monogram()` are gone — `git log` has
 * them if the reasoning is ever wanted.
 */
function barsTile(radius: number): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">',
    "  <title>Tiro</title>",
    `  <rect width="64" height="64" rx="${radius}" fill="${CREAM}"/>`,
    `  <rect x="16" y="14" width="12" height="36" rx="2.5" fill="${INK}"/>`,
    `  <rect x="36" y="14" width="12" height="36" rx="2.5" fill="${OXBLOOD}"/>`,
    "</svg>",
    "",
  ].join("\n");
}

/** The 1200×630 social card: paper, the mark, the wordmark outlined from
 * Spectral, and the tagline in the system CJK sans (rendered by Chrome, so it
 * needs macOS for PingFang SC — the same constraint the old og.png had). */
function socialCard(): string {
  const gap = 28;
  const wordSize = 96;
  const tagSize = 34;

  // The card's paper is CREAM, so the tile the favicon uses would be invisible
  // here — this draws the *inline* lockup instead, which is the same one the
  // site header and footer carry. Proportions are the design's large logo cell:
  // 10x40 bars, 6 apart, 14 clear of a 52px wordmark.
  const barW = Math.round(wordSize * (10 / 52));
  const barH = Math.round(wordSize * (40 / 52));
  const barGap = Math.round(wordSize * (6 / 52));
  const lockGap = Math.round(wordSize * (14 / 52));
  const barsW = barW * 2 + barGap;

  const box = spectral
    .getPath("Tiro", 0, 0, wordSize, { letterSpacing: -0.015 })
    .getBoundingBox();
  const wordW = box.x2 - box.x1;
  const wordH = box.y2 - box.y1;

  // Bars and wordmark share a baseline, the way they do in the header; the
  // lockup is as tall as whichever reaches higher above it.
  const lockH = Math.max(barH, wordH);
  const total = lockH + gap + tagSize;
  const top = (630 - total) / 2;
  const baseline = top + lockH;
  const lockLeft = 600 - (barsW + lockGap + wordW) / 2;

  const wordPath = spectral
    .getPath("Tiro", lockLeft + barsW + lockGap - box.x1, baseline, wordSize, {
      letterSpacing: -0.015,
    })
    .toPathData(2);
  const tagBaseline = baseline + gap + tagSize * 0.85;
  const barR = barW * 0.2;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">',
    `  <rect width="1200" height="630" fill="${CREAM}"/>`,
    `  <rect x="${lockLeft}" y="${baseline - barH}" width="${barW}" height="${barH}" rx="${barR}" fill="${INK}"/>`,
    `  <rect x="${lockLeft + barW + barGap}" y="${baseline - barH}" width="${barW}" height="${barH}" rx="${barR}" fill="${OXBLOOD}"/>`,
    `  <path fill="${INK}" d="${wordPath}"/>`,
    `  <text x="600" y="${tagBaseline}" text-anchor="middle" font-family="-apple-system, 'PingFang SC', 'Hiragino Sans GB', sans-serif" font-size="${tagSize}" fill="${INK_SOFT}">个人稍后读知识库</text>`,
    "</svg>",
    "",
  ].join("\n");
}

const work = mkdtempSync(join(tmpdir(), "tiro-brand-"));

/**
 * Rasterize an SVG with headless Chrome into `out` (a .png path), `w`×`h`.
 * By default the drawing fills the canvas. `artwork` instead draws it at
 * that many px square, centred on a transparent canvas — Chrome's Web Store
 * listing guidance wants 96 px of icon inside the 128 px file, while the
 * toolbar sizes stay full-bleed. (A default of `w` here once made the
 * 1200×630 social card a 1200×1200 image, cropped to its top 630 px.)
 */
function rasterize(
  svg: string,
  out: string,
  w: number,
  h: number,
  artwork?: number,
): string {
  const name = basename(out, ".png");
  const svgPath = join(work, `${name}.svg`);
  writeFileSync(svgPath, svg);
  const htmlPath = join(work, `${name}.html`);
  const img =
    artwork === undefined
      ? `width:${w}px;height:${h}px`
      : `width:${artwork}px;height:${artwork}px;margin:${(h - artwork) / 2}px ${(w - artwork) / 2}px`;
  writeFileSync(
    htmlPath,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}img{display:block;${img}}</style><img src="file://${svgPath}" alt="">`,
  );
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

writeFileSync(join(publicDir, "favicon.svg"), barsTile(TILE_RADIUS));
const favicon32 = rasterize(
  barsTile(TILE_RADIUS),
  join(publicDir, "favicon-32.png"),
  32,
  32,
);
// PNG bytes behind the .ico path: every current browser accepts that, and it
// spares the repo an ico toolchain for the one path browsers request blindly.
copyFileSync(favicon32, join(publicDir, "favicon.ico"));
rasterize(barsTile(0), join(publicDir, "apple-touch-icon.png"), 180, 180);
rasterize(socialCard(), join(publicDir, "og.png"), 1200, 630);

// The extension's toolbar and store icons are the same mark, written from
// here so the two cannot drift (ADR 0015). 16/32/48 are full-bleed; the 128
// carries 16 px of transparent padding around 96 px of artwork, which is
// what Chrome's listing guidance asks for.
const extension = resolve(site, "../extension");
writeFileSync(
  join(extension, "icons/icon.svg"),
  barsTile(TILE_RADIUS).replace(
    "<title>Tiro</title>",
    "<title>Tiro Clipper</title>",
  ),
);
for (const size of [16, 32, 48]) {
  rasterize(
    barsTile(TILE_RADIUS),
    join(extension, `public/icons/icon-${size}.png`),
    size,
    size,
  );
}
rasterize(
  barsTile(TILE_RADIUS),
  join(extension, "public/icons/icon-128.png"),
  128,
  128,
  96,
);
console.log(
  `brand assets written to ${publicDir} and ${join(extension, "public/icons")} (scratch: ${work})`,
);
