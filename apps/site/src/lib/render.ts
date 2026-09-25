import { normalizeBlockMath } from "@tiro/shared";
import type { ElementContent, Root } from "hast";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, {
  defaultSchema,
  type Options as SanitizeSchema,
} from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { rehypeShiki } from "./highlight.ts";

// GitHub-style sanitization schema. Everything a hostile page could smuggle
// through Readability→Turndown (scripts, event handlers, iframes) is stripped
// — the site is fully public, so raw HTML must never pass through
// unsanitized. `figure`/`figcaption` are deliberately *not* allowed: the only
// figures on this site are the ones `rehypeFigureCaptions` builds below, after
// this step, so clipped markup never needs the permission (ADR 0009, 0011).
const schema: SanitizeSchema = {
  ...defaultSchema,
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
 * Give every table its own horizontal scroll box.
 *
 * Tailwind typography sizes tables `width: 100%; table-layout: auto`, which
 * only holds while the content fits: a table whose minimum content width
 * exceeds the column renders wider than its pane and — the pane being
 * `overflow: visible` — paints over the neighbouring column. Code blocks never
 * had this problem because typography ships `pre { overflow-x: auto }`; tables
 * get no such guard. An 11-column arXiv results table overflowed its pane by
 * 439px.
 *
 * Must run **after** rehype-sanitize, for the same reason Shiki does (ADR
 * 0009): the wrapper carries a `class`, which the schema allows on nothing.
 * Emitting it here keeps the allowlist narrow instead of granting clipped
 * markup the same permission.
 */
function rehypeScrollableTables() {
  return (tree: Root): void => {
    visit(tree, "element", (node, index, parent) => {
      if (
        node.tagName !== "table" ||
        parent === undefined ||
        index === undefined
      )
        return undefined;
      parent.children[index] = {
        type: "element",
        tagName: "div",
        properties: { className: ["table-scroll"] },
        children: [node],
      };
      return "skip";
    });
  };
}

/** A text node that is nothing but whitespace. */
function isBlank(node: ElementContent): boolean {
  return node.type === "text" && node.value.trim() === "";
}

/** `<br>`, the separator the clipper writes between an image and its caption. */
function isBreak(node: ElementContent): boolean {
  return node.type === "element" && node.tagName === "br";
}

/**
 * An image, or the link wrapping one — what a figure's picture looks like.
 *
 * The clipper's `pictureOf` in `apps/extension/src/dom-prepare.ts` draws this
 * same line and declines to fold anything this would not accept. Loosening it
 * here without loosening that would caption ordinary prose: a paragraph opening
 * with an icon link — `[![icon](i.png) Read more](url) and then prose.` — is
 * exactly the shape a laxer rule would misread as a figure.
 */
function isPicture(node: ElementContent): boolean {
  if (node.type !== "element") return false;
  if (node.tagName === "img") return true;
  if (node.tagName !== "a") return false;
  const meaningful = node.children.filter((child) => !isBlank(child));
  const [only] = meaningful;
  return (
    meaningful.length === 1 &&
    only?.type === "element" &&
    only.tagName === "img"
  );
}

/**
 * Render a paragraph that opens with an image and continues with prose as a
 * `<figure>` with a `<figcaption>`.
 *
 * This is the reading half of ADR 0011. The clipper folds a caption into its
 * image's paragraph because co-location is the only association markdown can
 * express; here that co-location becomes the markup that says so. Both panes
 * go through this, so a translated caption is a caption too.
 *
 * A paragraph of nothing but pictures stays a plain image — that is an
 * uncaptioned figure, and `isImageOnlyParagraph` in `@tiro/shared` draws the
 * same line for the clipper and `repair`.
 *
 * Must run **after** rehype-sanitize, for the reason Shiki and the table
 * wrapper do (ADR 0009): it generates its own markup, so emitting it here
 * keeps `figure` and `figcaption` out of the allowlist entirely rather than
 * granting clipped markup the same permission.
 */
function rehypeFigureCaptions() {
  return (tree: Root): void => {
    visit(tree, "element", (node, index, parent) => {
      if (node.tagName !== "p" || parent === undefined || index === undefined)
        return undefined;
      const [picture, ...rest] = node.children;
      if (picture === undefined || !isPicture(picture)) return undefined;
      // Drop the separator between image and caption, but only the leading
      // run of it: whitespace further in belongs to the caption.
      let start = 0;
      while (start < rest.length) {
        const node = rest[start];
        if (node === undefined || !(isBlank(node) || isBreak(node))) break;
        start += 1;
      }
      const caption = rest.slice(start);
      // The newline that separated image from caption in the source survives
      // inside the first text node, where it would render as leading space.
      const [head] = caption;
      if (head?.type === "text") {
        caption[0] = { ...head, value: head.value.replace(/^\s+/, "") };
      }
      const tailIndex = caption.length - 1;
      const tail = caption[tailIndex];
      if (tail?.type === "text") {
        caption[tailIndex] = { ...tail, value: tail.value.replace(/\s+$/, "") };
      }
      // Nothing but more pictures is an image paragraph, not a figure.
      if (
        caption.length === 0 ||
        caption.every(
          (child) => isBlank(child) || isBreak(child) || isPicture(child),
        )
      )
        return undefined;
      parent.children[index] = {
        type: "element",
        tagName: "figure",
        properties: {},
        children: [
          picture,
          {
            type: "element",
            tagName: "figcaption",
            properties: {},
            children: caption,
          },
        ],
      };
      return "skip";
    });
  };
}

/** Which of the reader's two columns a block is being rendered into. */
export type Pane = "original" | "translation";

/**
 * Both panes render into one document — `[slug].astro` emits `.pane-original`
 * and `.pane-translation` side by side in every row, and the stacked view emits
 * two whole lists — so an id from `index.md` and the same id from `zh.md` would
 * collide, and a jump would land in whichever came first. Scoping ids to their
 * pane, and the links that point at them with them, keeps each column's
 * navigation inside itself.
 */
const PANE_PREFIX: Record<Pane, string> = {
  original: "tiro-o-",
  translation: "tiro-t-",
};

/**
 * What the sanitizer renamed, and what it renamed them with — read off the
 * schema rather than written out again, so this cannot drift from what actually
 * happened to the tree. `clobber` is `id`, `name` and the two aria references;
 * taking the whole list is what keeps an `aria-labelledby` pointing at its
 * label once both have moved.
 */
const CLOBBERED: readonly string[] = schema.clobber ?? [];
const CLOBBER_PREFIX: string = schema.clobberPrefix ?? "";

/**
 * Scope a block's anchors and in-document links to one pane.
 *
 * Two halves of one rule, and both are needed: the sanitizer clobbers `id` to
 * `user-content-…` to stop a page-chosen id shadowing a DOM property, and
 * leaves `href="#…"` alone — so before this ran, a clipped article's every
 * in-document link pointed at an id that no longer spelled that way.
 *
 * The clobber prefix is *replaced* rather than stacked on. Any non-empty prefix
 * satisfies what the clobber is for, `#tiro-o-fn:1` is a fragment a reader can
 * look at where `#tiro-o-user-content-fn:1` is not, and stripping exactly one
 * occurrence is also right for a GitHub-clipped article whose author ids
 * genuinely begin `user-content-`.
 */
function rehypeScopeAnchors(pane: Pane) {
  const prefix = PANE_PREFIX[pane];
  return (tree: Root): void => {
    visit(tree, "element", (node) => {
      const properties = node.properties;
      if (properties === undefined) return;
      for (const name of CLOBBERED) {
        const value = properties[name];
        // `aria-labelledby` and `aria-describedby` are space-separated lists of
        // ids, so hast parses them as arrays — and the sanitizer clobbers every
        // entry. Skipping a non-string here moved the id and left the reference
        // pointing at the old spelling: remark-gfm's own footnotes carry
        // `aria-describedby="user-content-footnote-label"` against a heading
        // this pass had already renamed, which is a screen reader losing the
        // label rather than anything visible.
        if (typeof value === "string") {
          properties[name] = prefix + stripOnce(value, CLOBBER_PREFIX);
        } else if (Array.isArray(value)) {
          properties[name] = value.map((entry) =>
            typeof entry === "string"
              ? prefix + stripOnce(entry, CLOBBER_PREFIX)
              : entry,
          );
        }
      }
      if (node.tagName !== "a") return;
      const href = properties.href;
      // A bare "#" addresses the top of the page rather than an id, and an
      // absolute URL that happens to carry a fragment points at the source
      // page, where the target really does live.
      if (typeof href !== "string" || !href.startsWith("#") || href === "#") {
        return;
      }
      // Verbatim, no decoding: the prefix holds nothing encodable, so a
      // percent-escaped fragment survives and still matches the id, which was
      // written from the same bytes.
      properties.href = `#${prefix}${href.slice(1)}`;
    });
  };
}

/**
 * Record every id in the finished tree.
 *
 * Runs *last*, after the markup generators, because they rewrite what the
 * earlier passes produced: KaTeX replaces a `<code class="language-math">`
 * outright, so an id on it is scoped by the pass above and then deleted, and
 * reporting it would give the title block a target the page does not have.
 * Collecting at the end is the only position where "what this block emits" is
 * a settled question — which is the whole reason the ids are read from the
 * renderer rather than from the source.
 */
function rehypeCollectAnchorIds() {
  return (tree: Root, file: { data: Record<string, unknown> }): void => {
    const anchorIds: string[] = [];
    visit(tree, "element", (node) => {
      const id = node.properties?.id;
      if (typeof id === "string") anchorIds.push(id);
    });
    file.data.anchorIds = anchorIds;
  };
}

function stripOnce(value: string, prefix: string): string {
  return prefix !== "" && value.startsWith(prefix)
    ? value.slice(prefix.length)
    : value;
}

/**
 * Parse through sanitize: the front half every processor here shares — the
 * renderer below, and `renderedImageSources`, which must see exactly the
 * images a page would.
 *
 * `singleDollarTextMath` is the only difference between the math and prose
 * variants.
 * With it on, `$` is a math delimiter everywhere and "it costs $5 to $10"
 * renders as a formula — so it is enabled only for articles the clipper
 * flagged as containing real math. `$$…$$` is unambiguous and stays on for
 * everything, including articles clipped before math support existed.
 */
function sanitizedTree(singleDollarTextMath: boolean) {
  return (
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      // The proposed CommonMark amendment for CJK, and the one place a
      // translation needs it: strict CommonMark will not close `**事实上，**`,
      // because `，` is punctuation and the closing run is therefore not
      // flanking, so the asterisks stay on the page. No delimiter can express
      // that span — `*事实上，*` fails identically — which is why it is fixed
      // here and not in the content, unlike the `_` that the clipper used to
      // write (`normalizeCjkEmphasis` in `@tiro/shared`). Output is unchanged
      // for any input without CJK, and `@tiro/shared` parses with it too, so
      // the contract reads an article the way this renders it.
      .use(remarkCjkFriendly)
      .use(remarkMath, { singleDollarTextMath })
      // allowDangerousHtml here only carries raw HTML into the tree, where
      // rehypeRaw parses it and rehypeSanitize scrubs it before stringifying.
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
      .use(rehypeSanitize, schema)
  );
}

function buildProcessor(singleDollarTextMath: boolean, pane: Pane) {
  return (
    sanitizedTree(singleDollarTextMath)
      // After the sanitizer because it has to see the *clobbered* id to
      // reconcile it with the link that points at it, and before the
      // generators because it may only ever touch clipped markup — Shiki and
      // KaTeX emit no ids today, and keeping this upstream of them makes that
      // a structural guarantee rather than a fact about their current config.
      .use(rehypeScopeAnchors, pane)
      // Order is load-bearing: Shiki and KaTeX emit classes and inline styles
      // the schema above allows on nothing. Running them afterwards keeps the
      // allowlist narrow — widening it instead would hand the same permission
      // to clipped markup (ADR 0009).
      .use(rehypeShiki)
      .use(rehypeScrollableTables)
      .use(rehypeFigureCaptions)
      .use(rehypeKatex, KATEX_OPTIONS)
      .use(rehypeIgnoreMathmlInSearch)
      // Last, so what it records is what gets stringified — the generators
      // above rewrite elements, and an id on one they replace is gone.
      .use(rehypeCollectAnchorIds)
      .use(rehypeStringify)
      .freeze()
  );
}

// Four rather than two, because the pane cannot be a per-call option: these are
// frozen at module scope. It costs nothing — the Shiki highlighter they share is
// a module-level singleton, so this builds no second set of grammars.
const proseOriginal = buildProcessor(false, "original");
const proseTranslation = buildProcessor(false, "translation");
const mathOriginal = buildProcessor(true, "original");
const mathTranslation = buildProcessor(true, "translation");

function processorFor(inlineMath: boolean, pane: Pane) {
  if (inlineMath) {
    return pane === "original" ? mathOriginal : mathTranslation;
  }
  return pane === "original" ? proseOriginal : proseTranslation;
}

export interface RenderOptions {
  /** Read `$…$` as inline math — frontmatter `has_math` (ADR 0009). */
  inlineMath?: boolean;
  /** Which column this block lands in. Ids and in-document links are scoped to
   * it, because both panes share one document. Defaults to the original, which
   * is what a single-pane article is. */
  pane?: Pane;
}

// Parse and sanitize only: no Shiki, no KaTeX, nothing stringified. The front
// half the renderer runs, so what it finds is what a page would show.
const treeProse = sanitizedTree(false).freeze();
const treeMath = sanitizedTree(true).freeze();

/**
 * The `src` of every image a body renders, in document order, with local
 * references already pointing at the published copies (`/vault-assets/…`).
 *
 * Read off the sanitized tree rather than the markdown source: that is what
 * catches an `<img>` in raw HTML (the processor localizes those too), an alt
 * text holding brackets, and a reference quoted inside a code block, which
 * renders as text and is no image at all. A regex over the source gets all
 * three wrong.
 */
export function renderedImageSources(
  body: string,
  slug: string,
  options: Pick<RenderOptions, "inlineMath"> = {},
): string[] {
  const processor = options.inlineMath === true ? treeMath : treeProse;
  const tree = processor.runSync(
    processor.parse(localizeAssets(body, slug)),
  ) as Root;
  const sources: string[] = [];
  visit(tree, "element", (node) => {
    const src = node.properties?.src;
    if (node.tagName === "img" && typeof src === "string") sources.push(src);
  });
  return sources;
}

function localizeAssets(text: string, slug: string): string {
  return text.replaceAll("./assets/", `/vault-assets/${slug}/`);
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
  return renderBlock(blockText, slug, options).html;
}

/** One rendered block and the ids it emits, which only the title block needs
 * (ADR 0024) — every other caller wants the HTML and takes `renderBlockHtml`. */
export function renderBlock(
  blockText: string,
  slug: string,
  options: RenderOptions = {},
): { html: string; anchorIds: string[] } {
  const withAssets = localizeAssets(normalizeBlockMath(blockText), slug);
  const processor = processorFor(
    options.inlineMath === true,
    options.pane ?? "original",
  );
  const file = processor.processSync(withAssets);
  const ids = (file.data as { anchorIds?: string[] }).anchorIds;
  return { html: String(file), anchorIds: ids ?? [] };
}
