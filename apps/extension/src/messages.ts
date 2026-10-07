import type { ClipPayload } from "@tiro/clip";

// Type-only: erased from the bundle, so the service worker, which imports
// this file for its message types, never loads the DOM-bound clip package
// (invariant 6).
export type { ClipPayload };

/** Message sent by the injected clipper back to the popup. */
export interface ClipResultMessage {
  type: "tiro-clip-result";
  payload: ClipPayload;
  /**
   * `__CLIPPER_COMMIT__` as built into clipper.js, the code that extracted
   * this body. It becomes `tiro.clipper_commit`, whose question is "does this
   * body have the fix", and the body is the clipper's work. Beside the payload
   * rather than in it because `ClipPayload` is `@tiro/clip`'s, which the sweep
   * runs with no build behind it. Absent from a clipper built before this
   * field, which then records no commit rather than the popup's.
   */
  clipperCommit?: string;
}

/** The popup's one message boundary. Today only this extension's own clipper
 * can reach it, but the popup dereferences the payload (new URL, word count),
 * so the guard checks the whole shape rather than trusting the type tag. */
export function isClipResult(message: unknown): message is ClipResultMessage {
  if (typeof message !== "object" || message === null) return false;
  const { type, payload, clipperCommit } = message as {
    type?: unknown;
    payload?: unknown;
    clipperCommit?: unknown;
  };
  if (type !== "tiro-clip-result") return false;
  if (clipperCommit !== undefined && typeof clipperCommit !== "string") {
    return false;
  }
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.url === "string" &&
    typeof p.title === "string" &&
    typeof p.excerpt === "string" &&
    typeof p.author === "string" &&
    typeof p.markdown === "string" &&
    typeof p.readabilityFailed === "boolean" &&
    typeof p.hasMath === "boolean" &&
    typeof p.pdfViewer === "boolean" &&
    typeof p.latexmlFullText === "boolean" &&
    typeof p.markdownSource === "boolean"
  );
}

/**
 * The popup asking the service worker to record one collection toggle, or to
 * flush now (ADR 0029). Only the worker writes the queue, so the popup sends
 * both rather than touching storage itself.
 *
 * `published` is whether the article is in the collection as the popup saw
 * it, and `member` is the *deployed site's* whole membership for this article
 * — the worker uses the first to judge whether the toggle is a change, and the
 * second to prune overlay the site has since caught up with.
 *
 * `member` is null when the popup has no site to go by: after a clip it reads
 * membership from the vault (ADR 0037), which already agrees with every op a
 * flush has sent, so pruning against it would drop overlay a still-stale Tiro
 * page needs. Null prunes nothing on its account.
 */
export type CollectionMessage =
  | {
      type: "tiro-collection-toggle";
      op: {
        id: string;
        collection: string;
        slug: string;
        action: "add" | "remove";
        at: string;
        title?: string;
      };
      published: boolean;
      member: string[] | null;
    }
  | { type: "tiro-collection-flush" };

/** The port the popup holds open. Its disconnect — the popup closing — is the
 * worker's cue to flush. */
export const POPUP_PORT = "tiro-popup";

/** Shape-checked like `isClipResult`: the worker writes what these carry into
 * storage and, on the next flush, into the vault. */
export function isCollectionMessage(
  message: unknown,
): message is CollectionMessage {
  if (typeof message !== "object" || message === null) return false;
  const m = message as Record<string, unknown>;
  if (m.type === "tiro-collection-flush") return true;
  if (m.type !== "tiro-collection-toggle") return false;
  if (typeof m.published !== "boolean") return false;
  if (
    m.member !== null &&
    (!Array.isArray(m.member) || !m.member.every((x) => typeof x === "string"))
  ) {
    return false;
  }
  const op = m.op as Record<string, unknown> | null;
  return (
    typeof op === "object" &&
    op !== null &&
    typeof op.id === "string" &&
    typeof op.collection === "string" &&
    typeof op.slug === "string" &&
    (op.action === "add" || op.action === "remove") &&
    typeof op.at === "string" &&
    (op.title === undefined || typeof op.title === "string")
  );
}
