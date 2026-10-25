import type { Messages } from "../i18n.ts";
import type { Tone } from "./view.ts";

/**
 * "Add missing lead" (ADR 0053), as a pure function — the split `view.ts`
 * and `removal-view.ts` make.
 *
 * - `offered`: the button is on screen, where the page allows it.
 * - `adding`: the vault's copy is being read, merged and committed.
 * - `added`: committed; the site shows it once processing translates it.
 * - `unchanged`: the vault's copy already had every part of the lead.
 * - `absent`: there is no article at this page's slug to add it to.
 * - `refused`: `mergeLead` would not — the page no longer begins where the
 *   saved article does, or the lead would read differently there.
 * - `failed`: GitHub said no; the button is back, as a retry.
 */
export type LeadStep =
  | "offered"
  | "adding"
  | "added"
  | "unchanged"
  | "absent"
  | "refused"
  | "failed";

export interface LeadState {
  step: LeadStep;
  /** `owner/repo`, named wherever the outcome is described. */
  vault: string;
  /** The failure, already localized; only read in `failed`. */
  problem: string | null;
}

export interface LeadView {
  offer: { visible: boolean; enabled: boolean; label: string; hint: string };
  /** What happened, under the buttons. */
  status: { text: string; tone: Tone } | null;
  /** Adding: nothing else may write this article meanwhile. */
  active: boolean;
}

const NOTHING: LeadView = {
  offer: { visible: false, enabled: false, label: "", hint: "" },
  status: null,
  active: false,
};

/**
 * `offerable` is the page's say: the page was clipped from here before, its
 * clip recovered a lead, and nothing else is under way. Once the button has
 * been pressed the page no longer decides — the outcome always shows.
 */
export function leadView(
  l: LeadState | null | undefined,
  m: Messages,
  offerable: boolean,
): LeadView {
  if (l === null || l === undefined) return NOTHING;
  const offer = {
    visible: false,
    enabled: true,
    label: m.leadOffer,
    hint: m.leadOfferHint,
  };
  switch (l.step) {
    case "offered":
      return { ...NOTHING, offer: { ...offer, visible: offerable } };
    case "adding":
      return {
        ...NOTHING,
        offer: { ...offer, visible: true, enabled: false, label: m.leadAdding },
        active: true,
      };
    case "added":
      return { ...NOTHING, status: { text: m.leadAdded(l.vault), tone: "ok" } };
    case "unchanged":
      return {
        ...NOTHING,
        status: { text: m.leadUnchanged(l.vault), tone: "neutral" },
      };
    case "absent":
      return {
        ...NOTHING,
        status: { text: m.leadAbsent(l.vault), tone: "neutral" },
      };
    case "refused":
      return { ...NOTHING, status: { text: m.leadRefused, tone: "neutral" } };
    case "failed":
      return {
        ...NOTHING,
        offer: { ...offer, visible: offerable },
        status: l.problem === null ? null : { text: l.problem, tone: "error" },
      };
  }
}
