/**
 * @tiro/clip — turning a page into the Markdown Tiro stores (ADR 0034).
 *
 * Moved out of the extension so the processor can run the same code on a page
 * it fetched itself, the way `sweep` already did. It needs a DOM — the
 * extension's tab or popup, or happy-dom under Bun — and nothing else from its
 * host: no `chrome.*`, no network of its own beyond an injected `FetchLike`.
 * Bundled into the injected clipper, so it stays a plain ES module the IIFE
 * build can inline.
 */
export * from "./arxiv.ts";
export * from "./clip-page.ts";
export * from "./dom-prepare.ts";
export type { FetchLike } from "./fetch-like.ts";
export * from "./github-doc.ts";
export * from "./html-urls.ts";
export * from "./markdown.ts";
export type { ClipPayload } from "./payload.ts";
export * from "./plain-markdown.ts";
