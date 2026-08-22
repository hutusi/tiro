# ADR 0005: Extension built with plain Vite in two passes; on-demand injection

Status: accepted (2026-08)

## Context

The Chrome MV3 extension needs a bundler for popup, options, service worker,
and the clipper script (Readability + Turndown) that runs inside the page.
CRXJS (`@crxjs/vite-plugin` 2.x) is the popular manifest-driven option; its
main value is content-script HMR and manifest wiring.

## Decision

- **No declared content script.** The extension uses `activeTab` +
  `scripting` and injects the clipper on demand via
  `chrome.scripting.executeScript({files: ["clipper.js"]})` when the popup is
  opened. Results come back over `chrome.runtime.sendMessage` (the return
  value of file-based injection is not reliable).
- **Plain Vite, two build passes** (no CRXJS):
  1. popup/options/service-worker as a normal multi-entry ESM build
     (`background.type: "module"` in the manifest), static `manifest.json`
     copied to `dist/`;
  2. `clipper.ts` as a separate **IIFE** library build into the same
     `dist/` (`emptyOutDir: false`). Injected files are classic scripts —
     Vite's default ESM chunking would break them, which is the trap the
     second pass avoids.

## Consequences

- ~50 lines of config, no plugin dependency risk, fully understood output.
- No HMR; acceptable for a two-page tool (load unpacked from `dist/`).
- Revisit CRXJS if the extension grows declared content scripts or complex
  page UI.
