import type { Messages } from "../i18n.ts";
import type { PopupLinks, Tone } from "./view.ts";

/**
 * Save as site (ADR 0055), as a pure function — the split `lead-view.ts`
 * and `removal-view.ts` make.
 *
 * - `offered`: the button sits beside Clip, where the page allows it.
 * - `capturing`: the picture of the tab is being taken, then the vault asked
 *   whether this page is already a site.
 * - `form`: the picture, the title and the note box, and Save.
 * - `saving`: the commit is being made.
 * - `saved`: committed; the site shows it once processing has introduced it.
 * - `failed`: the picture or the commit failed. With a picture in hand the
 *   form is back, as a retry that does not take it again; without one the
 *   button is.
 */
export type SiteStep =
  | "offered"
  | "capturing"
  | "form"
  | "saving"
  | "saved"
  | "failed";

export interface SiteState {
  step: SiteStep;
  /** `owner/repo`, named wherever the outcome is described. */
  vault: string;
  /** The vault already holds this page as a site: Save replaces it. */
  existing: boolean;
  /** The picture taken, as a URL the popup can show, once there is one. */
  shot: string | null;
  /** The page's own description, to show under the picture. */
  description: string | null;
  /** The failure, already localized; only read in `failed`. */
  problem: string | null;
  /** Saved: where the site is. */
  links: PopupLinks | null;
  /** Saved: a site was replaced rather than created. */
  updated: boolean;
}

/** What the page says about offering it, from the popup's own state. */
export interface SiteOffer {
  /** Nothing else is under way and the page can be pictured. */
  offerable: boolean;
  /** The clip found little text — a tool, not an article — so saving it as a
   * site is the main action rather than the second. */
  thin: boolean;
  /** This machine saved the page as a site before, formatted. */
  savedOn: string | null;
}

export interface SiteView {
  offer: { visible: boolean; primary: boolean; label: string; hint: string };
  form: {
    heading: string;
    shot: string | null;
    description: string | null;
    titleLabel: string;
    noteLabel: string;
    notePlaceholder: string;
    saveLabel: string;
    cancelLabel: string;
    /** Saving: the fields and buttons wait. */
    busy: boolean;
  } | null;
  /** What is happening or has happened, under the form's place. */
  status: { text: string; tone: Tone } | null;
  /** The header label while the site flow has the popup; null leaves the
   * page's own. */
  label: { text: string; tone: Tone } | null;
  links: (PopupLinks & { hint: boolean }) | null;
  /** Capturing, the form, saving, or done: the popup is about the site now,
   * and Clip, Remove and the rest stand down. */
  active: boolean;
}

const NOTHING: SiteView = {
  offer: { visible: false, primary: false, label: "", hint: "" },
  form: null,
  status: null,
  label: null,
  links: null,
  active: false,
};

export function siteView(
  s: SiteState | null | undefined,
  m: Messages,
  page: SiteOffer,
): SiteView {
  if (s === null || s === undefined) return NOTHING;
  const offer = {
    visible: false,
    primary: page.thin,
    label: m.siteOffer,
    hint: m.siteOfferHint,
  };
  const form = (busy: boolean): SiteView["form"] => ({
    heading: m.siteHeading,
    shot: s.shot,
    description:
      s.description === null ? null : m.siteDescription(s.description),
    titleLabel: m.siteTitleLabel,
    noteLabel: m.siteNoteLabel,
    notePlaceholder: m.siteNotePlaceholder,
    saveLabel: s.existing ? m.siteUpdate : m.siteSave,
    cancelLabel: m.siteCancel,
    busy,
  });
  const formLabel = { text: m.labelSiteForm, tone: "neutral" as const };
  switch (s.step) {
    case "offered":
      return {
        ...NOTHING,
        offer: { ...offer, visible: page.offerable },
        status:
          page.offerable && page.savedOn !== null
            ? { text: m.siteSavedOn(page.savedOn), tone: "neutral" }
            : null,
      };
    case "capturing":
      return {
        ...NOTHING,
        status: { text: m.siteCapturing, tone: "neutral" },
        label: { text: m.labelSiteCapturing, tone: "neutral" },
        active: true,
      };
    case "form":
      return {
        ...NOTHING,
        form: form(false),
        status: s.existing ? { text: m.siteExisting, tone: "neutral" } : null,
        label: formLabel,
        active: true,
      };
    case "saving":
      return {
        ...NOTHING,
        form: form(true),
        status: { text: m.siteSaving, tone: "neutral" },
        label: { text: m.labelSaving, tone: "neutral" },
        active: true,
      };
    case "saved":
      return {
        ...NOTHING,
        status: {
          text: s.updated ? m.siteUpdated(s.vault) : m.siteSaved(s.vault),
          tone: "ok",
        },
        label: {
          text: s.updated ? m.labelUpdated : m.labelSaved,
          tone: "ok",
        },
        links: s.links === null ? null : { ...s.links, hint: true },
        active: true,
      };
    case "failed":
      return s.shot === null
        ? {
            // Nothing taken yet: the button is the retry.
            ...NOTHING,
            offer: { ...offer, visible: page.offerable },
            status:
              s.problem === null ? null : { text: s.problem, tone: "error" },
          }
        : {
            ...NOTHING,
            form: form(false),
            status:
              s.problem === null ? null : { text: s.problem, tone: "error" },
            label: { text: m.labelFailed, tone: "error" },
            active: true,
          };
  }
}

/** The site's page on the Tiro site, from the manifest's homepage — under
 * `/sites/`, never the article's `/articles/` of the same slug. */
export function siteUrl(homepage: string, slug: string): string {
  return new URL(`sites/${slug}/`, homepage).toString();
}
