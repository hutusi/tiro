/**
 * A stand-in for `chrome.storage`, which exists only inside the extension.
 *
 * Deliberately closer to the real API than the tests strictly need: `get`
 * accepts the string / array / null forms the real one does and omits keys
 * that are absent (rather than returning them as `undefined`), because the
 * loaders in `src/storage.ts` lean on `?? default` for exactly that case, and
 * a mock that always returned the key would hide a loader that stopped
 * defaulting. `remove` is here because disabling settings sync depends on it.
 */
export interface StorageAreaMock {
  /** The backing object, exposed so a test can seed or assert on it directly. */
  data: Record<string, unknown>;
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface ChromeStorageMock {
  local: StorageAreaMock;
  sync: StorageAreaMock;
}

function makeArea(): StorageAreaMock {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys) {
      if (keys === undefined || keys === null) return { ...data };
      const wanted = typeof keys === "string" ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const key of wanted) {
        if (key in data) out[key] = data[key];
      }
      return out;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) {
        delete data[key];
      }
    },
    async clear() {
      for (const key of Object.keys(data)) delete data[key];
    },
  };
}

/**
 * Installs a fresh `chrome.storage` on `globalThis` and hands back both areas.
 *
 * Call this from `beforeEach`, never from the `describe` body: describe bodies
 * all run at registration, so a per-block install leaves every test in the file
 * sharing whichever block was registered last — the order dependency this
 * helper exists to remove.
 */
export function installChromeStorage(): ChromeStorageMock {
  const local = makeArea();
  const sync = makeArea();
  (globalThis as { chrome?: unknown }).chrome = { storage: { local, sync } };
  return { local, sync };
}
