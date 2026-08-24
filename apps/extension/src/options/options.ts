import { testConnection } from "../github.ts";
import { loadConfig, saveConfig } from "../storage.ts";

const input = {
  owner: document.getElementById("owner") as HTMLInputElement,
  repo: document.getElementById("repo") as HTMLInputElement,
  branch: document.getElementById("branch") as HTMLInputElement,
  token: document.getElementById("token") as HTMLInputElement,
};
const saveButton = document.getElementById("save") as HTMLButtonElement;
const testButton = document.getElementById("test") as HTMLButtonElement;
const result = document.getElementById("result") as HTMLDivElement;

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

async function init(): Promise<void> {
  const config = await loadConfig();
  input.owner.value = config.owner;
  input.repo.value = config.repo;
  input.branch.value = config.branch;
  input.token.value = config.token;
}

saveButton.addEventListener("click", () => {
  void saveConfig(currentConfig()).then(
    () => show("Saved.", true),
    (error: unknown) => show(`Could not save: ${String(error)}`, false),
  );
});

testButton.addEventListener("click", () => {
  const config = currentConfig();
  const missing = [
    config.owner === "" ? "owner" : null,
    config.repo === "" ? "repository" : null,
    config.token === "" ? "token" : null,
  ].filter((f) => f !== null);
  if (missing.length > 0) {
    show(`Fill in the ${missing.join(", ")} field(s) first.`, false);
    return;
  }
  show("Testing…", true);
  void testConnection(config).then(({ ok, message }) => show(message, ok));
});

void init();
