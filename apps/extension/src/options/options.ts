import "@fontsource/spectral/latin-400.css";
import "@fontsource/spectral/latin-500.css";
import "@fontsource/spectral/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "../ui/tokens.css";
import "./options.css";
import { type ConnectionTestResult, testConnection } from "../github.ts";
import {
  getLocale,
  type LanguageSetting,
  type Locale,
  messages,
} from "../i18n.ts";
import {
  loadConfig,
  loadLanguage,
  loadSyncEnabled,
  saveConfig,
  saveLanguage,
  setSyncEnabled,
  type TiroExtensionConfig,
} from "../storage.ts";

const input = {
  owner: document.getElementById("owner") as HTMLInputElement,
  repo: document.getElementById("repo") as HTMLInputElement,
  branch: document.getElementById("branch") as HTMLInputElement,
  token: document.getElementById("token") as HTMLInputElement,
};
const label = {
  heading: document.getElementById("heading") as HTMLHeadingElement,
  owner: document.getElementById("label-owner") as HTMLSpanElement,
  repo: document.getElementById("label-repo") as HTMLSpanElement,
  branch: document.getElementById("label-branch") as HTMLSpanElement,
  token: document.getElementById("label-token") as HTMLSpanElement,
  tokenHint: document.getElementById("token-hint") as HTMLParagraphElement,
  language: document.getElementById("label-language") as HTMLSpanElement,
  sync: document.getElementById("label-sync") as HTMLSpanElement,
  syncHint: document.getElementById("sync-hint") as HTMLParagraphElement,
};
const languageSelect = document.getElementById("language") as HTMLSelectElement;
const syncCheckbox = document.getElementById("sync") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const testButton = document.getElementById("test") as HTMLButtonElement;
const result = document.getElementById("result") as HTMLParagraphElement;

/** Every control the form freezes together. At module scope because the sync
 * toggle needs the same treatment `init()` already gives the initial load: the
 * transition is several storage round-trips wide, and a Save landing inside it
 * can re-upload the config after the synced keys were removed and before the
 * flag flips — leaving the token in sync with sync reported off. */
const controls: { disabled: boolean }[] = [
  ...Object.values(input),
  languageSelect,
  syncCheckbox,
  saveButton,
  testButton,
];

function setControlsEnabled(enabled: boolean): void {
  for (const control of controls) control.disabled = !enabled;
}

// Replaced in init() before any user interaction can reach a handler.
let m = messages("en");
let savedLanguage: LanguageSetting = "auto";
/** The config as last painted from storage, so an edit can be told from a
 * value that merely came back from a read. */
let lastLoaded: TiroExtensionConfig = {
  owner: "",
  repo: "",
  branch: "main",
  token: "",
};

function currentConfig() {
  return {
    owner: input.owner.value.trim(),
    repo: input.repo.value.trim(),
    branch: input.branch.value.trim() || "main",
    token: input.token.value.trim(),
  };
}

function show(message: string, tone: "ok" | "error" | "warn"): void {
  result.textContent = message;
  result.className = tone;
}

function applyText(locale: Locale): void {
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  document.title = m.optionsTitle;
  label.heading.textContent = m.optionsTitle;
  label.owner.textContent = m.labelOwner;
  input.owner.placeholder = m.ownerPlaceholder;
  label.repo.textContent = m.labelRepo;
  input.repo.placeholder = m.repoPlaceholder;
  label.branch.textContent = m.labelBranch;
  label.token.textContent = m.labelToken;
  label.tokenHint.textContent = m.tokenHint;
  label.language.textContent = m.labelLanguage;
  label.sync.textContent = m.labelSync;
  label.syncHint.textContent = m.syncHint;
  const option: Record<LanguageSetting, string> = {
    auto: m.langAuto,
    en: m.langEn,
    zh: m.langZh,
  };
  for (const el of Array.from(languageSelect.options)) {
    el.textContent = option[el.value as LanguageSetting];
  }
  saveButton.textContent = m.saveButton;
  testButton.textContent = m.testButton;
}

function describeConnection(r: ConnectionTestResult): string {
  if (r.ok) return m.connOk(r.fullName);
  switch (r.reason) {
    case "not_found":
      return m.connNotFound;
    case "unauthorized":
      return m.connUnauthorized;
    case "http":
      return m.connHttp(r.status);
    case "network":
      return m.connNetwork(r.detail);
  }
}

/** Paints the stored config into the form, and records what it painted so a
 * later edit can be told apart from a value that came out of storage. Used on
 * load and after the sync toggle, which can change what "stored" means:
 * switching sync on adopts whatever the synced area already holds. */
async function fillConfig(): Promise<void> {
  const config = await loadConfig();
  lastLoaded = config;
  input.owner.value = config.owner;
  input.repo.value = config.repo;
  input.branch.value = config.branch;
  input.token.value = config.token;
}

async function fillLanguage(): Promise<void> {
  savedLanguage = await loadLanguage();
  languageSelect.value = savedLanguage;
}

/** Whether the form holds edits that have not been saved.
 *
 * The language select is never dirty — it writes on change — so this asks
 * about the config fields only. */
function formIsDirty(): boolean {
  const now = currentConfig();
  return (
    now.owner !== lastLoaded.owner ||
    now.repo !== lastLoaded.repo ||
    now.branch !== lastLoaded.branch ||
    now.token !== lastLoaded.token
  );
}

/** Says so when the settings in storage no longer match the ones on screen.
 *
 * Compares against the form rather than tracking whether this page caused the
 * write: after a save of our own the two already agree, so a self-inflicted
 * notice is impossible without any bookkeeping. Deliberately does not repaint
 * the config — the user may be mid-edit, and losing typed input to another
 * device's write would be worse than showing a stale field.
 *
 * The tickbox is the exception, because it reports stored state rather than
 * anything typed. Left alone it would keep claiming the token stays on this
 * machine while Save quietly uploaded it — the flag roams, so `saveConfig`
 * reads the new one whatever the box shows. It follows the flag, and the
 * notice says why it moved. */
async function announceRemoteChange(): Promise<void> {
  const [enabled, config, language] = await Promise.all([
    loadSyncEnabled(),
    loadConfig(),
    loadLanguage(),
  ]);
  const flagMoved = syncCheckbox.checked !== enabled;
  syncCheckbox.checked = enabled;
  const onScreen = currentConfig();
  const differs =
    onScreen.owner !== config.owner ||
    onScreen.repo !== config.repo ||
    onScreen.branch !== config.branch ||
    onScreen.token !== config.token ||
    language !== savedLanguage;
  if (differs || flagMoved) show(m.syncedElsewhere, "warn");
}

async function init(): Promise<void> {
  if (__DEV_FIXTURES__) {
    // A development build served outside the extension has no chrome.storage
    // to load from; `?preview` shows the empty form as it looks on first
    // open, which is what the store listing's screenshot captures. Removed
    // from production builds with the define.
    if (new URLSearchParams(location.search).has("preview")) {
      applyText("en");
      return;
    }
  }
  // Interacting while the stored values are still loading would go wrong in
  // both directions — a typed value or language pick clobbered by the late
  // load, or Save persisting a still-empty config — so the form stays inert
  // until the awaits settle.
  setControlsEnabled(false);
  try {
    syncCheckbox.checked = await loadSyncEnabled();
    await fillConfig();
    await fillLanguage();
    const locale = await getLocale();
    m = messages(locale);
    applyText(locale);
  } catch (error) {
    // The fields may still be empty — an enabled Save would let them
    // overwrite a good stored config — so the form stays inert, but says
    // why instead of sitting there dead. (m may still be the English
    // default here; the locale read failed along with everything else.)
    show(m.couldNotLoad(String(error)), "error");
    return;
  }
  setControlsEnabled(true);
  // Registered here rather than at module scope: the ?preview path above
  // returns before this, and that build has no chrome to add a listener to.
  chrome.storage.onChanged.addListener((_changes, areaName) => {
    // A failure here is a missed notice, not something to shout about — the
    // next interaction surfaces anything that really is broken.
    if (areaName === "sync") void announceRemoteChange().catch(() => {});
  });
}

syncCheckbox.addEventListener("change", () => {
  const enabled = syncCheckbox.checked;
  // Two failures with opposite right answers, so not `.then(ok, err)` — that
  // form does not catch a throw from its own success arm, which left a failed
  // repaint as an unhandled rejection with the status line still showing the
  // previous message.
  void (async () => {
    // Frozen for the whole transition: setSyncEnabled is several storage
    // round-trips, and a Save landing between the remove and the flag flip
    // would put the token back into sync after sync was switched off.
    setControlsEnabled(false);
    try {
      await setSyncEnabled(enabled);
    } catch (error) {
      // The write did not stick, so the tickbox is claiming something untrue
      // about where the token is: put it back.
      syncCheckbox.checked = !enabled;
      show(m.couldNotSave(String(error)), "error");
      setControlsEnabled(true);
      return;
    }
    try {
      // Switching on can adopt settings already in sync, language included,
      // so the form and the UI copy both have to follow — except over unsaved
      // edits. The natural first run is "type the credentials, tick sync,
      // press Save", and at tick time nothing is stored yet, so repainting
      // unconditionally wiped every field the user had just filled in.
      const keptEdits = formIsDirty();
      if (!keptEdits) await fillConfig();
      await fillLanguage();
      const locale = await getLocale();
      m = messages(locale);
      applyText(locale);
      const state = enabled ? m.syncOn : m.syncOff;
      show(keptEdits ? `${state} ${m.syncKeptEdits}` : state, "ok");
    } catch (error) {
      // The switch did take effect and only the repaint failed. Reverting the
      // tickbox would be the lie here, so leave it and say what happened.
      show(m.couldNotLoad(String(error)), "error");
    } finally {
      setControlsEnabled(true);
    }
  })();
});

languageSelect.addEventListener("change", () => {
  const setting = languageSelect.value as LanguageSetting;
  void saveLanguage(setting)
    .then(getLocale)
    .then((locale) => {
      savedLanguage = setting;
      m = messages(locale);
      applyText(locale);
      // A result phrased in the previous language would be stale; clear it.
      result.textContent = "";
      result.className = "";
    })
    .catch((error: unknown) => {
      // A selector showing a choice that did not stick would be a lie: put
      // the stored value back and say what happened.
      languageSelect.value = savedLanguage;
      show(m.couldNotSave(String(error)), "error");
    });
});

saveButton.addEventListener("click", () => {
  void saveConfig(currentConfig()).then(
    () => show(m.saved, "ok"),
    (error: unknown) => show(m.couldNotSave(String(error)), "error"),
  );
});

testButton.addEventListener("click", () => {
  const config = currentConfig();
  const missing = [
    config.owner === "" ? m.fieldOwner : null,
    config.repo === "" ? m.fieldRepo : null,
    config.token === "" ? m.fieldToken : null,
  ].filter((f) => f !== null);
  if (missing.length > 0) {
    show(m.fillFields(missing), "error");
    return;
  }
  show(m.testing, "ok");
  void testConnection(config).then((r) =>
    show(describeConnection(r), r.ok ? "ok" : "error"),
  );
});

void init();
