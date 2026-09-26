import { INBOX_DIR, slugForUrl } from "@tiro/shared/documents";
import {
  articleExists,
  encodeBase64Utf8,
  type FetchLike,
  putFile,
} from "./github.ts";
import { missingConfigFields, type TiroExtensionConfig } from "./storage.ts";

/**
 * Save a link to the vault without opening its page (ADR 0034) — the
 * extension's "Clip link", from the context menu on any link.
 *
 * It writes exactly what the iPhone shortcut writes: one file under `inbox/`
 * holding the URL, which the next processing run turns into an article and
 * clips. So the processor stays the only thing that makes a stub, and a link
 * saved here and one saved from a phone cannot disagree about anything.
 *
 * Runs in the service worker, so it imports `@tiro/shared/documents` and never
 * the root (invariant 6).
 */

export type LinkSave =
  | { kind: "saved"; url: string; path: string }
  /** Already an article; nothing written. */
  | { kind: "exists"; url: string; slug: string }
  | {
      kind: "refused";
      /** Not an http(s) link; no repository or token set; or the disclosure,
       * which says what leaves the browser, has not been accepted yet. */
      reason: "not-a-link" | "unconfigured" | "no-disclosure";
    }
  | { kind: "failed"; error: string };

export interface LinkSaveDeps {
  config: TiroExtensionConfig;
  /** Whether this install's disclosure is accepted at the current version. */
  disclosed: boolean;
  fetchImpl?: FetchLike;
  now?: () => Date;
  random?: () => number;
}

/** `20260926-080000-1234.url`: when, in UTC, and four random digits, so two
 * saves in the same second do not collide — the shortcut's shape. */
export function inboxFileName(now: Date, random: number): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  const digits = String(Math.floor(random * 9000) + 1000);
  return `${stamp}-${digits}.url`;
}

export async function saveLink(
  rawUrl: string,
  deps: LinkSaveDeps,
): Promise<LinkSave> {
  // Consent first: the disclosure is the promise about what leaves the
  // browser, and a menu item is no reason to skip it.
  if (!deps.disclosed) return { kind: "refused", reason: "no-disclosure" };
  let url: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { kind: "refused", reason: "not-a-link" };
    }
    url = parsed.toString();
  } catch {
    return { kind: "refused", reason: "not-a-link" };
  }
  if (missingConfigFields(deps.config).length > 0) {
    return { kind: "refused", reason: "unconfigured" };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    // Asked here, not left to the processor, only to say so: the processor
    // would keep the existing article either way, but "already there" is
    // worth knowing now rather than in a run log.
    const slug = await slugForUrl(url);
    if (await articleExists(deps.config, slug, fetchImpl)) {
      return { kind: "exists", url, slug };
    }
    const path = `${INBOX_DIR}/${inboxFileName(
      (deps.now ?? (() => new Date()))(),
      (deps.random ?? Math.random)(),
    )}`;
    await putFile(
      deps.config,
      {
        path,
        contentBase64: encodeBase64Utf8(`${url}\n`),
        message: `save: ${url}`,
      },
      fetchImpl,
    );
    return { kind: "saved", url, path };
  } catch (error) {
    return { kind: "failed", error: String(error) };
  }
}
