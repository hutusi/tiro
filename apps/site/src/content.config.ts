import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { vaultDir } from "./lib/vault.ts";

const articlesBase = `${vaultDir()}/articles`;

// No Astro-side schema: frontmatter is validated by the shared Zod contract
// in lib/articles.ts (Astro bundles its own zod version; passing our zod 4
// schemas across that boundary is not worth the coupling).
const articles = defineCollection({
  loader: glob({
    pattern: "*/index.md",
    base: articlesBase,
    generateId: ({ entry }) => entry.replace(/\/index\.md$/, ""),
  }),
});

const translations = defineCollection({
  loader: glob({
    pattern: "*/zh.md",
    base: articlesBase,
    generateId: ({ entry }) => entry.replace(/\/zh\.md$/, ""),
  }),
});

export const collections = { articles, translations };
