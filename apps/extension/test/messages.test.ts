import { describe, expect, test } from "bun:test";
import {
  type ClipResultMessage,
  isClipResult,
  isCollectionMessage,
} from "../src/messages.ts";

const valid: ClipResultMessage = {
  type: "tiro-clip-result",
  payload: {
    url: "https://example.com/post",
    title: "t",
    excerpt: "",
    author: "",
    markdown: "# t",
    readabilityFailed: false,
    hasMath: false,
    pdfViewer: false,
    latexmlFullText: false,
    markdownSource: false,
  },
};

describe("isClipResult", () => {
  test("accepts the clipper's message", () => {
    expect(isClipResult(valid)).toBe(true);
  });

  test("rejects other message types and non-objects", () => {
    expect(isClipResult({ ...valid, type: "other" })).toBe(false);
    expect(isClipResult(null)).toBe(false);
    expect(isClipResult("tiro-clip-result")).toBe(false);
  });

  test("rejects a payload that is missing or malformed", () => {
    // The popup dereferences the payload (new URL(url), word count of
    // markdown); a right type tag with a wrong shape must not get that far.
    expect(isClipResult({ type: "tiro-clip-result" })).toBe(false);
    // Every field is checked, including the newest: the popup reads pdfViewer
    // to decide whether to enable the button at all, so a payload without it
    // must not be treated as a clip.
    expect(
      isClipResult({
        type: "tiro-clip-result",
        payload: { ...valid.payload, pdfViewer: undefined },
      }),
    ).toBe(false);
    // The popup reads this one to decide whether pressing Clip would overwrite
    // a paper's full text with its abstract.
    expect(
      isClipResult({
        type: "tiro-clip-result",
        payload: { ...valid.payload, latexmlFullText: undefined },
      }),
    ).toBe(false);
    expect(
      isClipResult({
        type: "tiro-clip-result",
        payload: { ...valid.payload, url: undefined },
      }),
    ).toBe(false);
    expect(
      isClipResult({
        type: "tiro-clip-result",
        payload: { ...valid.payload, markdown: 42 },
      }),
    ).toBe(false);
    expect(
      isClipResult({
        type: "tiro-clip-result",
        payload: { ...valid.payload, readabilityFailed: "yes" },
      }),
    ).toBe(false);
  });
});

describe("isCollectionMessage", () => {
  const toggle = {
    type: "tiro-collection-toggle",
    op: { id: "x", collection: "favorites", slug: "a", action: "add", at: "t" },
    published: false,
    member: [],
  };

  test("accepts a toggle and a flush", () => {
    expect(isCollectionMessage(toggle)).toBe(true);
    expect(
      isCollectionMessage({ ...toggle, op: { ...toggle.op, title: "待读" } }),
    ).toBe(true);
    expect(isCollectionMessage({ type: "tiro-collection-flush" })).toBe(true);
  });

  // The worker writes what these carry into storage and then into the vault,
  // so every field is checked, not just the tag.
  test("refuses anything malformed", () => {
    for (const bad of [
      null,
      "tiro-collection-flush",
      { type: "tiro-collection-toggle" },
      { ...toggle, published: "no" },
      { ...toggle, member: [1] },
      { ...toggle, op: { ...toggle.op, action: "toggle" } },
      { ...toggle, op: { ...toggle.op, slug: 3 } },
      { ...toggle, op: { ...toggle.op, title: 5 } },
      { ...toggle, op: null },
    ]) {
      expect(isCollectionMessage(bad)).toBe(false);
    }
  });
});
