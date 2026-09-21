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
  mirrorSyncedChange,
  missingConfigFields,
  needsDisclosure,
  pruneClipHistory,
  reconcileDisabledSync,
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

  test("names the fields a config is missing, and never the branch", () => {
    expect(missingConfigFields(config)).toEqual([]);
    // Same exemption as above, from the other direction: an absent branch is
    // not something to ask the user for.
    expect(missingConfigFields({ ...config, branch: "" })).toEqual([]);
    expect(missingConfigFields({ ...config, owner: "" })).toEqual(["owner"]);
    expect(
      missingConfigFields({ owner: "", repo: "", branch: "", token: "" }),
    ).toEqual(["owner", "repo", "token"]);
  });

  test("treats an absent field as missing, not as present", () => {
    // These run against raw chrome.storage values, and loadConfig above
    // deliberately tolerates a partial object written by an older version.
    // Asking `undefined === ""` answered no, so a legacy {owner, repo}
    // counted as complete — and that is the one shape setSyncEnabled would
    // then upload to the profile without a token.
    expect(missingConfigFields({ owner: "o", repo: "r" })).toEqual(["token"]);
    expect(isConfigComplete({ owner: "o", repo: "r" })).toBe(false);
    expect(missingConfigFields({})).toEqual(["owner", "repo", "token"]);
  });

  test("answers rather than throws for a value that is not a config", () => {
    // Reached through the same raw-storage callers; a throw there would
    // reject a read that has a perfectly good local copy to fall back on.
    expect(isConfigComplete(null)).toBe(false);
    expect(isConfigComplete(undefined)).toBe(false);
    expect(isConfigComplete("nonsense")).toBe(false);
    expect(isConfigComplete({ owner: 1, repo: 2, token: 3 })).toBe(false);
  });
});

describe("settings sync — an incomplete config never displaces a complete one", () => {
  let chrome: ChromeStorageMock = installChromeStorage();
  beforeEach(() => {
    chrome = installChromeStorage();
  });

  const good: TiroExtensionConfig = {
    owner: "o",
    repo: "r",
    branch: "main",
    token: "t",
  };
  const blank: TiroExtensionConfig = {
    owner: "",
    repo: "",
    branch: "main",
    token: "",
  };

  // saveConfig refusing to publish one of these only binds machines running
  // that code. Every machine during a rollout, and any that never updates,
  // can still put one into sync — so the rule is enforced on the way in too,
  // at all three places a synced value comes back down.

  test("a read keeps the good local copy and does not mirror over it", async () => {
    chrome.local.data.tiroConfig = { ...good };
    chrome.sync.data.tiroConfig = { ...blank };
    chrome.sync.data.tiroSyncEnabled = true;
    expect(await loadConfig()).toEqual(good);
    expect(chrome.local.data.tiroConfig).toEqual(good);
  });

  test("the worker's mirror skips it, and still takes the language beside it", async () => {
    chrome.local.data.tiroConfig = { ...good };
    await mirrorSyncedChange({
      tiroConfig: { oldValue: good, newValue: blank },
      tiroLanguage: { oldValue: "en", newValue: "zh" },
    } as never);
    expect(chrome.local.data.tiroConfig).toEqual(good);
    // The skip must be the config's alone — bailing out of the whole mirror
    // would silently stop tracking every other synced key.
    expect(chrome.local.data.tiroLanguage).toBe("zh");
  });

  test("disabling copies down the good local copy, not the empty synced one", async () => {
    // The least obvious of the three: disabling copies sync down before
    // removing it, so a config an older machine published outlives the
    // switch and lands on top of a working one.
    chrome.local.data.tiroConfig = { ...good };
    chrome.sync.data.tiroConfig = { ...blank };
    chrome.sync.data.tiroSyncEnabled = true;
    await setSyncEnabled(false);
    expect(chrome.local.data.tiroConfig).toEqual(good);
  });

  test("enabling repairs an incomplete config left in sync by an older machine", async () => {
    // Reachable through the write-racing-a-disable residue ADR 0022 records
    // as narrowed rather than closed: a 0.14 machine's late empty save lands
    // after the flag has already gone false everywhere, so no machine
    // re-runs the reconcile that would have removed it.
    //
    // Nothing else ever repairs it. The ingress guard shields every
    // configured machine, which is exactly what hides the problem — the
    // residue sits in the profile emptying only the machines that arrive
    // fresh, because those have no local copy to be shielded by.
    chrome.sync.data.tiroSyncEnabled = false;
    chrome.sync.data.tiroConfig = { ...blank };
    chrome.local.data.tiroConfig = { ...good };
    await setSyncEnabled(true);
    expect(chrome.sync.data.tiroConfig).toEqual(good);
  });

  test("the documented off-then-on recovery clears a poisoned synced copy", async () => {
    // A profile whose sync is already on is not healed automatically: no
    // configured machine calls setSyncEnabled(true) again, so nothing
    // republishes. ADR 0022 accepts that and points at this procedure, which
    // means the procedure has to keep working — it is the recovery
    // docs/operations.md tells the owner to run.
    chrome.local.data.tiroConfig = { ...good };
    chrome.sync.data.tiroConfig = { ...blank };
    chrome.sync.data.tiroSyncEnabled = true;

    await setSyncEnabled(false);
    // Unticking keeps the better copy — before the ingress guard this step
    // was itself the wipe.
    expect(chrome.local.data.tiroConfig).toEqual(good);

    await setSyncEnabled(true);
    expect(chrome.sync.data.tiroConfig).toEqual(good);
    expect(await loadConfig()).toEqual(good);
  });

  test("but a machine with nothing of its own still takes what sync has", async () => {
    // The guard only ever holds local back when local is the better copy.
    // Turned into "never adopt an incomplete config" it would strand a
    // machine that genuinely has none, which is the case sync exists for.
    chrome.local.data.tiroConfig = { ...blank };
    chrome.sync.data.tiroConfig = { ...blank, branch: "release" };
    chrome.sync.data.tiroSyncEnabled = true;
    expect(await loadConfig()).toEqual({ ...blank, branch: "release" });
  });
});

describe("config — a config that cannot clip is refused", () => {
  let chrome: ChromeStorageMock = installChromeStorage();
  beforeEach(() => {
    chrome = installChromeStorage();
  });

  const good: TiroExtensionConfig = {
    owner: "o",
    repo: "r",
    branch: "main",
    token: "t",
  };
  const empty: TiroExtensionConfig = {
    owner: "",
    repo: "",
    branch: "main",
    token: "",
  };

  test("an empty save leaves every copy of a good config alone", async () => {
    // The incident this guards: a machine whose Chrome Sync carries nothing
    // shows the same empty form a first run shows, and saving it published
    // the emptiness everywhere — sync took it, and every other machine's
    // worker mirrored it down over the copy that still worked.
    await setSyncEnabled(true);
    await saveConfig(good);

    await expect(saveConfig(empty)).rejects.toThrow();

    expect(chrome.sync.data.tiroConfig).toEqual(good);
    expect(chrome.local.data.tiroConfig).toEqual(good);
    expect(await loadConfig()).toEqual(good);

    // The positive control belongs in this test rather than a neighbour: it
    // is what rules out a guard that simply refuses everything.
    await saveConfig({ ...good, repo: "second" });
    expect(chrome.sync.data.tiroConfig).toEqual({ ...good, repo: "second" });
  });

  test("a config missing only the token is refused too", async () => {
    // Pins the shape of the guard. "Refuse only a wholly empty form" would
    // pass the test above and let this one through, and a config with no
    // token cannot clip any more than one with no fields can.
    await saveConfig(good);
    await expect(saveConfig({ ...good, token: "" })).rejects.toThrow();
    expect(await loadConfig()).toEqual(good);
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

  test("does not push a leftover config that cannot clip", async () => {
    // A 0.14.0 install that saved an empty form before that was refused still
    // holds one in local. Enabling sync must not be what finally publishes it
    // to the profile — on this machine it is dead weight, on every other one
    // it is the wipe.
    const unusable = { owner: "", repo: "", branch: "main", token: "" };
    chrome.local.data.tiroConfig = unusable;
    await setSyncEnabled(true);
    expect(chrome.sync.data.tiroConfig).toBeUndefined();
    // The enable itself still has to have happened...
    expect(await loadSyncEnabled()).toBe(true);
    // ...and the skip is a skip, not a deletion of this machine's own copy.
    expect(chrome.local.data.tiroConfig).toEqual(unusable);
  });

  test("still adopts sync's settings when this machine's copy is unusable", async () => {
    // The guard above must not turn into "refuse to enable without a complete
    // local config", which would break the case the whole feature exists for:
    // a second machine with nothing of its own joining the shared settings.
    chrome.local.data.tiroConfig = {
      owner: "",
      repo: "",
      branch: "main",
      token: "",
    };
    chrome.sync.data.tiroConfig = config;
    await setSyncEnabled(true);
    expect(await loadConfig()).toEqual(config);
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
    // Enabling pushes the config up, so without this the disable below is
    // handed a populated sync area and the case the name promises — nothing
    // in sync to copy down — goes untested.
    delete chrome.sync.data.tiroConfig;
    expect(chrome.sync.data.tiroConfig).toBeUndefined();

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

describe("mirroring synced changes as they arrive", () => {
  let chrome: ChromeStorageMock = installChromeStorage();
  beforeEach(() => {
    chrome = installChromeStorage();
  });

  const v1: TiroExtensionConfig = {
    owner: "o",
    repo: "r",
    branch: "main",
    token: "v1",
  };
  const v2: TiroExtensionConfig = { ...v1, token: "v2" };

  test("takes a new value without waiting for this machine to read", async () => {
    chrome.local.data.tiroConfig = v1;
    await mirrorSyncedChange({ tiroConfig: { newValue: v2 } });
    expect(chrome.local.data.tiroConfig).toEqual(v2);
  });

  test("ignores a removal, which is how a remote disable arrives", async () => {
    // The whole point, and the way this guard turns into the bug it prevents
    // if it is written carelessly: switching sync off elsewhere reaches every
    // other machine as the synced keys disappearing. Mirroring that through
    // would erase the copy the machine is about to need.
    chrome.local.data.tiroConfig = v1;
    chrome.local.data.tiroLanguage = "zh";
    await mirrorSyncedChange({
      tiroConfig: { oldValue: v1 },
      tiroLanguage: { oldValue: "zh" },
    });
    expect(chrome.local.data.tiroConfig).toEqual(v1);
    expect(chrome.local.data.tiroLanguage).toBe("zh");
  });

  test("mirrors the language alongside the config", async () => {
    await mirrorSyncedChange({ tiroLanguage: { newValue: "zh" } });
    expect(chrome.local.data.tiroLanguage).toBe("zh");
  });

  test("copies nothing but the synced keys", async () => {
    // The flag belongs to sync alone, and the clip record and the disclosure
    // never travel at all; a mirror that took everything would put them in
    // local from a source that should not be able to set them.
    await mirrorSyncedChange({
      tiroSyncEnabled: { newValue: true },
      tiroClipHistory: { newValue: { a: "2026-09-15T00:00:00.000Z" } },
      tiroDisclosure: { newValue: { version: 3, acceptedAt: "x" } },
    });
    expect(chrome.local.data).toEqual({});
  });

  test("survives a remote disable end to end", async () => {
    // The sequence the service worker exists for: this machine reads v1,
    // another saves v2, then switches sync off. Before the worker mirrored,
    // this machine fell back to v1 — not merely stale but wrong, and quiet
    // about it.
    chrome.sync.data.tiroSyncEnabled = true;
    chrome.sync.data.tiroConfig = v1;
    expect(await loadConfig()).toEqual(v1);

    chrome.sync.data.tiroConfig = v2;
    await mirrorSyncedChange({ tiroConfig: { newValue: v2 } });

    delete chrome.sync.data.tiroConfig;
    chrome.sync.data.tiroSyncEnabled = false;
    await mirrorSyncedChange({ tiroConfig: { oldValue: v2 } });

    expect(await loadConfig()).toEqual(v2);
  });
});

describe("settings sync — a read cannot undo a save it overlapped", () => {
  let chrome: ChromeStorageMock = installChromeStorage();
  beforeEach(() => {
    chrome = installChromeStorage();
  });

  const v1: TiroExtensionConfig = {
    owner: "o",
    repo: "r",
    branch: "main",
    token: "v1",
  };
  const v2: TiroExtensionConfig = { ...v1, token: "v2" };

  test("a mirror write cannot put back a value the save replaced", async () => {
    // The read takes v1 from sync, a save stores v2 while it is in flight, and
    // the mirror write must not then restore v1 over it. Queuing only the
    // write left that gap: harmless while sync is on, since the next read
    // fetches v2 again, but v1 is the copy a later disable falls back to.
    chrome.sync.data.tiroSyncEnabled = true;
    chrome.sync.data.tiroConfig = v1;

    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const captured = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const realGet = chrome.sync.get;
    let stalled = false;
    let capturedToken: unknown;
    chrome.sync.get = async (keys) => {
      const wanted = typeof keys === "string" ? [keys] : (keys ?? []);
      if (!stalled && wanted.includes("tiroConfig")) {
        stalled = true;
        // Snapshot v1 *before* stalling, and hand that back afterwards: a
        // stall that defers the fetch itself reads the post-save value.
        const snapshot = await realGet(keys);
        capturedToken = (snapshot.tiroConfig as TiroExtensionConfig)?.token;
        entered();
        await blocked;
        return snapshot;
      }
      return realGet(keys);
    };

    const reading = loadConfig();
    // Start the save only once the read has v1 in hand. Without this gate the
    // save wins the queue — it reaches serialize() synchronously while the
    // read has three awaits to clear first — so the snapshot is already v2 and
    // the stale value this test is about never exists.
    await captured;
    const saving = saveConfig(v2);
    release();
    await Promise.all([reading, saving]);
    chrome.sync.get = realGet;

    expect(capturedToken).toBe("v1");
    expect(chrome.local.data.tiroConfig).toEqual(v2);
  });
});

describe("settings sync — a disable elsewhere wins over a late write", () => {
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

  test("a save that loses to a disable takes its own write back", async () => {
    // Chrome takes seconds to propagate a disable, which is long enough for a
    // save here to put the token back after someone deliberately removed it.
    chrome.sync.data.tiroSyncEnabled = true;
    let reads = 0;
    const realGet = chrome.sync.get;
    chrome.sync.get = async (keys) => {
      const wanted = typeof keys === "string" ? [keys] : (keys ?? []);
      // The disable lands between the flag read and the write.
      if (wanted.includes("tiroSyncEnabled") && ++reads === 1) {
        const out = await realGet(keys);
        chrome.sync.data.tiroSyncEnabled = false;
        return out;
      }
      return realGet(keys);
    };

    await saveConfig(config);
    chrome.sync.get = realGet;

    expect(chrome.sync.data.tiroConfig).toBeUndefined();
    // The save still counts locally; only its copy in sync is withdrawn.
    expect(chrome.local.data.tiroConfig).toEqual(config);
  });

  test("clears settings that outlived the switch going off", async () => {
    chrome.sync.data.tiroSyncEnabled = false;
    chrome.sync.data.tiroConfig = config;
    chrome.sync.data.tiroLanguage = "zh";

    await reconcileDisabledSync({ tiroSyncEnabled: { newValue: false } });

    expect(chrome.sync.data.tiroConfig).toBeUndefined();
    expect(chrome.sync.data.tiroLanguage).toBeUndefined();
  });

  test("does not mistake an enable for a disable", async () => {
    // Chrome does not promise the keys and the flag arrive together, so during
    // an enable a machine can see the config while its flag still reads the
    // old value. Treating anything but an explicit false as "off" would delete
    // the settings the enable just published.
    chrome.sync.data.tiroConfig = config;

    await reconcileDisabledSync({ tiroConfig: { newValue: config } });
    expect(chrome.sync.data.tiroConfig).toEqual(config);

    await reconcileDisabledSync({ tiroSyncEnabled: { newValue: true } });
    expect(chrome.sync.data.tiroConfig).toEqual(config);
  });
});
