import { describe, expect, test } from "bun:test";
import { PULL_QUOTE_MARK } from "@tiro/shared";
import { renderBlockHtml } from "../src/lib/render.ts";

const LINE = "I had a family, a career — and then I had a slave.";

/** ADR 0041: a pull quote renders as an aside, not as a quotation. */
describe("a pull quote", () => {
  test("renders as an aside", () => {
    const html = renderBlockHtml(`> ${PULL_QUOTE_MARK}\n> ${LINE}`, "s");
    expect(html).toContain('<aside class="pull-quote">');
    expect(html).toContain(`<p>${LINE}</p>`);
    expect(html).not.toContain("<blockquote>");
    expect(html).not.toContain("pull quote -->");
  });

  test("a quotation stays a blockquote", () => {
    const html = renderBlockHtml(`> ${LINE}`, "s");
    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("pull-quote");
  });

  test("the caller's answer wins over the block's own mark", () => {
    // How the reader hands the original's verdict to a translation that lost
    // the mark, or kept one the original does not have.
    expect(
      renderBlockHtml("> 我曾有一个家庭。", "s", { pullQuote: true }),
    ).toContain('<aside class="pull-quote"');
    expect(
      renderBlockHtml(`> ${PULL_QUOTE_MARK}\n> ${LINE}`, "s", {
        pullQuote: false,
      }),
    ).toContain("<blockquote>");
  });

  test("an aside or class a clipped page supplies is stripped", () => {
    // Only the pass after the sanitizer may grant the class (ADR 0009).
    const html = renderBlockHtml(
      `<aside class="pull-quote" data-pagefind-ignore="all">${LINE}</aside>`,
      "s",
    );
    expect(html).not.toContain("<aside");
    expect(html).not.toContain("pull-quote");
    expect(html).not.toContain("pagefind");
  });
});
