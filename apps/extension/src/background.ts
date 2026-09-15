// Clipping is driven entirely by the popup, which injects the clipper on
// demand (ADR 0005); the worker holds only work that must happen when no UI is
// open. Today that is two jobs, both about what the synced settings leave
// behind on a machine nobody is looking at (ADR 0022): keeping this machine's
// local copy current, so switching sync off elsewhere leaves it with the
// settings it had rather than whatever it last happened to read; and clearing
// synced settings that outlived the switch being turned off, so "sync is off"
// converges on "no token in sync".
import { mirrorSyncedChange, reconcileDisabledSync } from "./storage.ts";

// Registered at the top level, synchronously: MV3 only wakes a stopped service
// worker for listeners added that way, and a listener attached later would
// simply never fire.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  // Neither is worth an unhandled rejection in the worker: the read path
  // mirrors too, and the reconcile runs again on the next machine to see the
  // switch go off.
  void mirrorSyncedChange(changes).catch(() => {});
  void reconcileDisabledSync(changes).catch(() => {});
});
