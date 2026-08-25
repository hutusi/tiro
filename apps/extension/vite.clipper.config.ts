import { resolve } from "node:path";
import { defineConfig } from "vite";

// Pass 2 of 2: the clipper as a single IIFE file. It is injected with
// chrome.scripting.executeScript({files: ["clipper.js"]}), which runs it as a
// classic script — ESM output (Vite's default) would silently break there.
export default defineConfig({
  // Pass 1 already copied public/ (the icons) into dist/. This pass runs with
  // emptyOutDir: false, so letting it copy them again is pure churn.
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, "src/clipper.ts"),
      formats: ["iife"],
      name: "TiroClipper",
      fileName: () => "clipper.js",
    },
  },
});
