import { describe, expect, test } from "bun:test";
import { SNAPSHOT_ID, snapshotAssetName } from "../src/paths.ts";

describe("snapshotAssetName", () => {
  test("is the id and .webp — the processor's own asset shape", () => {
    expect(snapshotAssetName("3f9a0c1b2d4e")).toBe("3f9a0c1b2d4e.webp");
  });

  test("refuses anything that is not twelve lowercase hex digits", () => {
    // The id reaches a vault path, so it is checked where the path is made.
    for (const id of [
      "",
      "3F9A0C1B2D4E",
      "3f9a0c1b2d4",
      "3f9a0c1b2d4e0",
      "../../x",
      "3f9a0c1b2d4e.webp",
    ]) {
      expect(SNAPSHOT_ID.test(id)).toBe(false);
      expect(() => snapshotAssetName(id)).toThrow();
    }
  });
});
