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
