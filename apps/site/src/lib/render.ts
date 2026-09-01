import type { Root } from "hast";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, {
  defaultSchema,
  type Options as SanitizeSchema,
} from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { rehypeShiki } from "./highlight.ts";

// GitHub-style sanitization schema, extended with the figure markup that
// clipped articles legitimately carry. Everything else a hostile page could
// smuggle through Readability→Turndown (scripts, event handlers, iframes)
// is stripped — the site is fully public, so raw HTML must never pass
// through unsanitized.
const schema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "figure", "figcaption"],
  attributes: {
    ...defaultSchema.attributes,
    // remark-math marks its output `language-math math-inline|math-display`,
    // and only `/^language-./` survives the default schema — leaving KaTeX,
    // which runs after the sanitizer, unable to tell an inline formula from a
    // displayed one. Two class markers is the whole widening; no attribute
    // that could carry styling or behaviour is added (ADR 0009).
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
};

/**
 * KaTeX renders whatever a scraped page happened to contain, so it must never
 * be able to fail a build: bad TeX becomes a visibly red `katex-error` span.
 * `unicodeTextInMathMode` is silenced because CJK inside `\text{}` is normal
 * here and would otherwise warn on nearly every translated formula.
 */
const KATEX_OPTIONS = {
  throwOnError: false,
  strict: (code: string) =>
    code === "unicodeTextInMathMode" ? "ignore" : "warn",
};

/**
 * KaTeX renders each formula twice — MathML for screen readers and styled
 * HTML for everyone else — and the MathML also carries the LaTeX source in an
 * `<annotation>`. Pagefind sees all of it, so a single formula lands in the
 * index three times, once as `\mathrm{softmax}(qK^\top)` gibberish. Hiding
 * the MathML half leaves exactly what a reader sees on the page.
 */
function rehypeIgnoreMathmlInSearch() {
  return (tree: Root): void => {
    visit(tree, "element", (node) => {
      const classes = node.properties?.className;
      if (Array.isArray(classes) && classes.includes("katex-mathml")) {
        node.properties["data-pagefind-ignore"] = "all";
        return "skip";
      }
      return undefined;
    });
  };
}

/**
 * `singleDollarTextMath` is the only difference between the two processors.
 * With it on, `$` is a math delimiter everywhere and "it costs $5 to $10"
 * renders as a formula — so it is enabled only for articles the clipper
 * flagged as containing real math. `$$…$$` is unambiguous and stays on for
 * everything, including articles clipped before math support existed.
 */
function buildProcessor(singleDollarTextMath: boolean) {
  return (
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMath, { singleDollarTextMath })
      // allowDangerousHtml here only carries raw HTML into the tree, where
      // rehypeRaw parses it and rehypeSanitize scrubs it before stringifying.
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
      .use(rehypeSanitize, schema)
      // Order is load-bearing: Shiki and KaTeX emit classes and inline styles
      // the schema above allows on nothing. Running them afterwards keeps the
      // allowlist narrow — widening it instead would hand the same permission
      // to clipped markup (ADR 0009).
      .use(rehypeShiki)
      .use(rehypeKatex, KATEX_OPTIONS)
      .use(rehypeIgnoreMathmlInSearch)
      .use(rehypeStringify)
      .freeze()
  );
}

const proseProcessor = buildProcessor(false);
const mathProcessor = buildProcessor(true);

export interface RenderOptions {
  /** Read `$…$` as inline math — frontmatter `has_math` (ADR 0009). */
  inlineMath?: boolean;
}

/**
 * Render one markdown block to sanitized HTML at build time. The processor
 * writes localized image references as exactly "./assets/<file>", so pointing
 * them at the copied public assets is a plain prefix swap (see
 * copy-assets.ts).
 */
export function renderBlockHtml(
  blockText: string,
  slug: string,
  options: RenderOptions = {},
): string {
  const withAssets = blockText.replaceAll(
    "./assets/",
    `/vault-assets/${slug}/`,
  );
  const processor =
    options.inlineMath === true ? mathProcessor : proseProcessor;
  return String(processor.processSync(withAssets));
}
