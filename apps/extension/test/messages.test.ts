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

  /** Optional, so a clipper built before the field still delivers its clip;
   * when present it goes into the article, so it must be a string. */
  test("takes the clipper's commit when it is a string, or absent", () => {
    expect(
      isClipResult({ ...valid, clipperCommit: "ext-v0.16.0-37-ge7a8dea" }),
    ).toBe(true);
    expect(isClipResult({ ...valid, clipperCommit: "" })).toBe(true);
    expect(isClipResult({ ...valid, clipperCommit: 42 })).toBe(false);
  });

  test("takes a capture's request id when it is a string, or absent", () => {
    expect(isClipResult({ ...valid, requestId: "r-1" })).toBe(true);
    expect(isClipResult({ ...valid, requestId: 7 })).toBe(false);
  });

  test("takes the document's id when it is a string, or absent", () => {
    expect(isClipResult({ ...valid, documentId: "9f2c" })).toBe(true);
    expect(isClipResult({ ...valid, documentId: null })).toBe(false);
  });

  /** ADR 0039. Optional, since only a page clip has figures; the ids become
   * file names in the vault, so they are held to the snapshot shape. */
  test("takes figure indices and snapshot ids only in their own shapes", () => {
    const withPayload = (extra: Record<string, unknown>) => ({
      ...valid,
      payload: { ...valid.payload, ...extra },
    });
    expect(
      isClipResult(
        withPayload({ scriptFigures: [0, 4], snapshots: ["3f9a0c1b2d4e"] }),
      ),
    ).toBe(true);
    for (const scriptFigures of [[-1], [1.5], ["2"], 3]) {
      expect(isClipResult(withPayload({ scriptFigures }))).toBe(false);
    }
    for (const snapshots of [
      ["../../index.md"],
      ["3f9a0c1b2d4e.webp"],
      ["3F9A0C1B2D4E"],
      "3f9a0c1b2d4e",
    ]) {
      expect(isClipResult(withPayload({ snapshots }))).toBe(false);
    }
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
    // No site to go by: a toggle made under a clip (ADR 0037).
    expect(isCollectionMessage({ ...toggle, member: null })).toBe(true);
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
      { ...toggle, member: "favorites" },
      { ...toggle, member: undefined },
      { ...toggle, op: { ...toggle.op, action: "toggle" } },
      { ...toggle, op: { ...toggle.op, slug: 3 } },
      { ...toggle, op: { ...toggle.op, title: 5 } },
      { ...toggle, op: null },
    ]) {
      expect(isCollectionMessage(bad)).toBe(false);
    }
  });
});
