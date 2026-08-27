export interface TiroExtensionConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

const KEY = "tiroConfig";

export async function loadConfig(): Promise<TiroExtensionConfig> {
  const stored = await chrome.storage.local.get(KEY);
  const config = (stored[KEY] ?? {}) as Partial<TiroExtensionConfig>;
  return {
    owner: config.owner ?? "",
    repo: config.repo ?? "",
    branch: config.branch ?? "main",
    token: config.token ?? "",
  };
}

export async function saveConfig(config: TiroExtensionConfig): Promise<void> {
  await chrome.storage.local.set({ [KEY]: config });
}

export function isConfigComplete(config: TiroExtensionConfig): boolean {
  return config.owner !== "" && config.repo !== "" && config.token !== "";
}

/** Bump when the disclosure changes what it says about data handling: the Web
 * Store requires re-disclosing practice changes after install, and a bump is
 * what re-prompts an existing user. */
export const DISCLOSURE_VERSION = 1;

export interface DisclosureState {
  /** Highest disclosure version the user has accepted; 0 if never. */
  version: number;
  acceptedAt: string;
}

/** Kept under its own key rather than inside the config object: the options
 * page saves a freshly built config (see options.ts `currentConfig`), which
 * would silently wipe an acceptance nested there and re-prompt on every save. */
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

/** Local record of successful clips (slug → ISO timestamp), so the popup can
 * hint "already clipped" on open without asking GitHub — the disclosure
 * promises nothing is sent before the Clip click, and a popup-open probe
 * would break that promise. Blind to clips made on other machines, which is
 * acceptable for a hint: the clip flow still checks GitHub authoritatively
 * and a re-clip safely overwrites either way. */
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

export async function recordClip(
  slug: string,
  clippedAt: string,
): Promise<void> {
  const history = await loadClipHistory();
  history[slug] = clippedAt;
  await chrome.storage.local.set({
    [HISTORY_KEY]: pruneClipHistory(history),
  });
}

export async function hasClipped(slug: string): Promise<boolean> {
  return slug in (await loadClipHistory());
}
