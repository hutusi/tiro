import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { clipPage } from "../src/clip-page.ts";
import { pageDescription } from "../src/page-claims.ts";

/** A scoped window, for the reason dom-prepare.test.ts gives. */
function pageFrom(head: string, body: string): Document {
  const window = new Window({ url: "https://maps.example.org/roman-battles/" });
  window.document.head.innerHTML = head;
  window.document.body.innerHTML = body;
  return window.document as unknown as Document;
}

const URL = "https://maps.example.org/roman-battles/";

describe("pageDescription (ADR 0055)", () => {
  test("prefers the Open Graph text, written for a person", () => {
    const doc = pageFrom(
      `<meta name="description" content="Roman battles map, interactive">
       <meta property="og:description" content="Every battle Rome fought, on one map.">
       <meta name="twitter:description" content="Twitter card text">`,
      "",
    );
    expect(pageDescription(doc)).toBe("Every battle Rome fought, on one map.");
  });

  test("falls back to description, then the Twitter card", () => {
    expect(
      pageDescription(
        pageFrom(
          `<meta name="twitter:description" content="Card">
           <meta name="description" content="  Plain\n   text  ">`,
          "",
        ),
      ),
    ).toBe("Plain text");
    expect(
      pageDescription(
        pageFrom(`<meta name="twitter:description" content="Card">`, ""),
      ),
    ).toBe("Card");
  });

  test("skips an empty claim rather than reporting nothing", () => {
    expect(
      pageDescription(
        pageFrom(
          `<meta property="og:description" content="   ">
           <meta name="description" content="Real">`,
          "",
        ),
      ),
    ).toBe("Real");
  });

  test("is empty when the page says nothing", () => {
    expect(pageDescription(pageFrom("", "<p>hi</p>"))).toBe("");
  });

  // The page a site is for: a canvas and a few labels. Readability gives up,
  // and its excerpt with it, but the head still says what the page is.
  test("reaches the payload of a page Readability cannot read", () => {
    const payload = clipPage(
      pageFrom(
        `<title>Battles of the Roman Republic</title>
         <meta property="og:description" content="An interactive map of Rome's battles.">`,
        `<div id="app"><canvas width="800" height="600"></canvas><span>509 BC</span></div>`,
      ),
      URL,
    );
    expect(payload.description).toBe("An interactive map of Rome's battles.");
  });
});
