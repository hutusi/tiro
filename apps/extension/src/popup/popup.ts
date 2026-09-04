import { type ArxivRef, parseArxivUrl, slugForUrl } from "@tiro/shared";
import { ARXIV_ORIGIN, clipArxivPaper, needsFullTextFetch } from "../arxiv.ts";
import { buildClipFile } from "../clip.ts";
import { describeClipError } from "../errors.ts";
import { encodeBase64Utf8, findExistingIndex, putFile } from "../github.ts";
import { formatClipDate, getLocale, messages } from "../i18n.ts";
import { type ClipResultMessage, isClipResult } from "../messages.ts";
import {
  acceptDisclosure,
  isConfigComplete,
  lastClippedAt,
  loadConfig,
  loadDisclosure,
  needsDisclosure,
  recordClip,
} from "../storage.ts";
import { countWords } from "../words.ts";

const el = {
  status: document.getElementById("status") as HTMLDivElement,
  disclosure: document.getElementById("disclosure") as HTMLDivElement,
  disclosureTitle: document.getElementById(
    "disclosure-title",
  ) as HTMLHeadingElement,
  disclosureBody1: document.getElementById(
    "disclosure-body-1",
  ) as HTMLParagraphElement,
  disclosureBody2: document.getElementById(
    "disclosure-body-2",
  ) as HTMLParagraphElement,
  accept: document.getElementById("accept") as HTMLButtonElement,
  preview: document.getElementById("preview") as HTMLDivElement,
  title: document.getElementById("article-title") as HTMLDivElement,
  meta: document.getElementById("article-meta") as HTMLDivElement,
  warning: document.getElementById("warning") as HTMLDivElement,
  notice: document.getElementById("notice") as HTMLDivElement,
  arxivFetch: document.getElementById("arxiv-fetch") as HTMLButtonElement,
  clip: document.getElementById("clip") as HTMLButtonElement,
  view: document.getElementById("view") as HTMLAnchorElement,
  options: document.getElementById("options") as HTMLButtonElement,
};

function setStatus(message: string, isError = false): void {
  el.status.textContent = message;
  el.status.classList.toggle("error", isError);
}

el.options.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

async function main(): Promise<void> {
  const [config, locale] = await Promise.all([loadConfig(), getLocale()]);
  const m = messages(locale);

  // The HTML ships English defaults; localizing up front keeps the swap to a
  // single early paint instead of text changing under the user later.
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  el.disclosureTitle.textContent = m.disclosureTitle;
  el.disclosureBody1.textContent = m.disclosureBody1;
  el.disclosureBody2.textContent = m.disclosureBody2;
  el.accept.textContent = m.disclosureAccept;
  el.warning.textContent = m.warningReadability;
  el.notice.textContent = m.noticePreview;
  el.arxivFetch.textContent = m.arxivFetchButton;
  el.clip.textContent = m.clipButton;
  el.view.textContent = m.viewInVault;
  el.options.textContent = m.settingsLink;

  const configured = isConfigComplete(config);
  if (!configured) {
    setStatus(m.settingsFirst, true);
  }

  let result: ClipResultMessage["payload"] | null = null;
  let clippedAt: string | null = null;
  /** Set when the body came from somewhere other than the article's own URL —
   * an arXiv paper read from its HTML full text. Becomes `tiro.source_url`. */
  let sourceUrl: string | undefined;
  /** Non-null when the tab is an arXiv paper, in any of its URL forms. */
  let paper: ArxivRef | null = null;
  /** Once a fetched full text is on screen, a late message from the injected
   * clipper must not replace it with the page the reader happened to be on. */
  let fetched = false;
  /**
   * True once the best available body is the one on screen — the fetch
   * succeeded, or the reader declined the permission, or it failed.
   *
   * Until then Clip stays disabled on a paper whose full text has not been
   * read, because committing the abstract would overwrite the full-text
   * article under the same slug. The flag is what lets the abstract-page
   * fallback enable Clip at all: that payload legitimately has no LaTeXML full
   * text, so the predicate alone would gate it forever.
   */
  let fullTextSettled = false;
  /** A note that belongs beside the preview rather than in the status line,
   * which the next clip result would overwrite. */
  let standingNote: string | null = null;

  function showPayload(payload: ClipResultMessage["payload"]): void {
    result = payload;
    // A PDF has nothing to preview and nothing to commit, so it stops here
    // whatever the configuration says: the button is never enabled. Before
    // this the readability warning appeared but the button did too, and an
    // empty article with `readability_failed: true` could be committed. On an
    // arXiv PDF it is not a dead end — the fetch button is already on screen.
    if (payload.pdfViewer) {
      setStatus(
        paper === null ? m.cannotClipPdf : m.arxivOffer,
        paper === null,
      );
      return;
    }
    el.preview.hidden = false;
    el.title.textContent = payload.title;
    el.meta.textContent = m.articleMeta(
      new URL(payload.url).hostname,
      countWords(payload.markdown),
    );
    el.warning.hidden = !payload.readabilityFailed;
    // The whole point of the identity rule is that this article is the paper.
    // Committing the abstract page while its full text is one click away would
    // replace that full text — so the button waits.
    const gated =
      !fullTextSettled && needsFullTextFetch(payload, paper !== null);
    // A tab already showing the paper has nothing to fetch, so the offer would
    // only be noise — and clipping it must not need a permission.
    if (!gated) el.arxivFetch.hidden = true;
    if (configured && !gated) {
      el.clip.disabled = false;
      if (clippedAt !== null) {
        setStatus(m.alreadyClipped(formatClipDate(locale, clippedAt)));
        el.clip.textContent = m.reclipButton;
      } else {
        setStatus(m.readyToClip);
      }
    } else if (gated) {
      setStatus(m.arxivOffer);
    }
    // Last, so it survives the branches above rather than racing them.
    if (standingNote !== null) {
      el.warning.textContent = standingNote;
      el.warning.hidden = false;
    }
  }

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isClipResult(message) || fetched) return;
    showPayload(message.payload);
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    tab?.id === undefined ||
    tab.url === undefined ||
    !/^https?:/.test(tab.url)
  ) {
    setStatus(m.cannotClip, true);
    return;
  }
  const tabId = tab.id;
  const tabUrl = tab.url;

  let extracted = false;
  async function extract(): Promise<void> {
    // Idempotent: the arXiv fallbacks reach here after prepare() may already
    // have run it, and a second injection would deliver a second clip result.
    if (extracted) return;
    extracted = true;
    if (configured) setStatus(m.readingPage);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["clipper.js"],
      });
    } catch (error) {
      setStatus(m.cannotRead(String(error)), true);
      return;
    }

    // executeScript resolves when injection starts, not when the clipper
    // messages back; if the clipper dies mid-run the popup would otherwise sit
    // on "Reading page…" forever.
    setTimeout(() => {
      if (result === null) {
        setStatus(m.noClipResult, true);
      }
    }, 10_000);
  }

  /**
   * Read the paper's full text from arxiv.org rather than the tab.
   *
   * `askFirst` is false only when the permission is already held: a popup that
   * opens without a click has no user gesture, and `permissions.request`
   * refuses without one even when it would grant immediately.
   */
  async function fetchFullText(paper: ArxivRef, askFirst: boolean) {
    el.arxivFetch.hidden = true;
    if (askFirst) {
      const granted = await chrome.permissions.request({
        origins: [ARXIV_ORIGIN],
      });
      if (!granted) {
        // Declining is an answer. The tab's own content is now the best body
        // available, so Clip stops waiting for one that is not coming.
        await settleOnTab(m.arxivDenied);
        return;
      }
    }
    setStatus(m.arxivFetching);
    try {
      const clip = await clipArxivPaper(paper, {
        fetch: (input, init) => fetch(input, init),
        parse: (html) => new DOMParser().parseFromString(html, "text/html"),
      });
      fetched = true;
      fullTextSettled = true;
      sourceUrl = clip.sourceUrl;
      // Only now: a failed fetch reads the tab after all, and this would then
      // describe a read that did not happen.
      el.notice.textContent = m.arxivNotice;
      // No source URL means the abstract page *was* what was read, which is
      // worth saying: this paper has no HTML full text to have missed.
      if (clip.sourceUrl === undefined) standingNote = m.arxivAbstractOnly;
      showPayload(clip.payload);
    } catch (error) {
      await settleOnTab(m.arxivFailed(String(error)));
    }
  }

  /**
   * Fall back to whatever the tab holds, and stop gating Clip on a full text
   * that is not going to arrive.
   *
   * Re-renders rather than only extracting, because in the not-granted path the
   * tab was already previewed and its clip result has been and gone — nothing
   * would otherwise re-evaluate the gate.
   */
  async function settleOnTab(note: string): Promise<void> {
    fullTextSettled = true;
    standingNote = note;
    if (result === null) {
      await extract();
      return;
    }
    showPayload(result);
  }

  // Best-effort state from the local clip record. Slug derivation and the
  // lookup are both local, but they still wait for an accepted disclosure so
  // the popup does nothing at all before consent. Awaiting the lookup before
  // extraction means the clip-result listener always sees it settled. The
  // clip flow's own GitHub lookup stays the authority on overwrite-vs-create.
  async function prepare(): Promise<void> {
    try {
      clippedAt = await lastClippedAt(config, await slugForUrl(tabUrl));
    } catch {
      clippedAt = null;
    }
    paper = parseArxivUrl(tabUrl);
    if (paper === null) {
      await extract();
      return;
    }
    const known = paper;
    // Already granted: reading arxiv.org is then no different from reading the
    // tab, so it happens up front and the preview shows what will be stored.
    if (await chrome.permissions.contains({ origins: [ARXIV_ORIGIN] })) {
      await fetchFullText(known, false);
      return;
    }
    // Not granted: nothing is fetched. The tab is previewed as usual and the
    // offer sits beside it, so the permission is asked for by an explicit act.
    el.arxivFetch.hidden = false;
    el.arxivFetch.addEventListener(
      "click",
      () => {
        void fetchFullText(known, true);
      },
      { once: true },
    );
    await extract();
  }

  el.clip.addEventListener("click", () => {
    if (result === null) return;
    void (async (payload) => {
      el.clip.disabled = true;
      setStatus(m.clipping);
      try {
        const nowIso = new Date().toISOString();
        const file = await buildClipFile({
          url: payload.url,
          // A tab clip on a paper still came from one of its URL forms, and the
          // article is filed under another — so the body's origin is recorded
          // whichever path produced it. buildClipFile drops it when it agrees
          // with the canonical URL, so an ordinary page records nothing.
          sourceUrl: sourceUrl ?? tabSourceUrl(payload.url),
          title: payload.title,
          markdown: payload.markdown,
          excerpt: payload.excerpt,
          author: payload.author,
          readabilityFailed: payload.readabilityFailed,
          hasMath: payload.hasMath,
          clippedAt: nowIso,
          clipperVersion: chrome.runtime.getManifest().version,
          clipperCommit: __CLIPPER_COMMIT__,
        });
        // The flat layout makes file.path deterministic; the lookup only
        // supplies the sha that turns the PUT into an overwrite.
        const existing = await findExistingIndex(config, file.slug);
        const path = file.path;
        await putFile(config, {
          path,
          contentBase64: encodeBase64Utf8(file.content),
          message: `clip: ${file.title}`,
          ...(existing !== null ? { sha: existing.sha } : {}),
        });
        setStatus(existing !== null ? m.updatedExisting : m.clipped);
        el.view.href = `https://github.com/${config.owner}/${config.repo}/blob/${config.branch}/${path}`;
        el.view.hidden = false;
        try {
          await recordClip(config, file.slug, nowIso);
        } catch {
          // The commit already succeeded; losing the hint record must not
          // relabel the clip as failed.
        }
      } catch (error) {
        console.error("clip failed:", error);
        setStatus(describeClipError(error, m), true);
        el.clip.disabled = false;
      }
    })(result);
  });

  // The page is read to build the preview, which happens before the Clip
  // click — so the disclosure has to gate the extraction itself, not the
  // upload. A store listing or privacy page does not satisfy this; the consent
  // has to be in the product UI and has to be an explicit action.
  if (needsDisclosure(await loadDisclosure())) {
    el.disclosure.hidden = false;
    // Hide the (disabled) clip button meanwhile, so the panel's Continue is the
    // only button on screen and cannot be mistaken for it.
    el.clip.hidden = true;
    el.accept.addEventListener(
      "click",
      () => {
        void (async () => {
          await acceptDisclosure(new Date().toISOString());
          el.disclosure.hidden = true;
          el.clip.hidden = false;
          await prepare();
        })();
      },
      { once: true },
    );
    return;
  }

  await prepare();
}

/**
 * The URL a tab clip was read from, for `tiro.source_url` — but only on a page
 * whose identity gets rewritten, and only ever without its query or fragment.
 *
 * Passing the raw address through would republish a tracking param that
 * `buildClipFile` strips from `url` on purpose, so the query goes even though
 * arXiv's own (`?context=cs`) is harmless.
 */
function tabSourceUrl(rawUrl: string): string | undefined {
  if (parseArxivUrl(rawUrl) === null) return undefined;
  try {
    const url = new URL(rawUrl);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

void main();
