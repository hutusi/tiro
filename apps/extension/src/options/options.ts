import "@fontsource/spectral/latin-400.css";
import "@fontsource/spectral/latin-500.css";
import "@fontsource/spectral/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "../ui/tokens.css";
import "./options.css";
import {
  localDocumentUrl,
  PDF_MAX_PAGES,
  PDF_MIN_CHARS_PER_PAGE,
  PDF_MIN_PAGE_COVERAGE,
  slugForUrl,
} from "@tiro/shared";
import { buildClipFile } from "../clip.ts";
import {
  type ConnectionTestResult,
  daysUntil,
  encodeBase64Utf8,
  findExistingIndex,
  putFile,
  TOKEN_EXPIRY_WARN_DAYS,
  testConnection,
} from "../github.ts";
import {
  getLocale,
  type LanguageSetting,
  type Locale,
  messages,
} from "../i18n.ts";
import {
  type ConfigField,
  isConfigComplete,
  loadConfig,
  loadLanguage,
  loadSyncEnabled,
  missingConfigFields,
  repairSyncedConfig,
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
  importHeading: document.getElementById(
    "import-heading",
  ) as HTMLHeadingElement,
  importHint: document.getElementById("import-hint") as HTMLParagraphElement,
};
const languageSelect = document.getElementById("language") as HTMLSelectElement;
const syncCheckbox = document.getElementById("sync") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const testButton = document.getElementById("test") as HTMLButtonElement;
const result = document.getElementById("result") as HTMLParagraphElement;
const importButton = document.getElementById("import") as HTMLButtonElement;
const fileInput = document.getElementById("pdf-file") as HTMLInputElement;
const importResult = document.getElementById(
  "import-result",
) as HTMLParagraphElement;

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
  // Not optional: this one writes to GitHub, so a Save landing mid-import is
  // exactly the race the note above describes.
  importButton,
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

/** The labels for the fields a config is missing. Built at call time, not
 * once: `m` is replaced whenever the language changes. */
function fieldNames(fields: ConfigField[]): string[] {
  const name: Record<ConfigField, string> = {
    owner: m.fieldOwner,
    repo: m.fieldRepo,
    token: m.fieldToken,
  };
  return fields.map((field) => name[field]);
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
  label.importHeading.textContent = m.importHeading;
  label.importHint.textContent = m.importHint;
  importButton.textContent = m.importButton;
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

/** A date as the reader's calendar has it, which is the one they will
 * compare with GitHub's token page. */
function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The sentence about the token's expiry, and whether it should warn — a
 * separate step from `describeConnection` so a warning can recolour a
 * connection that otherwise succeeded. */
function describeExpiry(
  expiresAt: Date,
  now: Date,
): { text: string; warn: boolean } {
  const days = daysUntil(expiresAt, now);
  const date = localDay(expiresAt);
  return days < TOKEN_EXPIRY_WARN_DAYS
    ? { text: m.connTokenExpiresSoon(date, days), warn: true }
    : { text: m.connTokenExpires(date, days), warn: false };
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
  // Opportunistic, and the only place it happens: a config an older machine
  // left in sync that cannot clip is invisible to every configured machine
  // and empties the ones arriving fresh, and nothing else ever clears it.
  // Deliberately after the form is live rather than blocking the load — it
  // changes nothing on screen, since what is painted is this machine's copy
  // and that is exactly what gets published. A failure here leaves the
  // residue for the next visit, which is no worse than not having looked.
  void repairSyncedConfig()
    .then((repaired) => {
      if (repaired) show(m.syncRepaired, "warn");
    })
    .catch(() => {});
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
  const config = currentConfig();
  // Says which fields are missing rather than letting `saveConfig` refuse
  // with a bare error. The refusal itself lives there, not here, because it
  // is not about this form: with sync on, an empty save replaces the
  // profile-wide copy and every other machine mirrors the blank down.
  const missing = missingConfigFields(config);
  if (missing.length > 0) {
    show(m.fillFields(fieldNames(missing)), "error");
    return;
  }
  void saveConfig(config).then(
    () => {
      // The baseline moves with the save. Left behind, the form counted as
      // dirty from the first save onwards, so every later toggle called
      // already-stored values unsaved and refused to repaint them.
      lastLoaded = config;
      show(m.saved, "ok");
    },
    (error: unknown) => show(m.couldNotSave(String(error)), "error"),
  );
});

testButton.addEventListener("click", () => {
  const config = currentConfig();
  const missing = missingConfigFields(config);
  if (missing.length > 0) {
    show(m.fillFields(fieldNames(missing)), "error");
    return;
  }
  show(m.testing, "ok");
  void testConnection(config).then((r) => {
    if (!r.ok) {
      show(describeConnection(r), "error");
      return;
    }
    // A token with no expiry, or a header this page cannot read, says
    // nothing about it rather than guessing.
    if (r.expiresAt === undefined) {
      show(describeConnection(r), "ok");
      return;
    }
    const expiry = describeExpiry(r.expiresAt, new Date());
    show(
      `${describeConnection(r)} ${expiry.text}`,
      expiry.warn ? "warn" : "ok",
    );
  });
});

/** Paint the import line, which keeps its own status separate from the
 * settings form's — the two say different things and both can matter. */
function showImport(text: string, tone?: "ok" | "error"): void {
  importResult.textContent = text;
  importResult.className = tone ?? "";
}

importButton.addEventListener("click", () => {
  const config = currentConfig();
  // Checked here rather than after a file is chosen: asking someone to pick a
  // document and only then saying the vault is not set up wastes the pick.
  if (!isConfigComplete(config)) {
    showImport(m.importNeedsSettings, "error");
    return;
  }
  // Reset first, so choosing the same file twice still fires `change`.
  fileInput.value = "";
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file === undefined) return;
  void importPdf(file);
});

/**
 * Read a PDF off disk and commit it as an article (ADR 0027).
 *
 * Extraction happens here rather than in the processor because the processor
 * cannot reach this file: it runs in CI, and the bytes exist only on this
 * machine. So the extension does the part that needs the file — extract, judge,
 * strip the furniture while it still has pages — and commits the text. The
 * model pass that turns it into Markdown still happens where every other
 * article's does.
 *
 * The gates run here for a second reason: there is a person to tell. A scan
 * refused now is a sentence on screen; refused in CI it is an article that
 * sits pending and says nothing.
 */
async function importPdf(file: File): Promise<void> {
  const name = file.name;
  if (!/\.pdf$/i.test(name) && file.type !== "application/pdf") {
    showImport(m.importNotPdf, "error");
    return;
  }

  setControlsEnabled(false);
  showImport(m.importReading(name));
  try {
    // Lazy, and load-bearing: pdf.js is 1.7 MB and this page must not pay for
    // it until someone actually picks a file. A static import would put it on
    // every open of Settings.
    const { extractPdfText, joinPdfPages, pdfMarkdown, stripRunningFurniture } =
      await import("@tiro/shared/pdf");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const { pages, totalPages, layout } = await extractPdfText(bytes, {
      maxPages: PDF_MAX_PAGES,
      minCharsPerPage: PDF_MIN_CHARS_PER_PAGE,
      minPageCoverage: PDF_MIN_PAGE_COVERAGE,
    });

    // Where the document's typography says what its structure is, the import
    // has already finished the job and commits Markdown (ADR 0028). It then
    // leaves `pdfUnstructured` unset, which is how the processor knows there is
    // nothing left to restructure — no new field, and no LLM needed for the
    // article to be readable.
    //
    // Where it does not, the flat text and its page separators go as before
    // and the structure pass runs in the processor.
    const structured = layout.legible;

    const url = localDocumentUrl(name);
    const slug = await slugForUrl(url);
    const config = currentConfig();
    showImport(m.importSaving(name));

    // The same carry-forward a re-clip does, with a different default: an
    // imported document starts unlisted, and a decision to unhide it survives
    // the next import (ADR 0017, ADR 0027).
    const existing = await findExistingIndex(config, slug);
    const clip = {
      url,
      title: name.replace(/\.pdf$/i, ""),
      markdown: structured
        ? pdfMarkdown(layout)
        : joinPdfPages(stripRunningFurniture(pages)),
      clippedAt: new Date().toISOString(),
      clipperVersion: chrome.runtime.getManifest().version,
      clipperCommit: __CLIPPER_COMMIT__,
      sourceMedia: "pdf" as const,
      // Said beside the body rather than worked out later (ADR 0027), and only
      // where it is true.
      pdfUnstructured: !structured,
      unlisted: existing?.unlisted ?? true,
    };
    const built = await buildClipFile(clip);
    await putFile(config, {
      path: built.path,
      contentBase64: encodeBase64Utf8(built.content),
      message: `import: ${built.title}`,
      ...(existing !== null ? { sha: existing.sha } : {}),
      resolveConflict: async () => {
        const again = await findExistingIndex(config, slug);
        const rebuilt = await buildClipFile({
          ...clip,
          unlisted: again?.unlisted ?? true,
        });
        return {
          ...(again !== null ? { sha: again.sha } : {}),
          contentBase64: encodeBase64Utf8(rebuilt.content),
        };
      },
    });
    showImport(
      existing === null
        ? m.importSaved(`${name} (${totalPages}p)`)
        : m.importUpdated(name),
      "ok",
    );
  } catch (error) {
    showImport(m.importFailed(String(error)), "error");
  } finally {
    setControlsEnabled(true);
  }
}

void init();
