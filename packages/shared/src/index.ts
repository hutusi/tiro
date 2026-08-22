/**
 * @tiro/shared — the content contract shared by the extension, the processor,
 * and the site. Only browser-safe modules may be re-exported from this root
 * entry; anything touching `node:` APIs must be exposed via a subpath export.
 */
export const TIRO_SCHEMA_VERSION = 1;
