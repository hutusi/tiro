import type { FetchSourceKind, Messages } from "../i18n.ts";

/**
 * What the popup shows, as a pure function of what it knows.
 *
 * popup.ts owns the async story — the tab, the clipper, the publisher fetch,
 * the upload — and keeps its facts in a `PopupState`. This module turns that into
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
  /** Read from the publisher rather than from the tab — the notice says
   * which. */
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
  /**
   * The publisher whose document could be fetched for this tab, or null for an
   * ordinary page. Selects every string the fetch flow uses, so adding one is
   * a message-table entry rather than a branch in here.
   */
  source: FetchSourceKind | null;
  /** Clip waits until the fetch decision is settled. */
  gated: boolean;
  /** The fetch button is on offer — permission not granted, not yet
   * clicked. */
  fetchOffered: boolean;
  /** The document is being fetched right now. */
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
  /** The button that asks for the publisher permission and fetches. Its label
   * names the document, so it comes from here rather than from the one-time
   * localize pass, which runs before the tab's URL has been looked at. */
  sourceFetch: { visible: boolean; label: string };
  /** `primary` is false when the page was clipped before: opening it in Tiro
   * is then the likelier intent, and Re-clip steps back to an outline. */
  clip: { visible: boolean; enabled: boolean; primary: boolean; label: string };
  links: (PopupLinks & { hint: boolean }) | null;
}

/** Phases an in-flight fetch may repaint. See the derivation below. */
const FETCH_OVERRIDES: ReadonlySet<Phase> = new Set(["ready", "blocked"]);

export function popupView(s: PopupState, m: Messages): PopupView {
  // Null on an ordinary page, where none of these strings are reachable: every
  // one of them is behind `s.source !== null` by way of `gated`, `fetching` or
  // `fetchOffered`, which only a publisher rule ever sets.
  const source = s.source === null ? null : m.fetchSources[s.source];
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
          notice:
            s.preview.fromFetch && source !== null
              ? source.notice
              : m.noticePreview,
        };
  /**
   * An in-flight fetch is what the popup is *doing*, whatever phase was last
   * assigned. Derived here rather than assigned there because a body arriving
   * mid-fetch settles the phase on its way in — so pressing Fetch before the
   * tab reported hid the fetch behind whatever verdict that body carried, with
   * no button, no progress, and a gated Clip until the request came back.
   *
   * `blocked` belongs in that set, and leaving it out is what left the bug half
   * fixed: a *tab* verdict — this is a PDF, this could not be read, this never
   * answered — is not settled while the fetch that would replace it is still
   * running. That fetch is the only thing that can clear such a screen.
   *
   * `s.configured` keeps the setup instruction in front of everything, since it
   * is the one block a fetch cannot clear. The refusal cannot collide here at
   * all: it needs a resolved attempt, and a fetch in flight has just replaced
   * the attempt with a fresh one. `clipping`, `saved` and `failed` are left
   * alone because a commit and a fetch cannot overlap — Clip only opens once a
   * fetch has resolved, and no retry is offered after that.
   */
  const phase: Phase =
    s.fetching && s.configured && FETCH_OVERRIDES.has(s.phase)
      ? "reading"
      : s.phase;
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
    // A tab already showing the document has nothing to fetch; the offer stays
    // only while the gate is waiting on it. Not before Settings are complete
    // either: a clip cannot follow, and the setup block would swallow the
    // fetching feedback, so the click would look like it did nothing.
    sourceFetch: {
      visible:
        s.configured && s.fetchOffered && (s.preview === null || s.gated),
      label: source?.button ?? "",
    },
    clip: clipDisabled,
    links: null,
  };

  switch (phase) {
    case "blocked": {
      const error = s.problem?.error === true;
      return {
        ...base,
        label: error ? (s.configured ? m.labelCannotClip : m.labelSetUp) : "",
        labelTone: error ? "error" : "neutral",
        message: s.problem?.text ?? null,
        messageTone: error ? "error" : "neutral",
        // A page this cannot clip may still *have* a clip, and that is exactly
        // when the reader wants it: a blob page Tiro refuses is usually one
        // whose file is already in the vault. The `ready` branch has always
        // offered these; blocking should not take them away.
        links:
          s.clippedOn !== null && s.links !== null
            ? { ...s.links, hint: true }
            : null,
      };
    }
    case "reading": {
      // A fetch says so once: in the message where a card is on screen for it
      // to sit under, and in the skeleton's caption where there is none —
      // because the caption there otherwise claims the page is being
      // extracted, which during a fetch is not what is happening.
      const fetched = s.fetching ? (source?.fetching ?? null) : null;
      return {
        ...base,
        label: m.labelReading,
        message: preview === null ? null : fetched,
        loading: preview === null ? (fetched ?? m.loadingExtract) : null,
      };
    }
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
          ? (source?.offer ?? null)
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
  // Through `pathname` so a branch like `release#1` is encoded rather than
  // read as a fragment; `/` survives, which is what a branch path needs.
  const url = new URL("https://github.com/");
  url.pathname = `/${config.owner}/${config.repo}/blob/${config.branch}/${path}`;
  return url.toString();
}
