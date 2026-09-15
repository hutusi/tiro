// Clipping is driven entirely by the popup, which injects the clipper on
// demand (ADR 0005); the worker holds only work that must happen when no UI is
// open. Today that is one job: keeping each machine's local copy of the synced
// settings current, so switching sync off from another machine leaves this one
// with the settings it had rather than with whatever it last happened to read
// (ADR 0022).
import { mirrorSyncedChange } from "./storage.ts";

// Registered at the top level, synchronously: MV3 only wakes a stopped service
// worker for listeners added that way, and a listener attached later would
// simply never fire.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  // A missed mirror is not worth an unhandled rejection in the worker; the
  // read path mirrors too, so the next read repairs it.
  void mirrorSyncedChange(changes).catch(() => {});
});
