import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { rehypeShiki } from "./highlight.ts";

// GitHub-style sanitization schema, extended with the figure markup that
// clipped articles legitimately carry. Everything else a hostile page could
// smuggle through Readability→Turndown (scripts, event handlers, iframes)
// is stripped — the site is fully public, so raw HTML must never pass
// through unsanitized.
const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "figure", "figcaption"],
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // allowDangerousHtml here only carries raw HTML into the tree, where
  // rehypeRaw parses it and rehypeSanitize scrubs it before stringifying.
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  // Order is load-bearing: Shiki emits a class on the <pre> and an inline
  // style on every token, which the schema above allows on nothing. Running
  // it afterwards keeps the allowlist narrow — the alternative, widening the
  // schema, would hand the same permission to clipped markup (ADR 0009).
  .use(rehypeShiki)
  .use(rehypeStringify);

/**
 * Render one markdown block to sanitized HTML at build time. The processor
 * writes localized image references as exactly "./assets/<file>", so pointing
 * them at the copied public assets is a plain prefix swap (see
 * copy-assets.ts).
 */
export function renderBlockHtml(blockText: string, slug: string): string {
  const withAssets = blockText.replaceAll(
    "./assets/",
    `/vault-assets/${slug}/`,
  );
  return String(processor.processSync(withAssets));
}
