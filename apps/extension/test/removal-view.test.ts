import { describe, expect, test } from "bun:test";
import { messages } from "../src/i18n.ts";
import {
  type RemovalState,
  type RemovalStep,
  removalView,
} from "../src/popup/removal-view.ts";

const m = messages("en");
const zh = messages("zh");

function removal(
  step: RemovalStep,
  extra: Partial<RemovalState> = {},
): RemovalState {
  return { step, vault: "o/tiro-vault", title: null, problem: null, ...extra };
}

describe("removalView", () => {
  test("nothing to offer shows nothing", () => {
    for (const r of [null, undefined]) {
      const v = removalView(r, m);
      expect(v.offer.visible).toBe(false);
      expect(v.confirm).toBeNull();
      expect(v.status).toBeNull();
      expect(v.active || v.settled).toBe(false);
    }
  });

  test("offered: the footer link, and only where the page allows it", () => {
    expect(removalView(removal("offered"), m).offer).toEqual({
      visible: true,
      label: m.removeOffer,
      hint: m.removeOfferHint,
    });
    expect(removalView(removal("offered"), m, false).offer.visible).toBe(false);
  });

  test("checking: a neutral status, and everything else stands down", () => {
    const v = removalView(removal("checking"), m, false);
    expect(v.offer.visible).toBe(false);
    expect(v.status).toEqual({ text: m.removeChecking, tone: "neutral" });
    expect(v.active).toBe(true);
    expect(v.settled).toBe(false);
  });

  test("confirming: a card with the vault's title, the vault, and that history keeps it", () => {
    const v = removalView(
      removal("confirming", { title: "Harness Engineering" }),
      m,
    );
    expect(v.confirm?.heading).toBe(m.removeConfirmHeading);
    expect(v.confirm?.title).toBe("Harness Engineering");
    expect(v.confirm?.note).toContain("o/tiro-vault");
    expect(v.confirm?.note).toContain("history");
    expect(v.confirm?.confirmLabel).toBe(m.removeConfirmButton);
    expect(v.confirm?.cancelLabel).toBe(m.removeCancel);
    expect(v.offer.visible).toBe(false);
    expect(v.active).toBe(true);
  });

  test("an untitled article gets the heading alone, no filler, in both languages", () => {
    for (const t of [m, zh]) {
      const card = removalView(removal("confirming"), t).confirm;
      expect(card?.title).toBeNull();
      expect(card?.heading).toBe(t.removeConfirmHeading);
      expect(card?.note).toContain("o/tiro-vault");
    }
    expect(removalView(removal("confirming"), zh).confirm?.note).toContain(
      "历史",
    );
  });

  test("removing: progress in the status and the label", () => {
    const v = removalView(removal("removing"), m);
    expect(v.status).toEqual({ text: m.removing, tone: "neutral" });
    expect(v.label).toEqual({ text: m.labelRemoving, tone: "neutral" });
    expect(v.confirm).toBeNull();
    expect(v.active).toBe(true);
  });

  test("removed and gone are where the popup ends", () => {
    const removed = removalView(removal("removed"), m);
    expect(removed.status).toEqual({
      text: m.removed("o/tiro-vault"),
      tone: "ok",
    });
    expect(removed.label?.tone).toBe("ok");
    const gone = removalView(removal("gone"), m);
    expect(gone.status?.text).toBe(m.removeGone("o/tiro-vault"));
    expect(gone.label?.text).toBe(m.labelNotInVault);
    for (const v of [removed, gone]) {
      expect(v.settled).toBe(true);
      expect(v.active).toBe(false);
      expect(v.offer.visible).toBe(false);
    }
  });

  test("failed: the problem as an error, and the link back as the retry", () => {
    const v = removalView(removal("failed", { problem: "Nope." }), m);
    expect(v.status).toEqual({ text: "Nope.", tone: "error" });
    expect(v.offer.visible).toBe(true);
    expect(v.active || v.settled).toBe(false);
    expect(
      removalView(removal("failed", { problem: "Nope." }), m, false).offer
        .visible,
    ).toBe(false);
  });
});
