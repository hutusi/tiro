import { describe, expect, test } from "bun:test";
import { type ClipResultMessage, isClipResult } from "../src/messages.ts";

const valid: ClipResultMessage = {
  type: "tiro-clip-result",
  payload: {
    url: "https://example.com/post",
    title: "t",
    excerpt: "",
    author: "",
    markdown: "# t",
    readabilityFailed: false,
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
