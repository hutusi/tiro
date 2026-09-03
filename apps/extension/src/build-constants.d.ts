/**
 * Constants substituted by Vite at build time (`define` in vite.config.ts).
 *
 * A global rather than an import because there is nothing to import from: the
 * value is produced by running `git` during the build, and Vite replaces the
 * identifier textually. Ambient, so `tsc --noEmit` — which never runs the
 * build — still typechecks the code that reads it.
 */

/**
 * `git describe` for the commit this was built from, e.g.
 * `ext-v0.11.0-8-gbe3dcc8`, `be3dcc8` when no release tag is reachable, or
 * `…-dirty` from a modified tree. Empty when git could not be asked at all.
 */
declare const __CLIPPER_COMMIT__: string;
