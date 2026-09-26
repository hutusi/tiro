import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { isSitemapEligible } from "./src/lib/unlisted-slugs.ts";
import { vaultWatcher } from "./src/lib/vault-watch.ts";

export default defineConfig({
  // The custom domain; the generated *.pages.dev URL also still serves the site.
  site: "https://tiro.ainaive.com",
  output: "static",
  // The tag index folded into the search page (ADR 0014); the category index
  // has no page since ADR 0031, so its old URL goes home. Plus the shortcut to
  // the one collection every vault has. Static output renders
  // these as meta-refresh pages; public/_redirects gives Cloudflare Pages the
  // same map as real 301s at the edge.
  redirects: {
    "/tags/": "/search/",
    "/categories/": "/",
    "/favorites/": "/collections/favorites/",
  },
  // An unlisted article is still built and still reachable; the sitemap is
  // where it would otherwise be handed to every crawler. The reader also sends
  // `noindex` for one — robots.txt deliberately says nothing, since that file
  // is public and would publish the list being hidden.
  integrations: [sitemap({ filter: isSitemapEligible }), vaultWatcher()],
  vite: {
    plugins: [tailwindcss()],
  },
});
