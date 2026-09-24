/**
 * @tiro/shared/documents — the vault's document layer and nothing else:
 * frontmatter, collections, paths and slugs.
 *
 * A subpath rather than only the root export because the root is
 * browser-safe, not *worker*-safe. It re-exports the block splitter, which
 * pulls in remark, and remark's entity decoder in its browser build calls
 * `document.createElement` when it loads. A service worker has no `document`,
 * so the extension's worker died on registration the moment it imported the
 * root for the collection flush — while every unit test passed, because Bun
 * resolves that decoder's DOM-free build. Nothing here parses markdown, so
 * nothing here needs a DOM. The extension build checks the bundled worker
 * loads without one (`apps/extension/scripts/check-worker.ts`).
 */
export * from "./collections.ts";
export * from "./frontmatter.ts";
export * from "./paths.ts";
export * from "./slug.ts";
