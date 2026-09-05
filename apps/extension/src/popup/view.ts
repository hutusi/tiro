import type { Messages } from "../i18n.ts";

/**
 * What the popup shows, as a pure function of what it knows.
 *
 * popup.ts owns the async story — the tab, the clipper, the arXiv fetch, the
 * upload — and keeps its facts in a `PopupState`. This module turns that into
 * a `PopupView` the DOM can be painted from in one place. Pure, so every state
 * the popup can be in is a test case rather than a page to find in the wild
 * (the popup has no DOM harness, see test/popup-view.test.ts).
 */
export type Phase =
  | "blocked"
  | "reading"
  | "ready"
  | "clipping"
  | "saved"
  | "failed";

export type Tone = "neutral" | "ok" | "error";

/** The article body on screen, reduced to what the preview card shows. */
export interface PreviewFacts {
  title: string;
  host: string;
  words: number;
  minutes: number;
  excerpt: string;
  readabilityFailed: boolean;
  /** Read from arxiv.org rather than the tab — the notice says which. */
  fromFetch: boolean;
}

export interface PopupLinks {
  /** The article on the site — exists once the vault workflow has run. */
  site: string;
  /** The committed file on GitHub — exists the moment the PUT returns. */
  vault: string;
}

export interface PopupState {
  phase: Phase;
  configured: boolean;
  preview: PreviewFacts | null;
  /** The sentence for a blocked or failed phase, already localized. `error`
   * separates a failure from a neutral wait — an arXiv PDF whose full text
   * can still be fetched is blocked, but nothing has gone wrong. */
  problem: { text: string; error: boolean } | null;
  /** The local clip record's date, formatted, when this page was clipped from
   * this machine before. */
  clippedOn: string | null;
  /** Saved phase: the PUT overwrote an existing article. */
  updated: boolean;
  /** arXiv: Clip waits until the full-text decision is settled. */
  gated: boolean;
  /** arXiv: the fetch button is on offer — permission not granted, not yet
   * clicked. */
  fetchOffered: boolean;
  /** arXiv: the full text is being fetched right now. */
  fetching: boolean;
  /** A note that outlives any one body: a declined permission, a failed
   * fetch, an abstract-only paper. */
  note: string | null;
  links: PopupLinks | null;
}

export interface PopupView {
  /** Short header label ("Saved ✓", "Reading…"); empty when nothing fits. */
  label: string;
  labelTone: Tone;
  /** The full sentence under the card, or null. */
  message: string | null;
  messageTone: Tone;
  /** Skeleton caption while the page is being read and nothing is on screen. */
  loading: string | null;
  /** Progress caption while the upload runs; the preview stays visible. */
  progress: string | null;
  preview: {
    meta: string;
    title: string;
    excerpt: string | null;
    warning: string | null;
    note: string | null;
    notice: string;
  } | null;
  arxivFetch: boolean;
  /** `primary` is false when the page was clipped before: opening it in Tiro
   * is then the likelier intent, and Re-clip steps back to an outline. */
  clip: { visible: boolean; enabled: boolean; primary: boolean; label: string };
  links: (PopupLinks & { hint: boolean }) | null;
}

export function popupView(s: PopupState, m: Messages): PopupView {
  const preview =
    s.preview === null
      ? null
      : {
          meta: m.articleMeta(
            s.preview.host,
            s.preview.minutes,
            s.preview.words,
          ),
          title: s.preview.title,
          excerpt:
            s.preview.excerpt.trim() === "" ? null : s.preview.excerpt.trim(),
          warning: s.preview.readabilityFailed ? m.warningReadability : null,
          note: s.note,
          notice: s.preview.fromFetch ? m.arxivNotice : m.noticePreview,
        };
  const reclip = s.clippedOn !== null;
  const clipLabel = reclip ? m.reclipButton : m.clipButton;
  const clipDisabled = {
    visible: true,
    enabled: false,
    primary: !reclip,
    label: clipLabel,
  };
  const base: PopupView = {
    label: "",
    labelTone: "neutral",
    message: null,
    messageTone: "neutral",
    loading: null,
    progress: null,
    preview,
    // A tab already showing the paper has nothing to fetch; the offer stays
    // only while the gate is waiting on it. Not before Settings are complete
    // either: a clip cannot follow, and the setup block would swallow the
    // fetching feedback, so the click would look like it did nothing.
    arxivFetch:
      s.configured && s.fetchOffered && (s.preview === null || s.gated),
    clip: clipDisabled,
    links: null,
  };

  switch (s.phase) {
    case "blocked": {
      const error = s.problem?.error === true;
      return {
        ...base,
        label: error ? (s.configured ? m.labelCannotClip : m.labelSetUp) : "",
        labelTone: error ? "error" : "neutral",
        message: s.problem?.text ?? null,
        messageTone: error ? "error" : "neutral",
      };
    }
    case "reading":
      return {
        ...base,
        label: m.labelReading,
        message: s.fetching ? m.arxivFetching : null,
        loading: preview === null ? m.loadingExtract : null,
      };
    case "ready": {
      const clippedOn = s.clippedOn;
      return {
        ...base,
        label: s.gated
          ? ""
          : clippedOn === null
            ? m.labelReady
            : m.labelSavedOn(clippedOn),
        message: s.gated
          ? m.arxivOffer
          : clippedOn === null
            ? m.readyToClip
            : m.alreadyClipped(clippedOn),
        clip: {
          visible: true,
          enabled: s.configured && !s.gated,
          primary: !reclip,
          label: clipLabel,
        },
        // The local record says the page was clipped, not that the site has
        // published it — a reopen seconds after a clip is the common case — so
        // the hint stays.
        links:
          clippedOn !== null && s.links !== null
            ? { ...s.links, hint: true }
            : null,
      };
    }
    case "clipping":
      return { ...base, label: m.labelSaving, progress: m.loadingSave };
    case "saved":
      return {
        ...base,
        label: s.updated ? m.labelUpdated : m.labelSaved,
        labelTone: "ok",
        message: s.updated ? m.updatedExisting : m.clipped,
        messageTone: "ok",
        clip: {
          visible: false,
          enabled: false,
          primary: !reclip,
          label: clipLabel,
        },
        links: s.links === null ? null : { ...s.links, hint: true },
      };
    case "failed":
      return {
        ...base,
        label: m.labelFailed,
        labelTone: "error",
        message: s.problem?.text ?? null,
        messageTone: "error",
        // The one path where pressing Clip again is the right move.
        clip: {
          visible: true,
          enabled: s.configured && !s.gated,
          primary: !reclip,
          label: clipLabel,
        },
      };
  }
}

/** The article's page on the site, from the manifest's homepage. The page
 * exists only after the vault workflow has processed and deployed the clip,
 * which the hint beside the link says. */
export function articleUrl(homepage: string, slug: string): string {
  return new URL(`articles/${slug}/`, homepage).toString();
}

export function vaultFileUrl(
  config: { owner: string; repo: string; branch: string },
  path: string,
): string {
  return `https://github.com/${config.owner}/${config.repo}/blob/${config.branch}/${path}`;
}
