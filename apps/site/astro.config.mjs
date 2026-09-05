import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  // The custom domain; the generated *.pages.dev URL also still serves the site.
  site: "https://tiro.ainaive.com",
  output: "static",
  // The tag and category indexes folded into the search page (ADR 0014).
  // Static output renders these as meta-refresh pages; public/_redirects
  // gives Cloudflare Pages the same map as real 301s at the edge.
  redirects: {
    "/tags/": "/search/",
    "/categories/": "/search/",
  },
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
