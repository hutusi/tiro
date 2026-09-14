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

/** Whether the user has opted settings into Chrome sync. Off unless they say
 * otherwise: turning it on uploads the PAT to Google's servers and pushes it
 * to every machine on the profile, which is the user's call to make and not a
 * default to inherit (ADR 0022).
 *
 * A failed read answers "off" rather than throwing. That is the safe
 * direction: writes are mirrored to `local` unconditionally, so falling back
 * to `local` always finds current settings, whereas throwing would leave the
 * popup with no config at all. */
export async function loadSyncEnabled(): Promise<boolean> {
  try {
    const stored = await chrome.storage.sync.get(SYNC_KEY);
    return stored[SYNC_KEY] === true;
  } catch {
    return false;
  }
}

/** The area to read a synced key from. Writes never use this — they go to
 * `local` always and to `sync` as well when enabled, so `local` stays a warm
 * mirror and turning sync off can never look like a wipe. */
async function readArea(): Promise<chrome.storage.StorageArea> {
  return (await loadSyncEnabled()) ? chrome.storage.sync : chrome.storage.local;
}

/** Reads one synced key, preferring `sync` when enabled but falling back to
 * `local` when it holds nothing yet — the window after the toggle goes on and
 * before Chrome has pushed anything down. */
async function readSynced(key: string): Promise<unknown> {
  const area = await readArea();
  const stored = await area.get(key);
  if (key in stored) return stored[key];
  if (area === chrome.storage.local) return undefined;
  return (await chrome.storage.local.get(key))[key];
}

/** Writes one synced key to `local`, and to `sync` too when enabled. */
async function writeSynced(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
  if (await loadSyncEnabled()) {
    await chrome.storage.sync.set({ [key]: value });
  }
}

/** Turns settings sync on or off, moving the synced keys across.
 *
 * Enabling does not overwrite a value `sync` already holds. That is what makes
 * the headline case work: on a second machine `sync` already carries the
 * settings, so flipping the toggle joins them rather than clobbering them with
 * the empty form the user is looking at. Only keys `sync` lacks are pushed up.
 *
 * Disabling copies `sync` down before removing anything, so no device is left
 * without settings, then clears the keys from `sync` — that removal is what
 * actually takes the token off Google's servers, so it is the point of the
 * operation rather than tidying after it. */
export async function setSyncEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    const [local, sync] = await Promise.all([
      chrome.storage.local.get(SYNCED_KEYS),
      chrome.storage.sync.get(SYNCED_KEYS),
    ]);
    const push: Record<string, unknown> = {};
    for (const key of SYNCED_KEYS) {
      if (!(key in sync) && key in local) push[key] = local[key];
    }
    await chrome.storage.sync.set({ ...push, [SYNC_KEY]: true });
    return;
  }
  const sync = await chrome.storage.sync.get(SYNCED_KEYS);
  const keep: Record<string, unknown> = {};
  for (const key of SYNCED_KEYS) {
    if (key in sync) keep[key] = sync[key];
  }
  if (Object.keys(keep).length > 0) await chrome.storage.local.set(keep);
  await chrome.storage.sync.remove(SYNCED_KEYS);
  await chrome.storage.sync.set({ [SYNC_KEY]: false });
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
  await writeSynced(KEY, config);
}

export function isConfigComplete(config: TiroExtensionConfig): boolean {
  return config.owner !== "" && config.repo !== "" && config.token !== "";
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
 * off by default and asked for separately. */
export const DISCLOSURE_VERSION = 3;

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
