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
      popupView(state({ preview: { ...preview, fromFetch: true } }), m).preview
        ?.notice,
    ).toBe(m.arxivNotice);
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
    const v = popupView(state({ phase: "reading", fetching: true }), m);
    expect(v.loading).toBeNull();
    expect(v.preview).not.toBeNull();
    expect(v.message).toBe(m.arxivFetching);
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
        phase: "blocked",
        preview: null,
        problem: { text: m.arxivOffer, error: false },
        gated: true,
        fetchOffered: true,
      }),
      m,
    );
    expect(v.label).toBe("");
    expect(v.labelTone).toBe("neutral");
    expect(v.message).toBe(m.arxivOffer);
    expect(v.arxivFetch).toBe(true);
  });

  test("arXiv gated: tab previewed, fetch offered, Clip waits", () => {
    const v = popupView(state({ gated: true, fetchOffered: true }), m);
    expect(v.label).toBe("");
    expect(v.message).toBe(m.arxivOffer);
    expect(v.arxivFetch).toBe(true);
    expect(v.clip.enabled).toBe(false);
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
    expect(v.arxivFetch).toBe(false);
    expect(v.message).toBe(m.settingsFirst);
  });

  test("the fetch offer disappears once the gate is open", () => {
    const v = popupView(state({ gated: false, fetchOffered: true }), m);
    expect(v.arxivFetch).toBe(false);
    expect(v.clip.enabled).toBe(true);
  });

  test("a standing note rides with the preview", () => {
    const v = popupView(state({ note: m.arxivDenied }), m);
    expect(v.preview?.note).toBe(m.arxivDenied);
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
});
