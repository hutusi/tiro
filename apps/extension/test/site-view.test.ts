import { describe, expect, test } from "bun:test";
import { messages } from "../src/i18n.ts";
import { type SiteState, siteUrl, siteView } from "../src/popup/site-view.ts";
import { type PopupState, popupView } from "../src/popup/view.ts";

/** ADR 0055: Save as site in the popup, as pure functions. */

const m = messages("en");
const VAULT = "o/r";

function site(overrides: Partial<SiteState> = {}): SiteState {
  return {
    step: "offered",
    vault: VAULT,
    existing: false,
    shot: null,
    description: null,
    problem: null,
    links: null,
    updated: false,
    ...overrides,
  };
}

const page = { offerable: true, thin: false, savedOn: null };

describe("siteView", () => {
  test("offered: a second button beside Clip on an ordinary page", () => {
    const v = siteView(site(), m, page);
    expect(v.offer).toEqual({
      visible: true,
      primary: false,
      label: m.siteOffer,
      hint: m.siteOfferHint,
    });
    expect(v.form).toBeNull();
    expect(v.active).toBe(false);
  });

  test("a thin page makes it the main action", () => {
    expect(siteView(site(), m, { ...page, thin: true }).offer.primary).toBe(
      true,
    );
  });

  test("hidden where the page does not allow it", () => {
    expect(
      siteView(site(), m, { ...page, offerable: false }).offer.visible,
    ).toBe(false);
  });

  test("says when this machine saved it as a site before", () => {
    expect(
      siteView(site(), m, { ...page, savedOn: "Oct 20" }).status?.text,
    ).toBe(m.siteSavedOn("Oct 20"));
  });

  test("the form shows the picture, the page's description, and Save", () => {
    const v = siteView(
      site({ step: "form", shot: "blob:shot", description: "A map." }),
      m,
      page,
    );
    expect(v.form?.shot).toBe("blob:shot");
    expect(v.form?.description).toBe(m.siteDescription("A map."));
    expect(v.form?.saveLabel).toBe(m.siteSave);
    expect(v.form?.busy).toBe(false);
    expect(v.active).toBe(true);
  });

  test("a site already in the vault is updated, and says so", () => {
    const v = siteView(
      site({ step: "form", shot: "blob:shot", existing: true }),
      m,
      page,
    );
    expect(v.form?.saveLabel).toBe(m.siteUpdate);
    expect(v.status?.text).toBe(m.siteExisting);
  });

  test("saving keeps the form, busy", () => {
    const v = siteView(site({ step: "saving", shot: "blob:shot" }), m, page);
    expect(v.form?.busy).toBe(true);
    expect(v.status?.text).toBe(m.siteSaving);
  });

  test("saved: where it went, and the links", () => {
    const links = {
      site: "https://tiro.example/sites/x-1234abcd/",
      vault: "https://github.com/o/r/blob/main/sites/x-1234abcd/index.md",
    };
    const v = siteView(site({ step: "saved", links }), m, page);
    expect(v.status).toEqual({ text: m.siteSaved(VAULT), tone: "ok" });
    expect(v.links).toEqual({ ...links, hint: true });
    expect(v.label?.text).toBe(m.labelSaved);
  });

  // With a picture in hand the retry is the form, which commits the same
  // picture; without one the button is the retry, and takes it again.
  test("a failure keeps the form only when there is a picture to keep", () => {
    const kept = siteView(
      site({ step: "failed", shot: "blob:shot", problem: "GitHub said no" }),
      m,
      page,
    );
    expect(kept.form).not.toBeNull();
    expect(kept.status).toEqual({ text: "GitHub said no", tone: "error" });
    const none = siteView(
      site({ step: "failed", problem: m.siteShotBlank }),
      m,
      page,
    );
    expect(none.form).toBeNull();
    expect(none.offer.visible).toBe(true);
    expect(none.active).toBe(false);
  });

  test("a site's page is under /sites/, never /articles/", () => {
    expect(siteUrl("https://tiro.example/", "x-1234abcd")).toBe(
      "https://tiro.example/sites/x-1234abcd/",
    );
  });
});

function state(overrides: Partial<PopupState> = {}): PopupState {
  return {
    phase: "ready",
    configured: true,
    preview: {
      title: "Battles",
      host: "maps.example.org",
      words: 12,
      minutes: 1,
      excerpt: "",
      readabilityFailed: true,
      fromFetch: false,
    },
    problem: null,
    source: null,
    clippedOn: null,
    updated: false,
    gated: false,
    fetchOffered: false,
    fetching: false,
    note: null,
    pdfStub: false,
    links: null,
    site: site(),
    ...overrides,
  };
}

describe("popupView, with Save as site", () => {
  test("an ordinary page offers it beside a primary Clip", () => {
    const v = popupView(state(), m);
    expect(v.site.offer.visible).toBe(true);
    expect(v.site.offer.primary).toBe(false);
    expect(v.clip.primary).toBe(true);
    expect(v.message).toBe(m.readyToClip);
  });

  test("a thin page says so, and puts the site first", () => {
    const v = popupView(state({ thin: true }), m);
    expect(v.message).toBe(m.thinPage);
    expect(v.site.offer.primary).toBe(true);
    expect(v.clip.primary).toBe(false);
    expect(v.clip.enabled).toBe(true);
  });

  // The dead end this replaces: a page with nothing to clip.
  test("a page with nothing to clip offers the site instead", () => {
    const v = popupView(
      state({
        phase: "blocked",
        preview: null,
        thin: true,
        problem: { text: m.nothingToClipSite, error: false },
      }),
      m,
    );
    expect(v.message).toBe(m.nothingToClipSite);
    expect(v.messageTone).toBe("neutral");
    expect(v.site.offer.visible).toBe(true);
    expect(v.site.offer.primary).toBe(true);
  });

  test("not while the page is read or fetched, nor before Settings", () => {
    expect(popupView(state({ phase: "reading" }), m).site.offer.visible).toBe(
      false,
    );
    expect(popupView(state({ fetching: true }), m).site.offer.visible).toBe(
      false,
    );
    expect(popupView(state({ configured: false }), m).site.offer.visible).toBe(
      false,
    );
  });

  test("the form takes the popup: no preview, no Clip, no Remove", () => {
    const v = popupView(
      state({
        site: site({ step: "form", shot: "blob:shot" }),
        clippedOn: "Oct 1",
        removal: {
          step: "offered",
          vault: VAULT,
          title: null,
          problem: null,
        },
      }),
      m,
    );
    expect(v.preview).toBeNull();
    expect(v.clip.visible).toBe(false);
    expect(v.remove.offer.visible).toBe(false);
    expect(v.site.form).not.toBeNull();
    expect(v.label).toBe(m.labelSiteForm);
  });

  test("once saved, Remove is offered for the site, and the links are the site's", () => {
    const links = {
      site: "https://tiro.example/sites/x-1234abcd/",
      vault: "https://github.com/o/r/blob/main/sites/x-1234abcd/index.md",
    };
    const v = popupView(
      state({
        site: site({ step: "saved", links }),
        removal: {
          step: "offered",
          vault: VAULT,
          title: null,
          problem: null,
          kind: "site",
        },
      }),
      m,
    );
    expect(v.links).toEqual({ ...links, hint: true });
    expect(v.remove.offer.visible).toBe(true);
    expect(v.remove.offer.hint).toBe(m.removeSiteOfferHint);
  });

  test("a site's removal is worded for a site", () => {
    const v = popupView(
      state({
        removal: {
          step: "confirming",
          vault: VAULT,
          title: "A map",
          problem: null,
          kind: "site",
        },
      }),
      m,
    );
    expect(v.remove.confirm?.heading).toBe(m.removeSiteConfirmHeading);
    expect(v.remove.confirm?.note).toBe(m.removeSiteConfirmNote(VAULT));
    expect(v.site.offer.visible).toBe(false);
  });
});
