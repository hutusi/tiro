import type { Messages } from "../i18n.ts";
import type { Tone } from "./view.ts";

/**
 * Remove from Tiro (ADR 0036), as a pure function — the same split `view.ts`
 * and `collections-view.ts` make, and shared by both: the popup offers Remove
 * on a page it clipped and on a Tiro article page, and the steps are the same
 * wherever it started.
 *
 * - `offered`: the link is on screen.
 * - `checking`: the vault is being asked what it holds at this slug.
 * - `confirming`: it holds the article; the confirmation names it.
 * - `removing`: the commit is being made.
 * - `removed`, `gone`: done — it was removed, or was not there to remove.
 *   The popup ends here: nothing else is offered for an article that is gone.
 * - `failed`: the lookup or the removal failed; the link is back, as a retry.
 */
export type RemovalStep =
  | "offered"
  | "checking"
  | "confirming"
  | "removing"
  | "removed"
  | "gone"
  | "failed";

export interface RemovalState {
  step: RemovalStep;
  /** `owner/repo`, named wherever the removal is described. */
  vault: string;
  /** The vault's own title for the article, from the lookup; null when it
   * has none the lookup could read. */
  title: string | null;
  /** The failure, already localized; only read in `failed`. */
  problem: string | null;
}

export interface RemovalView {
  /** The "Remove from Tiro…" link. */
  offer: { visible: boolean; label: string };
  /** The inline confirmation — never a browser dialog, which would block the
   * popup and anything driving it. */
  confirm: { text: string; confirmLabel: string; cancelLabel: string } | null;
  /** What is happening or has happened, under the confirmation's place. */
  status: { text: string; tone: Tone } | null;
  /** The header label while a removal is under way or done; null leaves the
   * page's own label. */
  label: { text: string; tone: Tone } | null;
  /** Checking, confirming or removing: everything else that acts on this
   * article stands down meanwhile. */
  active: boolean;
  /** Removed or gone: the popup ends here. */
  settled: boolean;
}

const NOTHING: RemovalView = {
  offer: { visible: false, label: "" },
  confirm: null,
  status: null,
  label: null,
  active: false,
  settled: false,
};

/**
 * `offerable` is the page's say in whether the link shows at all — a clip
 * mid-upload, a page still being read, a failed clip: none of those is a
 * moment to offer deleting what is in the vault. Once a removal is under way
 * the page no longer decides; a step past `offered` always shows.
 */
export function removalView(
  r: RemovalState | null | undefined,
  m: Messages,
  offerable = true,
): RemovalView {
  if (r === null || r === undefined) return NOTHING;
  const offer = { visible: false, label: m.removeOffer };
  switch (r.step) {
    case "offered":
      return { ...NOTHING, offer: { ...offer, visible: offerable } };
    case "checking":
      return {
        ...NOTHING,
        offer,
        status: { text: m.removeChecking, tone: "neutral" },
        active: true,
      };
    case "confirming":
      return {
        ...NOTHING,
        offer,
        confirm: {
          text: m.removeConfirm(r.vault, r.title),
          confirmLabel: m.removeConfirmButton,
          cancelLabel: m.removeCancel,
        },
        active: true,
      };
    case "removing":
      return {
        ...NOTHING,
        offer,
        status: { text: m.removing, tone: "neutral" },
        label: { text: m.labelRemoving, tone: "neutral" },
        active: true,
      };
    case "removed":
      return {
        ...NOTHING,
        offer,
        status: { text: m.removed(r.vault), tone: "ok" },
        label: { text: m.labelRemoved, tone: "ok" },
        settled: true,
      };
    case "gone":
      return {
        ...NOTHING,
        offer,
        status: { text: m.removeGone(r.vault), tone: "neutral" },
        label: { text: m.labelNotInVault, tone: "neutral" },
        settled: true,
      };
    case "failed":
      return {
        ...NOTHING,
        // The retry. Shown only where the page would offer it at all.
        offer: { ...offer, visible: offerable },
        status: r.problem === null ? null : { text: r.problem, tone: "error" },
      };
  }
}
