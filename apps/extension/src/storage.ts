import type { LanguageSetting } from "./i18n.ts";

export interface TiroExtensionConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

const KEY = "tiroConfig";
const LANGUAGE_KEY = "tiroLanguage";

/** Kept in `sync` rather than `local` so the opt-in itself travels: a new
 * machine signed into the same Chrome profile finds the flag already true and
 * reads the settings beside it, which is the whole point — a per-device flag
 * would still make every machine a manual step, just a shorter one. */
const SYNC_KEY = "tiroSyncEnabled";

/** The only keys that ever reach `chrome.storage.sync`.
 *
 * `tiroClipHistory` is excluded on a hard constraint, not a preference: it is
 * one key holding up to 500 entries (~35-50 KB), and sync caps a single item
 * at 8,192 bytes, so writing it there would throw on a well-used vault. It is
 * a per-device hint anyway (see below). `tiroDisclosure` is excluded by
 * choice: consent to read pages is per install, and syncing it would let a
 * fresh install skip the disclosure before it first reads anything. */
const SYNCED_KEYS = [KEY, LANGUAGE_KEY];

/** Whether a value arriving from `sync` must not be allowed to replace what
 * `local` already holds.
 *
 * `saveConfig` refusing to publish a config that cannot clip only binds the
 * machines running that code. An older install — every machine during a
 * rollout, and any that never updates — can still put one into the synced
 * area, and all three ways a synced value comes back down would copy it
 * faithfully: the mirror inside `readSynced`, the worker's `onChanged`
 * mirror, and the copy-down that disabling performs. That is the same
 * profile-wide wipe the write guard exists to prevent, arriving from the
 * other direction, so the rule is enforced on ingress as well as on egress.
 *
 * It holds `local` back only when `local` is the better copy. If that is
 * incomplete too there is nothing to protect, and taking the remote value is
 * what keeps a machine that has genuinely never been configured tracking the
 * profile — the case the whole feature exists for. */
function keepsLocalConfig(
  key: string,
  incoming: unknown,
  local: unknown,
): boolean {
  return key === KEY && !isConfigComplete(incoming) && isConfigComplete(local);
}

/** Whether the user has opted settings into Chrome sync. Off unless they say
 * otherwise: turning it on uploads the PAT to Google's servers and pushes it
 * to every machine on the profile, which is the user's call to make and not a
 * default to inherit (ADR 0022).
 *
 * Throws if the answer cannot be read. Only the read path may paper over that
 * (see `syncEnabledForRead`); anything that writes, or that reports the state
 * to the user, has to know it asked successfully. */
export async function loadSyncEnabled(): Promise<boolean> {
  const stored = await chrome.storage.sync.get(SYNC_KEY);
  return stored[SYNC_KEY] === true;
}

/** The same question, answered "off" when it cannot be asked at all.
 *
 * Reads may do this because `local` is kept current (see `readSynced`), so
 * falling back to it still finds settings, where throwing would leave the
 * popup with no config and no way to clip. A *write* must never take the same
 * shortcut: it would store the config locally, report success, and leave the
 * synced copy to win again the moment the read recovered. */
async function syncEnabledForRead(): Promise<boolean> {
  try {
    return await loadSyncEnabled();
  } catch {
    return false;
  }
}

/** Mutations of the synced keys run one at a time **within this page**.
 *
 * Freezing the form is not enough, because it only stops work that has not
 * started. A Save already in flight reads the flag and then writes; a toggle
 * landing between those two steps makes the Save store its config in the wrong
 * place while the toggle copies up a config the Save has not written yet. Both
 * report success, and the older synced token wins the next read.
 *
 * **This chain is per JS realm, not per profile.** Each options tab and the
 * service worker get their own module instance, so two options tabs acting at
 * the same instant are not serialised against each other. That is accepted
 * rather than fixed (ADR 0022): the options page is the only writer of these
 * keys, and `chrome.runtime.openOptionsPage` focuses an open one instead of
 * opening a second, so the arrangement takes deliberate effort to create.
 * Closing it properly means routing every mutation through the worker, which
 * is a messaging layer and a new way for a save to fail on a path that today
 * cannot.
 *
 * Nothing queued may await something else queued, or the chain deadlocks —
 * `writeSynced` reads the flag (a read, unqueued) and `setSyncEnabled` calls
 * neither, so the chain stays flat. */
let mutations: Promise<unknown> = Promise.resolve();

function serialize<T>(op: () => Promise<T>): Promise<T> {
  // Both arms run `op`: a previous mutation's failure is its caller's problem
  // and must not cancel the next one.
  const next = mutations.then(op, op);
  mutations = next.catch(() => undefined);
  return next;
}

/** Reads one synced key, preferring `sync` when enabled but falling back to
 * `local` when it holds nothing yet — the window after the toggle goes on and
 * before Chrome has pushed anything down.
 *
 * Records what it reads from `sync` into `local`. The write on a read path is
 * the point of this function rather than an accident: a machine configured
 * entirely by sync never calls a writer, so it would hold no copy of its own,
 * and disabling sync from another machine — which withdraws the synced keys
 * everywhere — would leave it with nothing but defaults. Mirroring on read is
 * what makes ADR 0022's "no machine is left without settings" true for the
 * machine the feature exists to serve.
 *
 * Best-effort, and deliberately so: a machine whose `local` cannot be written
 * has worse problems than a cold mirror, and failing the read would stop a
 * clip that was otherwise fine. Writing only on a difference keeps opening the
 * popup from churning storage for nothing. */
async function readSynced(key: string): Promise<unknown> {
  if (!(await syncEnabledForRead())) {
    return (await chrome.storage.local.get(key))[key];
  }
  // The read, the comparison and the mirror write are one queued unit, not a
  // bare write at the end. Queuing only the write let a save land in between:
  // the read captured v1, the save stored v2, and the mirror write then put v1
  // back over it. That self-corrects while sync is on — the next read fetches
  // v2 again — but it is exactly the copy a later disable falls back to.
  return serialize(async () => {
    const local = (await chrome.storage.local.get(key))[key];
    let stored: Record<string, unknown>;
    try {
      stored = await chrome.storage.sync.get(key);
    } catch {
      // The same tolerance the flag read gets, and for the same reason: a read
      // that cannot reach `sync` must still answer from the mirror, because the
      // popup has no way to clip without a config. Guarding only the flag left
      // this one failure able to reject the whole read.
      return local;
    }
    if (!(key in stored)) return local;
    const value = stored[key];
    // Ingress: an older machine can still have published a config that
    // cannot clip, and adopting it here would both answer this read wrongly
    // and overwrite the good mirror below.
    if (keepsLocalConfig(key, value, local)) return local;
    if (JSON.stringify(local) !== JSON.stringify(value)) {
      try {
        await chrome.storage.local.set({ [key]: value });
      } catch {
        // Cold mirror; the value read is still good.
      }
    }
    return value;
  });
}

/** Writes one synced key to `local`, and to `sync` too when enabled.
 *
 * Settles the flag before writing anything, so a flag that cannot be read
 * fails the whole save rather than quietly demoting it to local-only. */
async function writeSynced(key: string, value: unknown): Promise<void> {
  await serialize(async () => {
    const enabled = await loadSyncEnabled();
    await chrome.storage.local.set({ [key]: value });
    if (!enabled) return;
    await chrome.storage.sync.set({ [key]: value });
    // Another machine may have switched sync off between the flag read and
    // this write, and Chrome takes seconds to propagate that — long enough for
    // a save here to put the token back after someone deliberately removed it.
    // Checking again cannot close the race (their disable may still be in
    // flight), but it does mean this machine never knowingly leaves a token in
    // sync after seeing the flag go false. ADR 0022 records what is left.
    if (!(await loadSyncEnabled())) {
      await chrome.storage.sync.remove(key);
    }
  });
}

/** Turns settings sync on or off, moving the synced keys across.
 *
 * Enabling does not overwrite a value `sync` already holds. That is what makes
 * the headline case work: on a second machine `sync` already carries the
 * settings, so flipping the toggle joins them rather than clobbering them with
 * the empty form the user is looking at. Only keys `sync` lacks are pushed up.
 *
 * **With one exception: a synced config that cannot clip is treated as
 * absent** when this machine's copy can. Such a value is not settings anyone
 * chose but the residue of an older machine's empty save, and it is the one
 * thing "adopt, never clobber" would otherwise preserve forever — see
 * `keepsLocalConfig`, which is the same rule read in the other direction.
 *
 * Disabling copies `sync` down before removing anything, so no device is left
 * without settings, then clears the keys from `sync` — that removal is what
 * actually takes the token off Google's servers, so it is the point of the
 * operation rather than tidying after it. */
export async function setSyncEnabled(enabled: boolean): Promise<void> {
  await serialize(async () => {
    if (enabled) {
      const [local, sync] = await Promise.all([
        chrome.storage.local.get(SYNCED_KEYS),
        chrome.storage.sync.get(SYNCED_KEYS),
      ]);
      const push: Record<string, unknown> = {};
      for (const key of SYNCED_KEYS) {
        if (!(key in local)) continue;
        // Enabling adopts what `sync` already holds rather than clobbering
        // it — except when what it holds cannot clip and this machine's copy
        // can. `keepsLocalConfig` is the same rule read in the other
        // direction: an incomplete config never displaces a complete one, so
        // a complete one may replace it. Without this the residue is
        // permanent, and invisibly so — every configured machine is shielded
        // from it by the ingress guard, so it sits in the profile wiping
        // only the machines that arrive fresh, which have nothing of their
        // own to be shielded by.
        if (key in sync && !keepsLocalConfig(key, sync[key], local[key])) {
          continue;
        }
        // A leftover from before `saveConfig` refused these: an install that
        // once saved an empty form still holds one, and enabling must not be
        // what finally publishes it to the profile. Skipped rather than
        // deleted — the local copy is this machine's business, and the only
        // claim being made here is about what reaches sync. Note this must
        // stay a per-key skip: refusing the whole enable would break the case
        // the feature exists for, a second machine with nothing of its own
        // joining the settings sync already holds.
        if (key === KEY && !isConfigComplete(local[key])) continue;
        push[key] = local[key];
      }
      await chrome.storage.sync.set({ ...push, [SYNC_KEY]: true });
      return;
    }
    const [sync, local] = await Promise.all([
      chrome.storage.sync.get(SYNCED_KEYS),
      chrome.storage.local.get(SYNCED_KEYS),
    ]);
    const keep: Record<string, unknown> = {};
    for (const key of SYNCED_KEYS) {
      if (!(key in sync)) continue;
      // The third ingress, and the least obvious: disabling copies the
      // synced values down, so a config an older machine published outlives
      // the switch and lands on top of a good one. Keeping the better copy
      // is the whole point of copying down before removing.
      if (keepsLocalConfig(key, sync[key], local[key])) continue;
      keep[key] = sync[key];
    }
    if (Object.keys(keep).length > 0) await chrome.storage.local.set(keep);
    await chrome.storage.sync.remove(SYNCED_KEYS);
    await chrome.storage.sync.set({ [SYNC_KEY]: false });
  });
}

/** Republishes this machine's config when the synced copy cannot clip.
 *
 * `setSyncEnabled(true)` repairs such a value, but a profile whose sync is
 * already on never calls it again: the machines that could repair it are the
 * configured ones, and the ingress guard means they never notice anything is
 * wrong. So the residue outlives every machine that could fix it, and empties
 * only the ones arriving fresh, which have no copy of their own to be
 * shielded by.
 *
 * **Called from the options page, deliberately, and from nowhere else.** The
 * two places that would catch it automatically both cost more than the fault.
 * The service worker would become a writer of these keys, and "the options
 * page is the only writer" is the premise the per-page mutation queue's
 * accepted race rests on (ADR 0022) — taking it away silently un-decides that
 * trade. `readSynced` would put a write to the synced area on the most
 * frequent path in the extension, widening the write-racing-a-disable hazard
 * where it is hardest to reason about. Repairing when someone opens Settings
 * is opportunistic rather than certain, and that is the right trade for a
 * transitional fault whose cost is one machine set up by hand.
 *
 * Goes through `writeSynced` rather than writing `sync` directly, which is
 * what makes it safe: it inherits the strict flag read, the mutation queue,
 * and the withdrawal if the flag has gone false by the time the write lands.
 * Not wrapped in `serialize` here — `writeSynced` queues, and queuing
 * something that awaits the queue deadlocks the chain.
 *
 * Answers whether it published anything, so the page can say why the shared
 * settings changed under it. */
export async function repairSyncedConfig(): Promise<boolean> {
  // Strict, and load-bearing: with sync off this must never publish. Stale
  // keys can linger in `sync` after a disable, and repairing one would put
  // the token back on Google's servers after the user took it off.
  if (!(await loadSyncEnabled())) return false;
  const [local, sync] = await Promise.all([
    chrome.storage.local.get(KEY),
    chrome.storage.sync.get(KEY),
  ]);
  if (!(KEY in sync)) return false;
  if (!keepsLocalConfig(KEY, sync[KEY], local[KEY])) return false;
  await writeSynced(KEY, local[KEY]);
  return true;
}

/** Copies synced values into the local mirror as Chrome delivers them, so the
 * mirror tracks changes instead of lagging behind this machine's last read.
 *
 * Without it the fallback is only ever the last value this machine happened to
 * observe: if it read v1, another machine saved v2 and then switched sync off,
 * this one would fall back to v1 — settings that are not merely old but wrong,
 * and wrong quietly, since a stale repository clips to the wrong destination
 * without complaint.
 *
 * **A removal must never be mirrored.** Switching sync off elsewhere arrives
 * here as the synced keys disappearing; copying that through would erase the
 * very copy this exists to preserve, turning the guard into the failure it was
 * written to prevent. Only a change carrying a real `newValue` is taken.
 *
 * Mirroring on read stays as well: a worker that has not run since sync was
 * enabled has seen no changes to mirror, and the two cover each other. */
export async function mirrorSyncedChange(changes: {
  [key: string]: chrome.storage.StorageChange;
}): Promise<void> {
  const updates: Record<string, unknown> = {};
  for (const key of SYNCED_KEYS) {
    const change = changes[key];
    if (change && change.newValue !== undefined) updates[key] = change.newValue;
  }
  if (Object.keys(updates).length === 0) return;
  // The read that decides and the write it decides on are one queued unit.
  // Queuing only the write would let a save land between them, exactly as it
  // did in `readSynced` before that was fixed.
  await serialize(async () => {
    if (KEY in updates) {
      const local = (await chrome.storage.local.get(KEY))[KEY];
      if (keepsLocalConfig(KEY, updates[KEY], local)) delete updates[KEY];
    }
    if (Object.keys(updates).length === 0) return;
    await chrome.storage.local.set(updates);
  });
}

/** Clears synced settings that outlived the switch being turned off.
 *
 * Disabling removes the keys on the machine that does it, but a save in flight
 * elsewhere can land afterwards and put them back. Whichever machine sees the
 * switch go off then takes them out again, so "sync is off" converges on "no
 * token in sync" rather than depending on which write happened to be last.
 *
 * **Only an explicit `false` counts.** Chrome does not promise to deliver the
 * keys and the flag in one batch, so during an *enable* a machine can receive
 * `tiroConfig` while its flag still reads the old value. Treating "flag is not
 * true" as a disable would delete the settings the enable just published and
 * break the case this whole feature exists for. A change carrying
 * `newValue === false` is unambiguous; nothing else is. */
export async function reconcileDisabledSync(changes: {
  [key: string]: chrome.storage.StorageChange;
}): Promise<void> {
  if (changes[SYNC_KEY]?.newValue !== false) return;
  await serialize(async () => {
    const stored = await chrome.storage.sync.get(SYNCED_KEYS);
    const lingering = SYNCED_KEYS.filter((key) => key in stored);
    if (lingering.length > 0) await chrome.storage.sync.remove(lingering);
  });
}

export async function loadConfig(): Promise<TiroExtensionConfig> {
  const config = ((await readSynced(KEY)) ??
    {}) as Partial<TiroExtensionConfig>;
  return {
    owner: config.owner ?? "",
    repo: config.repo ?? "",
    branch: config.branch ?? "main",
    token: config.token ?? "",
  };
}

export async function saveConfig(config: TiroExtensionConfig): Promise<void> {
  // Refused rather than stored, and the reason is not local to this machine.
  // With sync on, this write replaces the profile-wide copy, and every other
  // machine's worker mirrors the replacement down — `mirrorSyncedChange` takes
  // any change carrying a real `newValue`, and an empty config object is one.
  // So an empty save leaves no survivor: not the synced copy, not the mirror
  // that exists to stop settings being lost. And the form it came from is
  // indistinguishable from a first run, because that is exactly what a machine
  // whose Chrome Sync is not carrying extension data shows. `isConfigComplete`
  // is already the line the popup uses to decide this extension is set up;
  // nothing below it is worth storing, let alone publishing (ADR 0022).
  if (!isConfigComplete(config)) {
    throw new Error("refusing to store a config that cannot clip");
  }
  await writeSynced(KEY, config);
}

/** The fields a config needs before it can be used, in the order the form
 * shows them. `branch` is not one of them: it has a usable default. */
export type ConfigField = "owner" | "repo" | "token";

/** Takes `unknown` deliberately, because half its callers hand it a raw
 * `chrome.storage` value rather than something the type system has vouched
 * for. `loadConfig` explicitly tolerates a partial object written by an older
 * version, so an absent field is a real shape here — and typed as
 * `TiroExtensionConfig` this asked `undefined === ""`, answered no, and
 * counted a legacy `{owner, repo}` as complete. That is the one shape that
 * then gets uploaded to sync without a token. A non-string, and a `config`
 * that is null or not an object at all, have to answer the same way rather
 * than throwing on the property access. */
export function missingConfigFields(config: unknown): ConfigField[] {
  const stored = (
    typeof config === "object" && config !== null ? config : {}
  ) as Record<string, unknown>;
  return (["owner", "repo", "token"] as const).filter((field) => {
    const value = stored[field];
    return typeof value !== "string" || value === "";
  });
}

export function isConfigComplete(config: unknown): boolean {
  return missingConfigFields(config).length === 0;
}

/** Kept under its own key, not nested in the config object: the options page
 * saves a freshly built config, which would silently drop a language
 * preference nested inside it. */
export async function loadLanguage(): Promise<LanguageSetting> {
  const value = await readSynced(LANGUAGE_KEY);
  return value === "en" || value === "zh" ? value : "auto";
}

export async function saveLanguage(setting: LanguageSetting): Promise<void> {
  await writeSynced(LANGUAGE_KEY, setting);
}
/** Bump when the disclosure changes what it says about data handling: the Web
 * Store requires re-disclosing practice changes after install, and a bump is
 * what re-prompts an existing user.
 *
 * 2: the disclosure names arxiv.org, which the extension may now fetch a
 * paper's full text from. A new outbound destination is a practice change
 * whichever way the optional permission is answered, so the rule above applies
 * even though Chrome prompts for the permission separately.
 *
 * 3: settings sync (ADR 0022) can put the PAT in `chrome.storage.sync`, from
 * where Chrome replicates it to the user's other devices. By the same rule as
 * 2 that is a new destination — a stronger case than 2, since what travels is
 * a credential rather than a request, and it applies even though the option is
 * off by default and asked for separately.
 *
 * 4: the disclosure names raw.githubusercontent.com, which the extension may
 * now fetch a markdown file from (ADR 0023). Exactly the case 2 was, and
 * bumped for the same reason: a second outbound destination is a practice
 * change whichever way its optional permission is answered. */
export const DISCLOSURE_VERSION = 4;

export interface DisclosureState {
  /** Highest disclosure version the user has accepted; 0 if never. */
  version: number;
  acceptedAt: string;
}

/** Kept under its own key rather than inside the config object: the options
 * page saves a freshly built config (see options.ts `currentConfig`), which
 * would silently wipe an acceptance nested there and re-prompt on every save.
 *
 * Read and written straight to `local`, never synced: consent to read pages
 * belongs to an install, and carrying it across would let a fresh one skip the
 * disclosure before it first reads a page. One click per machine is a cheaper
 * price than that (ADR 0022). */
const DISCLOSURE_KEY = "tiroDisclosure";

export async function loadDisclosure(): Promise<DisclosureState> {
  const stored = await chrome.storage.local.get(DISCLOSURE_KEY);
  const state = (stored[DISCLOSURE_KEY] ?? {}) as Partial<DisclosureState>;
  return { version: state.version ?? 0, acceptedAt: state.acceptedAt ?? "" };
}

export async function acceptDisclosure(acceptedAt: string): Promise<void> {
  const state: DisclosureState = {
    version: DISCLOSURE_VERSION,
    acceptedAt,
  };
  await chrome.storage.local.set({ [DISCLOSURE_KEY]: state });
}

export function needsDisclosure(state: DisclosureState): boolean {
  return state.version < DISCLOSURE_VERSION;
}

/** Record of successful clips (slug → ISO timestamp), so the popup can
 * hint "already clipped" on open without asking GitHub — the disclosure
 * promises nothing is sent before the Clip click, and a popup-open probe
 * would break that promise. Blind to clips made on other machines, which is
 * acceptable for a hint: the clip flow still checks GitHub authoritatively
 * and a re-clip safely overwrites either way.
 *
 * Stays in `local` even with settings sync on, and not as a preference: this
 * is one key holding up to HISTORY_CAP entries, which sync would reject over
 * its 8,192-byte per-item cap long before the cap here was reached. */
export type ClipHistory = Record<string, string>;

const HISTORY_KEY = "tiroClipHistory";
const HISTORY_CAP = 500;

/** Drop the oldest entries past the cap so the record never grows unbounded.
 * Losing an old entry only costs its hint, nothing else. */
export function pruneClipHistory(
  history: ClipHistory,
  cap = HISTORY_CAP,
): ClipHistory {
  const entries = Object.entries(history);
  if (entries.length <= cap) return history;
  entries.sort((a, b) => a[1].localeCompare(b[1]));
  return Object.fromEntries(entries.slice(entries.length - cap));
}

async function loadClipHistory(): Promise<ClipHistory> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  return (stored[HISTORY_KEY] ?? {}) as ClipHistory;
}

/** Entries are scoped to the destination vault, so switching owner, repo or
 * branch cannot surface another vault's clips as hints. */
function historyKey(config: TiroExtensionConfig, slug: string): string {
  return `${config.owner}/${config.repo}#${config.branch}::${slug}`;
}

export async function recordClip(
  config: TiroExtensionConfig,
  slug: string,
  clippedAt: string,
): Promise<void> {
  const history = await loadClipHistory();
  history[historyKey(config, slug)] = clippedAt;
  await chrome.storage.local.set({
    [HISTORY_KEY]: pruneClipHistory(history),
  });
}

export async function lastClippedAt(
  config: TiroExtensionConfig,
  slug: string,
): Promise<string | null> {
  return (await loadClipHistory())[historyKey(config, slug)] ?? null;
}
