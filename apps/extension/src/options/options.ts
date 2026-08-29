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
  owner: document.getElementById("label-owner") as HTMLLabelElement,
  repo: document.getElementById("label-repo") as HTMLLabelElement,
  branch: document.getElementById("label-branch") as HTMLLabelElement,
  token: document.getElementById("label-token") as HTMLLabelElement,
  tokenHint: document.getElementById("token-hint") as HTMLDivElement,
  language: document.getElementById("label-language") as HTMLLabelElement,
};
const languageSelect = document.getElementById("language") as HTMLSelectElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const testButton = document.getElementById("test") as HTMLButtonElement;
const result = document.getElementById("result") as HTMLDivElement;

// Replaced in init() before any user interaction can reach a handler.
let m = messages("en");

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
  const config = await loadConfig();
  input.owner.value = config.owner;
  input.repo.value = config.repo;
  input.branch.value = config.branch;
  input.token.value = config.token;
  languageSelect.value = await loadLanguage();
  const locale = await getLocale();
  m = messages(locale);
  applyText(locale);
}

languageSelect.addEventListener("change", () => {
  const setting = languageSelect.value as LanguageSetting;
  void saveLanguage(setting)
    .then(getLocale)
    .then((locale) => {
      m = messages(locale);
      applyText(locale);
      // A result phrased in the previous language would be stale; clear it.
      result.textContent = "";
      result.className = "";
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
