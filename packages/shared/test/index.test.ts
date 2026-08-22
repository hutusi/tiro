import { describe, expect, test } from "bun:test";
import { TIRO_SCHEMA_VERSION } from "../src/index.ts";

describe("@tiro/shared", () => {
  test("exposes the schema version", () => {
    expect(TIRO_SCHEMA_VERSION).toBe(1);
  });
});
