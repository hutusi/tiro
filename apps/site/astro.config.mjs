import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  // The custom domain; the generated *.pages.dev URL also still serves the site.
  site: "https://tiro.ainaive.com",
  output: "static",
  vite: {
    plugins: [tailwindcss()],
  },
});
