import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeStringify, { allowDangerousHtml: true });

/**
 * Render one markdown block to HTML at build time. The processor writes
 * localized image references as exactly "./assets/<file>", so pointing them
 * at the copied public assets is a plain prefix swap (see copy-assets.ts).
 */
export function renderBlockHtml(
  blockText: string,
  year: string,
  slug: string,
): string {
  const withAssets = blockText.replaceAll(
    "./assets/",
    `/vault-assets/${year}/${slug}/`,
  );
  return String(processor.processSync(withAssets));
}
