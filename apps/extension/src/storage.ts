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
