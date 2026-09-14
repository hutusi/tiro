import { beforeEach, describe, expect, test } from "bun:test";
import {
  type ClipHistory,
  DISCLOSURE_VERSION,
  type DisclosureState,
  lastClippedAt,
  loadLanguage,
  needsDisclosure,
  pruneClipHistory,
  recordClip,
  saveLanguage,
  type TiroExtensionConfig,
} from "../src/storage.ts";
import { type ChromeStorageMock, installChromeStorage } from "./helpers.ts";

const accepted = (version: number): DisclosureState => ({
  version,
  acceptedAt: "2026-08-26T10:00:00.000Z",
});

describe("needsDisclosure", () => {
  test("prompts a user who has never accepted", () => {
    expect(needsDisclosure({ version: 0, acceptedAt: "" })).toBe(true);
  });

  test("stays quiet once the current version is accepted", () => {
    expect(needsDisclosure(accepted(DISCLOSURE_VERSION))).toBe(false);
  });

  test("re-prompts when the disclosure version moves ahead", () => {
    // The Web Store requires re-disclosing data-practice changes after
    // install; bumping DISCLOSURE_VERSION is what re-prompts existing users.
    expect(needsDisclosure(accepted(DISCLOSURE_VERSION - 1))).toBe(true);
  });

  test("does not re-prompt a version from the future", () => {
    // A downgrade must not nag someone who accepted a later disclosure.
    expect(needsDisclosure(accepted(DISCLOSURE_VERSION + 1))).toBe(false);
  });
});

describe("pruneClipHistory", () => {
  const at = (day: number): string =>
    `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`;

  test("leaves a history under the cap untouched", () => {
    const history: ClipHistory = { a: at(1), b: at(2) };
    expect(pruneClipHistory(history, 3)).toBe(history);
  });

  test("drops the oldest entries past the cap", () => {
    const pruned = pruneClipHistory(
      { old: at(1), mid: at(2), newer: at(3), newest: at(4) },
      2,
    );
    expect(Object.keys(pruned).sort()).toEqual(["newer", "newest"]);
  });
});

describe("clip history", () => {
  let chrome: ChromeStorageMock = installChromeStorage();
  beforeEach(() => {
    chrome = installChromeStorage();
  });

  const vault: TiroExtensionConfig = {
    owner: "o",
    repo: "r",
    branch: "main",
    token: "t",
  };

  test("remembers a recorded slug's timestamp and not others", async () => {
    await recordClip(
      vault,
      "example-com-post-12345678",
      "2026-08-27T00:00:00.000Z",
    );
    expect(await lastClippedAt(vault, "example-com-post-12345678")).toBe(
      "2026-08-27T00:00:00.000Z",
    );
    expect(await lastClippedAt(vault, "example-com-other-87654321")).toBeNull();
  });

  test("does not surface another vault's clips", async () => {
    // Switching owner/repo/branch must not make old clips look present in
    // the new destination.
    expect(
      await lastClippedAt(
        { ...vault, repo: "other" },
        "example-com-post-12345678",
      ),
    ).toBeNull();
    expect(
      await lastClippedAt(
        { ...vault, branch: "dev" },
        "example-com-post-12345678",
      ),
    ).toBeNull();
  });

  test("re-recording the same slug updates rather than duplicates", async () => {
    // Both writes belong to this test: leaning on the one in the test above
    // made the assertion depend on execution order, and on a reset store it
    // would have quietly degraded into "one write leaves one entry".
    await recordClip(
      vault,
      "example-com-post-12345678",
      "2026-08-27T00:00:00.000Z",
    );
    await recordClip(
      vault,
      "example-com-post-12345678",
      "2026-08-28T00:00:00.000Z",
    );
    const history = chrome.local.data.tiroClipHistory as ClipHistory;
    expect(history["o/r#main::example-com-post-12345678"]).toBe(
      "2026-08-28T00:00:00.000Z",
    );
    expect(Object.keys(history)).toHaveLength(1);
  });
});

describe("language setting", () => {
  // Installed for the side effect only; these tests read through the loaders.
  beforeEach(() => {
    installChromeStorage();
  });

  test("defaults to auto when nothing is stored", async () => {
    expect(await loadLanguage()).toBe("auto");
  });

  test("round-trips an explicit choice", async () => {
    await saveLanguage("zh");
    expect(await loadLanguage()).toBe("zh");
    await saveLanguage("auto");
    expect(await loadLanguage()).toBe("auto");
  });
});
