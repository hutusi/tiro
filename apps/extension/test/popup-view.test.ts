import { describe, expect, test } from "bun:test";
import { messages } from "../src/i18n.ts";
import {
  articleUrl,
  type PopupState,
  popupView,
  vaultFileUrl,
} from "../src/popup/view.ts";

const m = messages("en");

const preview = {
  title: "Writing, Briefly",
  host: "paulgraham.com",
  words: 2300,
  minutes: 9,
  excerpt:
    "  I think it's far more important to write well than most people realize.  ",
  readabilityFailed: false,
  fromFetch: false,
};

const links = {
  site: "https://tiro.ainaive.com/articles/paulgraham-com-writing44-12345678/",
  vault:
    "https://github.com/o/r/blob/main/articles/paulgraham-com-writing44-12345678/index.md",
};

function state(overrides: Partial<PopupState> = {}): PopupState {
  return {
    phase: "ready",
    configured: true,
    preview,
    problem: null,
    source: null,
    clippedOn: null,
    updated: false,
    gated: false,
    fetchOffered: false,
    fetching: false,
    note: null,
    links: null,
    ...overrides,
  };
}

describe("popupView", () => {
  test("ready: preview, Ready label, Clip enabled", () => {
    const v = popupView(state(), m);
    expect(v.label).toBe(m.labelReady);
    expect(v.message).toBe(m.readyToClip);
    expect(v.clip).toEqual({
      visible: true,
      enabled: true,
      primary: true,
      label: m.clipButton,
    });
    expect(v.preview?.meta).toBe("paulgraham.com · 9 min · 2,300 words");
    expect(v.preview?.excerpt).toBe(
      "I think it's far more important to write well than most people realize.",
    );
    expect(v.preview?.notice).toBe(m.noticePreview);
    expect(v.links).toBeNull();
    expect(v.loading).toBeNull();
  });

  test("an empty excerpt is not shown", () => {
    const v = popupView(state({ preview: { ...preview, excerpt: "  " } }), m);
    expect(v.preview?.excerpt).toBeNull();
  });

  test("readability failure shows the warning; a fetched body says so", () => {
    expect(
      popupView(state({ preview: { ...preview, readabilityFailed: true } }), m)
        .preview?.warning,
    ).toBe(m.warningReadability);
    expect(
      popupView(
        state({ source: "arxiv", preview: { ...preview, fromFetch: true } }),
        m,
      ).preview?.notice,
    ).toBe(m.fetchSources.arxiv.notice);
  });

  test("already clipped: dated label, Re-clip, both links — hint kept", () => {
    const v = popupView(state({ clippedOn: "Sep 2, 2026", links }), m);
    expect(v.label).toBe(m.labelSavedOn("Sep 2, 2026"));
    expect(v.message).toBe(m.alreadyClipped("Sep 2, 2026"));
    expect(v.clip.label).toBe(m.reclipButton);
    expect(v.clip.enabled).toBe(true);
    // Opening the saved article is the likelier intent; Re-clip steps back.
    expect(v.clip.primary).toBe(false);
    // A local record proves a clip, not a deploy: the page may still be on
    // its way to the site.
    expect(v.links).toEqual({ ...links, hint: true });
  });

  test("reading: skeleton with a caption, Clip disabled", () => {
    const v = popupView(state({ phase: "reading", preview: null }), m);
    expect(v.label).toBe(m.labelReading);
    expect(v.loading).toBe(m.loadingExtract);
    expect(v.preview).toBeNull();
    expect(v.clip).toEqual({
      visible: true,
      enabled: false,
      primary: true,
      label: m.clipButton,
    });
  });

  test("reading with a body on screen keeps the preview and drops the skeleton", () => {
    const v = popupView(
      state({ source: "arxiv", phase: "reading", fetching: true }),
      m,
    );
    expect(v.loading).toBeNull();
    expect(v.preview).not.toBeNull();
    expect(v.message).toBe(m.fetchSources.arxiv.fetching);
  });

  test("clipping: Saving… with the progress caption, preview stays, Clip disabled", () => {
    const v = popupView(state({ phase: "clipping" }), m);
    expect(v.label).toBe(m.labelSaving);
    expect(v.progress).toBe(m.loadingSave);
    expect(v.preview).not.toBeNull();
    expect(v.clip.enabled).toBe(false);
    expect(v.links).toBeNull();
  });

  test("saved: green label, both links with the hint, Clip hidden", () => {
    const v = popupView(state({ phase: "saved", links }), m);
    expect(v.label).toBe(m.labelSaved);
    expect(v.labelTone).toBe("ok");
    expect(v.message).toBe(m.clipped);
    expect(v.clip.visible).toBe(false);
    expect(v.links).toEqual({ ...links, hint: true });
  });

  test("saved over an existing article says Updated", () => {
    const v = popupView(state({ phase: "saved", updated: true, links }), m);
    expect(v.label).toBe(m.labelUpdated);
    expect(v.message).toBe(m.updatedExisting);
  });

  test("failed: error tone, the error sentence, Clip re-enabled for a retry", () => {
    const v = popupView(
      state({
        phase: "failed",
        problem: { text: m.errTokenInvalid, error: true },
      }),
      m,
    );
    expect(v.label).toBe(m.labelFailed);
    expect(v.labelTone).toBe("error");
    expect(v.message).toBe(m.errTokenInvalid);
    expect(v.messageTone).toBe("error");
    expect(v.clip.enabled).toBe(true);
    expect(v.links).toBeNull();
  });

  test("not configured: Set up label, Clip never enabled, preview may still show", () => {
    const v = popupView(
      state({
        phase: "blocked",
        configured: false,
        problem: { text: m.settingsFirst, error: true },
      }),
      m,
    );
    expect(v.label).toBe(m.labelSetUp);
    expect(v.message).toBe(m.settingsFirst);
    expect(v.clip.enabled).toBe(false);
    expect(v.preview).not.toBeNull();
  });

  test("a PDF is blocked with Cannot clip and no preview", () => {
    const v = popupView(
      state({
        phase: "blocked",
        preview: null,
        problem: { text: m.cannotClipPdf, error: true },
      }),
      m,
    );
    expect(v.label).toBe(m.labelCannotClip);
    expect(v.preview).toBeNull();
    expect(v.clip.enabled).toBe(false);
  });

  test("an arXiv PDF is blocked but not an error: the fetch is offered", () => {
    const v = popupView(
      state({
        source: "arxiv",
        phase: "blocked",
        preview: null,
        problem: { text: m.fetchSources.arxiv.offer, error: false },
        gated: true,
        fetchOffered: true,
      }),
      m,
    );
    expect(v.label).toBe("");
    expect(v.labelTone).toBe("neutral");
    expect(v.message).toBe(m.fetchSources.arxiv.offer);
    expect(v.sourceFetch.visible).toBe(true);
  });

  test("arXiv gated: tab previewed, fetch offered, Clip waits", () => {
    const v = popupView(
      state({ source: "arxiv", gated: true, fetchOffered: true }),
      m,
    );
    expect(v.label).toBe("");
    expect(v.message).toBe(m.fetchSources.arxiv.offer);
    expect(v.sourceFetch.visible).toBe(true);
    expect(v.clip.enabled).toBe(false);
  });

  // The same flow, the other publisher. Everything that differs is a string,
  // which is what moving them behind `source` was for.
  test("GitHub gated: the offer names the file, not a paper", () => {
    const v = popupView(
      state({ source: "github", gated: true, fetchOffered: true }),
      m,
    );
    expect(v.message).toBe(m.fetchSources.github.offer);
    expect(v.sourceFetch.visible).toBe(true);
    expect(v.sourceFetch.label).toBe(m.fetchSources.github.button);
    expect(v.clip.enabled).toBe(false);
  });

  test("a fetched GitHub body says where it came from", () => {
    const v = popupView(
      state({ source: "github", preview: { ...preview, fromFetch: true } }),
      m,
    );
    expect(v.preview?.notice).toBe(m.fetchSources.github.notice);
  });

  // An ordinary page reaches none of the fetch strings, and the button it
  // would sit on has no label to show.
  test("a page with no publisher rule shows no fetch button", () => {
    const v = popupView(state({ gated: true, fetchOffered: true }), m);
    expect(v.sourceFetch.label).toBe("");
    expect(v.message).toBeNull();
  });

  test("the fetch is not offered until Settings are complete", () => {
    const v = popupView(
      state({
        phase: "blocked",
        configured: false,
        problem: { text: m.settingsFirst, error: true },
        gated: true,
        fetchOffered: true,
      }),
      m,
    );
    expect(v.sourceFetch.visible).toBe(false);
    expect(v.message).toBe(m.settingsFirst);
  });

  test("the fetch offer disappears once the gate is open", () => {
    const v = popupView(state({ gated: false, fetchOffered: true }), m);
    expect(v.sourceFetch.visible).toBe(false);
    expect(v.clip.enabled).toBe(true);
  });

  test("a standing note rides with the preview", () => {
    const v = popupView(state({ note: m.fetchSources.arxiv.denied }), m);
    expect(v.preview?.note).toBe(m.fetchSources.arxiv.denied);
  });

  test("Chinese table formats the meta line in its own units", () => {
    const v = popupView(state(), messages("zh"));
    expect(v.preview?.meta).toBe("paulgraham.com · 9 分钟 · 2300 词");
  });
});

describe("links", () => {
  test("articleUrl joins the manifest homepage and the slug", () => {
    expect(articleUrl("https://tiro.ainaive.com/", "a-b-12345678")).toBe(
      "https://tiro.ainaive.com/articles/a-b-12345678/",
    );
  });

  test("vaultFileUrl points at the committed file on GitHub", () => {
    expect(
      vaultFileUrl(
        { owner: "o", repo: "r", branch: "main" },
        "articles/a-b-12345678/index.md",
      ),
    ).toBe("https://github.com/o/r/blob/main/articles/a-b-12345678/index.md");
  });

  test("vaultFileUrl encodes a branch that would otherwise start a fragment", () => {
    expect(
      vaultFileUrl(
        { owner: "o", repo: "r", branch: "release#1" },
        "articles/a-b-12345678/index.md",
      ),
    ).toBe(
      "https://github.com/o/r/blob/release%231/articles/a-b-12345678/index.md",
    );
    // Slashes in a branch are path separators on GitHub, and stay.
    expect(
      vaultFileUrl({ owner: "o", repo: "r", branch: "feat/x" }, "a/index.md"),
    ).toBe("https://github.com/o/r/blob/feat/x/a/index.md");
  });
});

describe("popupView, a document that cannot be reached", () => {
  const RAW = "https://raw.githubusercontent.com/o/r/main/docs/GUIDE.md";

  /**
   * The screen the refusal produces. Blocked rather than ready, because the
   * body on screen is GitHub's rendering of the file and committing it would
   * replace the file's own clip — and the offer stays, because a denial can be
   * reconsidered and a failure retried.
   */
  test("blocks, keeps the preview, and re-offers the fetch", () => {
    const v = popupView(
      state({
        source: "github",
        phase: "blocked",
        problem: { text: m.fetchSources.github.instead(RAW), error: true },
        note: m.fetchSources.github.denied,
        gated: true,
        fetchOffered: true,
      }),
      m,
    );
    expect(v.label).toBe(m.labelCannotClip);
    expect(v.labelTone).toBe("error");
    expect(v.message).toContain(RAW);
    expect(v.clip.enabled).toBe(false);
    expect(v.sourceFetch.visible).toBe(true);
    expect(v.sourceFetch.label).toBe(m.fetchSources.github.button);
    // The card stays: it names which file is being refused, and carries the
    // cause while the message line carries the remedy.
    expect(v.preview).not.toBeNull();
    expect(v.preview?.note).toBe(m.fetchSources.github.denied);
  });

  // A page Tiro refuses is usually one whose file is already in the vault,
  // which is exactly when the reader wants the link to it.
  test("still links to the clip the page already has", () => {
    const v = popupView(
      state({
        phase: "blocked",
        problem: { text: m.cannotClipPdf, error: true },
        clippedOn: "Sep 2, 2026",
        links,
      }),
      m,
    );
    expect(v.links).toEqual({ ...links, hint: true });
  });
});

describe("popupView while a fetch is in flight", () => {
  /**
   * Pressing Fetch before the tab reported used to hide the fetch: the tab's
   * body arrives, settles the phase to `ready` on its way in, and the ready
   * screen never looks at `fetching` — so the caption vanished, the button was
   * already spent, and Clip stayed gated with nothing on screen saying why.
   */
  test("a body arriving mid-fetch does not hide the fetch", () => {
    const v = popupView(
      state({ source: "github", phase: "ready", fetching: true, gated: true }),
      m,
    );
    expect(v.label).toBe(m.labelReading);
    expect(v.message).toBe(m.fetchSources.github.fetching);
    expect(v.preview).not.toBeNull();
  });

  /**
   * The half that was missed the first time. A *tab* verdict — this is a PDF,
   * this could not be read, this never answered — is not settled while the
   * fetch that would replace it is still running, and that fetch is the only
   * thing that can clear the screen. Blocking on it left the popup offering to
   * fetch what it was already fetching, with no button and no progress.
   */
  test("a PDF verdict arriving mid-fetch does not hide the fetch", () => {
    const v = popupView(
      state({
        source: "arxiv",
        phase: "blocked",
        preview: null,
        problem: { text: m.fetchSources.arxiv.offer, error: false },
        fetching: true,
      }),
      m,
    );
    expect(v.label).toBe(m.labelReading);
    // No card to sit under, so the caption carries it — and does not claim the
    // page is being extracted, which is not what is happening.
    expect(v.loading).toBe(m.fetchSources.arxiv.fetching);
    expect(v.message).toBeNull();
  });

  // The one block a fetch cannot clear: there is nowhere to clip to yet, so
  // the setup instruction stays in front of it.
  test("does not repaint the setup instruction as reading", () => {
    const v = popupView(
      state({
        source: "arxiv",
        configured: false,
        phase: "blocked",
        problem: { text: m.settingsFirst, error: true },
        fetching: true,
      }),
      m,
    );
    expect(v.label).toBe(m.labelSetUp);
    expect(v.message).toBe(m.settingsFirst);
  });

  // A commit cannot overlap a fetch — Clip only opens once one has resolved,
  // and no retry is offered after that — but these stay settled regardless.
  test.each(["clipping", "saved", "failed"] as const)(
    "does not repaint a %s screen as reading",
    (phase) => {
      const v = popupView(
        state({
          source: "github",
          phase,
          fetching: true,
          problem: { text: m.cannotClip, error: true },
        }),
        m,
      );
      expect(v.message).not.toBe(m.fetchSources.github.fetching);
    },
  );

  // The fetch is over; the popup has stopped reading.
  test("stops reading once the fetch resolves", () => {
    const v = popupView(
      state({ source: "arxiv", phase: "ready", fetching: false }),
      m,
    );
    expect(v.label).toBe(m.labelReady);
    expect(v.clip.enabled).toBe(true);
  });

  /**
   * The state `settleFetch` has to produce after a declined arXiv fetch: the
   * attempt is over, the tab's body is a fair article, and Clip must be
   * usable. Left in `reading` — which is what `fetchDocument` set when the
   * attempt began — the button stayed disabled with nothing left to re-enable
   * it, because the tab had already reported.
   */
  test("a declined arXiv fetch leaves a usable Clip", () => {
    const v = popupView(
      state({
        source: "arxiv",
        phase: "ready",
        fetching: false,
        gated: false,
        note: m.fetchSources.arxiv.denied,
      }),
      m,
    );
    expect(v.clip.enabled).toBe(true);
    expect(v.preview?.note).toBe(m.fetchSources.arxiv.denied);
  });
});
