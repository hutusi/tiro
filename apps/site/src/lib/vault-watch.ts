import type { AstroIntegration } from "astro";
import { vaultDir } from "./vault.ts";

/**
 * Reload the dev server when the vault changes.
 *
 * Astro's content layer gave this for free, and dropping it (ADR 0020) would
 * otherwise have cost it — measured before the change: editing an article's
 * body showed up in the browser about four seconds later, with no restart.
 * That is how the vault gets previewed, so it is bought back explicitly here
 * rather than quietly lost.
 *
 * Dev only. A build reads the vault once and exits.
 */
export function vaultWatcher(): AstroIntegration {
  return {
    name: "tiro-vault-watcher",
    hooks: {
      "astro:server:setup": ({ server, logger }) => {
        const dir = vaultDir();
        server.watcher.add(dir);
        const reload = (path: string) => {
          if (!path.startsWith(dir)) return;
          // Only nudges the browser. Staleness is the reader's own problem —
          // it revalidates against the vault's mtimes in dev — because this
          // hook runs in the config's module graph, not the SSR one, so a
          // cache cleared from here would be a different module's cache.
          logger.info(`vault changed: ${path.slice(dir.length + 1)}`);
          // Clearing the reader's memo is not enough on its own: the routes are
          // built from `getStaticPaths`, whose results Astro caches per route
          // in dev, so the page would re-render the articles it was handed the
          // first time. Dropping the SSR modules makes it ask again.
          const withGraph = server as unknown as {
            environments?: {
              ssr?: { moduleGraph?: { invalidateAll?: () => void } };
            };
            moduleGraph?: { invalidateAll?: () => void };
          };
          // Vite moved the module graph under `environments` in v6.
          const graph =
            withGraph.environments?.ssr?.moduleGraph ?? withGraph.moduleGraph;
          graph?.invalidateAll?.();
          server.ws.send({ type: "full-reload", path: "*" });
        };
        server.watcher.on("add", reload);
        server.watcher.on("change", reload);
        server.watcher.on("unlink", reload);
      },
    },
  };
}
