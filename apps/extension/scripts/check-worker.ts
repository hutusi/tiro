/**
 * Load the built service worker the way Chrome does — as a module, with no
 * DOM — and fail the build if it throws.
 *
 * A worker that throws while loading never registers: Chrome shows "Errors"
 * on the extension card, and everything the worker does (settings-sync
 * mirroring, collection saves) silently stops. Unit tests cannot see it,
 * because the failure lives in the *bundle*: a dependency's browser build
 * touched `document` at load, while Bun resolves its DOM-free build. So this
 * checks `dist/`, after Vite, as part of `build`. See `@tiro/shared/documents`.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const listener = { addListener() {} };
(globalThis as { chrome?: unknown }).chrome = {
  runtime: { id: "check", onMessage: listener, onConnect: listener },
  storage: { onChanged: listener, local: {}, sync: {} },
};
// Exactly what a worker lacks. It *has* `navigator` (a WorkerNavigator) and
// `self`, and zod reads `navigator` while loading, so forbidding more than this
// would fail builds that Chrome loads fine.
for (const name of ["document", "window", "localStorage"]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new ReferenceError(
        `${name} is not defined — a service worker has no DOM`,
      );
    },
  });
}

const worker = resolve(import.meta.dirname, "../dist/background.js");
try {
  await import(pathToFileURL(worker).href);
} catch (error) {
  console.error(
    `dist/background.js throws while loading, so Chrome would never register it:\n${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }`,
  );
  process.exit(1);
}
console.log("service worker loads without a DOM");
