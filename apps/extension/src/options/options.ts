import "@fontsource/spectral/latin-400.css";
import "@fontsource/spectral/latin-500.css";
import "@fontsource/spectral/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "../ui/tokens.css";
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
  saveConfig,
  saveLanguage,
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
};
const languageSelect = document.getElementById("language") as HTMLSelectElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const testButton = document.getElementById("test") as HTMLButtonElement;
const result = document.getElementById("result") as HTMLParagraphElement;

// Replaced in init() before any user interaction can reach a handler.
let m = messages("en");
let savedLanguage: LanguageSetting = "auto";

function currentConfig() {
  return {
    owner: input.owner.value.trim(),
    repo: input.repo.value.trim(),
    branch: input.branch.value.trim() || "main",
    token: input.token.value.trim(),
  };
}

function show(message: string, ok: boolean): void {
  result.textContent = message;
  result.className = ok ? "ok" : "error";
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

async function init(): Promise<void> {
  // Interacting while the stored values are still loading would go wrong in
  // both directions — a typed value or language pick clobbered by the late
  // load, or Save persisting a still-empty config — so the form stays inert
  // until the awaits settle.
  const controls = [
    ...Object.values(input),
    languageSelect,
    saveButton,
    testButton,
  ];
  for (const control of controls) control.disabled = true;
  try {
    const config = await loadConfig();
    input.owner.value = config.owner;
    input.repo.value = config.repo;
    input.branch.value = config.branch;
    input.token.value = config.token;
    savedLanguage = await loadLanguage();
    languageSelect.value = savedLanguage;
    const locale = await getLocale();
    m = messages(locale);
    applyText(locale);
  } catch (error) {
    // The fields may still be empty — an enabled Save would let them
    // overwrite a good stored config — so the form stays inert, but says
    // why instead of sitting there dead. (m may still be the English
    // default here; the locale read failed along with everything else.)
    show(m.couldNotLoad(String(error)), false);
    return;
  }
  for (const control of controls) control.disabled = false;
}

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
      show(m.couldNotSave(String(error)), false);
    });
});

saveButton.addEventListener("click", () => {
  void saveConfig(currentConfig()).then(
    () => show(m.saved, true),
    (error: unknown) => show(m.couldNotSave(String(error)), false),
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
    show(m.fillFields(missing), false);
    return;
  }
  show(m.testing, true);
  void testConnection(config).then((r) => show(describeConnection(r), r.ok));
});

void init();
