import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * `git describe` for the commit being built, recorded into every article as
 * `tiro.clipper_commit`.
 *
 * `--match "ext-v*"` because the repo carries two tag lines: the extension's
 * `ext-v*` and the repo's own `v*`. Without it `describe` picks whichever is
 * nearest, so a clip could claim to come from `v0.3.0-…`, naming a release of
 * something else entirely.
 *
 * `--always` is what makes this safe in CI, where `actions/checkout` fetches a
 * single commit with no tag history: rather than failing with "no names found"
 * it degrades to a bare commit, which is still the answer the field is for.
 *
 * Any failure yields "" — git missing, not a checkout, a source zip — and an
 * empty value omits the field rather than recording a blank one. A build must
 * never fail over provenance metadata.
 */
function clipperCommit(): string {
  try {
    return execFileSync(
      "git",
      ["describe", "--tags", "--always", "--dirty", "--match", "ext-v*"],
      {
        cwd: import.meta.dirname,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    return "";
  }
}

// Pass 1 of 2: popup, options, and the service worker as a normal ESM build.
// The clipper is built separately as an IIFE (see vite.clipper.config.ts and
// ADR 0005) because executeScript-injected files are classic scripts.
export default defineConfig(({ mode }) => ({
  // Only this pass needs them: both are read in popup.ts, and the clipper
  // IIFE (pass 2) never touches them. `__DEV_FIXTURES__` is true only for
  // `bun run build:dev`, where `popup.html?state=<name>` paints a canned
  // state for eyeballing; a production build replaces it with `false` and
  // Rollup drops the fixtures module with the dead branch.
  define: {
    __CLIPPER_COMMIT__: JSON.stringify(clipperCommit()),
    __DEV_FIXTURES__: JSON.stringify(mode !== "production"),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, "src/popup/popup.html"),
        options: resolve(import.meta.dirname, "src/options/options.html"),
        background: resolve(import.meta.dirname, "src/background.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background"
            ? "background.js"
            : "assets/[name]-[hash].js",
      },
    },
  },
  plugins: [
    {
      name: "tiro-copy-manifest",
      closeBundle() {
        copyFileSync(
          resolve(import.meta.dirname, "manifest.json"),
          resolve(import.meta.dirname, "dist/manifest.json"),
        );
      },
    },
  ],
}));
