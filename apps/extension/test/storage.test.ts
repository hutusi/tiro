import { beforeEach, describe, expect, test } from "bun:test";
import {
  acceptDisclosure,
  type ClipHistory,
  DISCLOSURE_VERSION,
  type DisclosureState,
  isConfigComplete,
  lastClippedAt,
  loadConfig,
  loadDisclosure,
  loadLanguage,
  loadSyncEnabled,
  needsDisclosure,
  pruneClipHistory,
  recordClip,
  saveConfig,
  saveLanguage,
  setSyncEnabled,
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

describe("config", () => {
  let chrome: ChromeStorageMock = installChromeStorage();
  beforeEach(() => {
    chrome = installChromeStorage();
  });

  const config: TiroExtensionConfig = {
    owner: "o",
    repo: "r",
    branch: "dev",
    token: "t",
  };

  test("defaults an unset config, with main as the branch", async () => {
    expect(await loadConfig()).toEqual({
      owner: "",
      repo: "",
      branch: "main",
      token: "",
    });
  });

  test("round-trips a saved config", async () => {
    await saveConfig(config);
    expect(await loadConfig()).toEqual(config);
  });

  test("fills in fields missing from a partial stored config", async () => {
    // A config written by an older version must not load as undefined fields.
    chrome.local.data.tiroConfig = { owner: "o", repo: "r" };
    expect(await loadConfig()).toEqual({
      owner: "o",
      repo: "r",
      branch: "main",
      token: "",
    });
  });

  test("counts a config complete only with owner, repo and token", async () => {
    expect(isConfigComplete(config)).toBe(true);
    // Branch is the one field with a usable default, so it does not gate.
    expect(isConfigComplete({ ...config, branch: "" })).toBe(true);
    expect(isConfigComplete({ ...config, owner: "" })).toBe(false);
    expect(isConfigComplete({ ...config, repo: "" })).toBe(false);
    expect(isConfigComplete({ ...config, token: "" })).toBe(false);
  });
});

describe("disclosure record", () => {
  let chrome: ChromeStorageMock = installChromeStorage();
  beforeEach(() => {
    chrome = installChromeStorage();
  });

  test("reports never-accepted when nothing is stored", async () => {
    expect(await loadDisclosure()).toEqual({ version: 0, acceptedAt: "" });
  });

  test("records an acceptance at the current version", async () => {
    await acceptDisclosure("2026-09-15T10:00:00.000Z");
    expect(await loadDisclosure()).toEqual({
      version: DISCLOSURE_VERSION,
      acceptedAt: "2026-09-15T10:00:00.000Z",
    });
    expect(needsDisclosure(await loadDisclosure())).toBe(false);
  });

  test("stays in local even with settings sync on", async () => {
    // Consent to read pages is per install: a fresh machine must be asked,
    // not handed an acceptance made somewhere else.
    await setSyncEnabled(true);
    await acceptDisclosure("2026-09-15T10:00:00.000Z");
    expect(chrome.sync.data.tiroDisclosure).toBeUndefined();
    expect(chrome.local.data.tiroDisclosure).toBeDefined();
  });
});

describe("settings sync", () => {
  let chrome: ChromeStorageMock = installChromeStorage();
  beforeEach(() => {
    chrome = installChromeStorage();
  });

  const config: TiroExtensionConfig = {
    owner: "o",
    repo: "r",
    branch: "main",
    token: "t",
  };
  const other: TiroExtensionConfig = { ...config, owner: "elsewhere" };

  test("is off until switched on", async () => {
    expect(await loadSyncEnabled()).toBe(false);
  });

  test("keeps settings out of sync while off", async () => {
    await saveConfig(config);
    await saveLanguage("zh");
    expect(chrome.sync.data).toEqual({});
  });

  test("pushes existing local settings up when switched on", async () => {
    await saveConfig(config);
    await saveLanguage("zh");
    await setSyncEnabled(true);
    expect(chrome.sync.data.tiroConfig).toEqual(config);
    expect(chrome.sync.data.tiroLanguage).toBe("zh");
    expect(await loadSyncEnabled()).toBe(true);
  });

  test("joins settings already in sync instead of clobbering them", async () => {
    // The headline case: a second machine already holds settings of its own
    // and sync carries the shared ones. Flipping the toggle must adopt what
    // sync has rather than push this machine's copy over it. The local value
    // has to differ for that to be observable at all — seeding only sync
    // passes whether or not the guard is there.
    await saveConfig(config);
    chrome.sync.data.tiroConfig = other;
    await setSyncEnabled(true);
    expect(chrome.sync.data.tiroConfig).toEqual(other);
    expect(await loadConfig()).toEqual(other);
  });

  test("reads sync in preference to a stale local mirror", async () => {
    await saveConfig(config);
    await setSyncEnabled(true);
    chrome.sync.data.tiroConfig = other;
    expect(await loadConfig()).toEqual(other);
  });

  test("falls back to local when sync holds nothing yet", async () => {
    // The window after the toggle goes on and before Chrome pushes anything.
    await saveConfig(config);
    chrome.sync.data.tiroSyncEnabled = true;
    expect(await loadConfig()).toEqual(config);
  });

  test("mirrors every write to local while on", async () => {
    await setSyncEnabled(true);
    await saveConfig(config);
    await saveLanguage("en");
    expect(chrome.local.data.tiroConfig).toEqual(config);
    expect(chrome.local.data.tiroLanguage).toBe("en");
  });

  test("keeps clip history out of sync", async () => {
    // One key, up to 500 entries: sync would reject it over the 8 KB
    // per-item cap long before the cap in storage.ts was reached.
    await setSyncEnabled(true);
    await recordClip(
      config,
      "example-com-post-12345678",
      "2026-09-15T00:00:00.000Z",
    );
    expect(chrome.sync.data.tiroClipHistory).toBeUndefined();
    expect(chrome.local.data.tiroClipHistory).toBeDefined();
  });

  test("copies settings down and clears sync when switched off", async () => {
    await setSyncEnabled(true);
    chrome.sync.data.tiroConfig = other;
    chrome.sync.data.tiroLanguage = "zh";

    await setSyncEnabled(false);

    // Clearing the keys is the point of disabling: it takes the token off
    // Google's servers rather than just stopping new writes.
    expect(chrome.sync.data.tiroConfig).toBeUndefined();
    expect(chrome.sync.data.tiroLanguage).toBeUndefined();
    expect(chrome.sync.data.tiroSyncEnabled).toBe(false);
    // And nothing is lost doing it.
    expect(await loadConfig()).toEqual(other);
    expect(await loadLanguage()).toBe("zh");
  });

  test("leaves settings readable when switched off with sync empty", async () => {
    await saveConfig(config);
    await setSyncEnabled(true);
    await setSyncEnabled(false);
    expect(await loadConfig()).toEqual(config);
  });
});

describe("settings sync — surviving a change made elsewhere", () => {
  let chrome: ChromeStorageMock = installChromeStorage();
  beforeEach(() => {
    chrome = installChromeStorage();
  });

  const config: TiroExtensionConfig = {
    owner: "o",
    repo: "r",
    branch: "main",
    token: "t",
  };

  test("a machine configured only by sync keeps its settings when another machine disables it", async () => {
    // The zero-setup case, and the one the feature exists for: Chrome has
    // pushed the flag and the config down, and this machine has never saved
    // anything of its own. It therefore never called a writer, so only a read
    // can have left it a copy.
    chrome.sync.data.tiroSyncEnabled = true;
    chrome.sync.data.tiroConfig = config;
    chrome.sync.data.tiroLanguage = "zh";
    expect(await loadConfig()).toEqual(config);
    expect(await loadLanguage()).toBe("zh");

    // Another machine switches sync off, which withdraws the synced keys
    // everywhere and flips the flag.
    delete chrome.sync.data.tiroConfig;
    delete chrome.sync.data.tiroLanguage;
    chrome.sync.data.tiroSyncEnabled = false;

    expect(await loadConfig()).toEqual(config);
    expect(await loadLanguage()).toBe("zh");
  });

  test("reading from sync leaves a local copy behind", async () => {
    chrome.sync.data.tiroSyncEnabled = true;
    chrome.sync.data.tiroConfig = config;
    await loadConfig();
    expect(chrome.local.data.tiroConfig).toEqual(config);
  });

  test("a cold local mirror does not fail the read", async () => {
    // A machine that cannot write locally has worse problems than a stale
    // mirror; refusing the read would stop a clip that was otherwise fine.
    chrome.sync.data.tiroSyncEnabled = true;
    chrome.sync.data.tiroConfig = config;
    chrome.local.set = async () => {
      throw new Error("local unavailable");
    };
    expect(await loadConfig()).toEqual(config);
  });
});

describe("settings sync — a flag that cannot be read", () => {
  let chrome: ChromeStorageMock = installChromeStorage();
  beforeEach(() => {
    chrome = installChromeStorage();
  });

  const config: TiroExtensionConfig = {
    owner: "o",
    repo: "r",
    branch: "main",
    token: "t",
  };

  test("a save fails rather than silently becoming local-only", async () => {
    // Demoting the write and reporting success would strand the user: the
    // older synced config wins again as soon as the read recovers.
    chrome.sync.data.tiroSyncEnabled = true;
    chrome.sync.get = async () => {
      throw new Error("sync unavailable");
    };
    await expect(saveConfig(config)).rejects.toThrow("sync unavailable");
  });

  test("a read still answers, from the local mirror", async () => {
    // The opposite direction, and deliberately so: the popup must still be
    // able to clip.
    await saveConfig(config);
    chrome.sync.get = async () => {
      throw new Error("sync unavailable");
    };
    expect(await loadConfig()).toEqual(config);
  });
});

describe("settings sync — mutations do not interleave", () => {
  let chrome: ChromeStorageMock = installChromeStorage();
  beforeEach(() => {
    chrome = installChromeStorage();
  });

  const older: TiroExtensionConfig = {
    owner: "old",
    repo: "old-vault",
    branch: "main",
    token: "old_token",
  };
  const newer: TiroExtensionConfig = {
    owner: "new",
    repo: "new-vault",
    branch: "main",
    token: "new_token",
  };

  test("a toggle landing inside a save cannot resurrect the older token", async () => {
    // Sync off, an older config already stored. The save of `newer` reads the
    // flag first; the toggle lands in that gap. Unserialised, the save writes
    // locally only (it saw "off") while the toggle copies `older` up to sync
    // and turns sync on — so the next read hands back the token the user just
    // replaced. Both operations report success.
    await saveConfig(older);

    let releaseFlagRead: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseFlagRead = resolve;
    });
    const realGet = chrome.sync.get;
    let stalled = false;
    chrome.sync.get = async (keys) => {
      if (!stalled) {
        stalled = true;
        await blocked;
      }
      return realGet(keys);
    };

    const saving = saveConfig(newer);
    const toggling = setSyncEnabled(true);
    releaseFlagRead();
    await Promise.all([saving, toggling]);
    chrome.sync.get = realGet;

    expect(await loadConfig()).toEqual(newer);
    expect(chrome.sync.data.tiroConfig).toEqual(newer);
  });
});

describe("settings sync — a read answers whatever sync does", () => {
  let chrome: ChromeStorageMock = installChromeStorage();
  beforeEach(() => {
    chrome = installChromeStorage();
  });

  const config: TiroExtensionConfig = {
    owner: "o",
    repo: "r",
    branch: "main",
    token: "t",
  };

  test("a failed data read still answers from the mirror", async () => {
    // The flag read succeeds and only the data read fails, which guarding the
    // flag alone did not cover: loadConfig rejected outright, leaving the
    // popup with no config and no way to clip despite a good local copy.
    await saveConfig(config);
    chrome.sync.data.tiroSyncEnabled = true;
    const realGet = chrome.sync.get;
    chrome.sync.get = async (keys) => {
      const wanted = typeof keys === "string" ? [keys] : (keys ?? []);
      if (wanted.includes("tiroConfig")) throw new Error("sync unavailable");
      return realGet(keys);
    };
    expect(await loadConfig()).toEqual(config);
  });
});
