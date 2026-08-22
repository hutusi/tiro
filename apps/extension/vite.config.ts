import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Pass 1 of 2: popup, options, and the service worker as a normal ESM build.
// The clipper is built separately as an IIFE (see vite.clipper.config.ts and
// ADR 0005) because executeScript-injected files are classic scripts.
export default defineConfig({
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
});
