import { type ArxivRef, parseArxivUrl, slugForUrl } from "@tiro/shared";
import {
  ARXIV_ORIGIN,
  type ClipCandidate,
  clipArxivPaper,
  clipReady,
  prefersCandidate,
} from "../arxiv.ts";
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
  /** Where the body on screen was read from, when that is not the article's own
   * URL — an arXiv paper read from its HTML full text. Becomes
   * `tiro.source_url`. Set by `offer`, so it always describes the body kept. */
  let sourceUrl: string | undefined;
  /** Non-null when the tab is an arXiv paper, in any of its URL forms. */
  let paper: ArxivRef | null = null;
  /** Where the body on screen came from, so a second one is judged against it
   * rather than simply overwriting it. */
  let best: ClipCandidate | null = null;
  /** The fetch has run its course: succeeded, declined, or failed. */
  let fetchResolved = false;
  /** The injected clipper has reported, or cannot. Set on failure too — a tab
   * that will not read must not gate the button forever. */
  let tabResolved = false;
  /** A note that belongs beside the preview rather than in the status line,
   * which the next clip result would overwrite. Describes the situation — a
   * declined permission, a failed fetch — so it outlives any one body. */
  let standingNote: string | null = null;
  /** The fetch came back with only the abstract page. Says nothing about which
   * body is on screen: the tab may still have beaten it. */
  let fetchedAbstractOnly = false;

  /**
   * Take a body if it beats the one in hand, and re-render.
   *
   * Both sources land here, and which wins is `prefersCandidate`'s decision
   * rather than the order they happen to arrive in.
   */
  function offer(
    payload: ClipResultMessage["payload"],
    fromFetch: boolean,
    source: string | undefined,
  ): void {
    const candidate = { latexmlFullText: payload.latexmlFullText, fromFetch };
    if (!prefersCandidate(best, candidate)) {
      // Still re-render: the losing arrival may have resolved the last source
      // the gate was waiting on.
      if (result !== null) showPayload(result);
      return;
    }
    best = candidate;
    // Travels with the body, not beside it — a source URL left over from a
    // candidate that lost would describe a body nobody is going to commit.
    sourceUrl = source;
    showPayload(payload);
  }

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
    // Says where *this* body came from, so it cannot outlive it — a fetched
    // preview beaten by the tab would otherwise still claim arxiv.org.
    el.notice.textContent =
      best?.fromFetch === true ? m.arxivNotice : m.noticePreview;
    // The whole point of the identity rule is that this article is the paper.
    // Committing the abstract page while its full text is one click away would
    // replace that full text — so the button waits for both sources.
    const gated = !clipReady(best, paper !== null, fetchResolved, tabResolved);
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
    // "This is only the abstract" describes a body, not the session, so it
    // shows only while that body is the one that won. Without the second
    // condition it survived a tab full text beating the fetch, and told the
    // reader an abstract was about to be clipped while the full paper was on
    // screen.
    const note =
      standingNote ??
      (fetchedAbstractOnly && best?.fromFetch === true
        ? m.arxivAbstractOnly
        : null);
    // Last, so it survives the branches above rather than racing them.
    if (note !== null) {
      el.warning.textContent = note;
      el.warning.hidden = false;
    }
  }

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isClipResult(message)) return;
    tabResolved = true;
    offer(message.payload, false, tabSourceUrl(message.payload.url));
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
      // The tab has answered, even though the answer is "you cannot read me".
      // Without this the gate would wait on a source that will never report —
      // most likely on a PDF tab, where injection is least dependable.
      tabResolved = true;
      setStatus(m.cannotRead(String(error)), true);
      if (result !== null) showPayload(result);
      return;
    }

    // executeScript resolves when injection starts, not when the clipper
    // messages back; if the clipper dies mid-run the popup would otherwise sit
    // on "Reading page…" forever.
    setTimeout(() => {
      tabResolved = true;
      if (result === null) {
        setStatus(m.noClipResult, true);
        return;
      }
      showPayload(result);
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
      fetchResolved = true;
      // No source URL means the abstract page is all that came back.
      fetchedAbstractOnly = clip.sourceUrl === undefined;
      offer(clip.payload, true, clip.sourceUrl);
      // The abstract is not necessarily the best there is. The tab may hold a
      // rendering this fetch could not produce — ar5iv converts papers
      // arxiv.org only stubs — and, on any host, the tab is *proof* the content
      // was retrievable where a transient failure just said otherwise. So ask
      // it, and let prefersCandidate judge. Asking always is the point: an
      // earlier version skipped arxiv.org tabs on the grounds that the fetch
      // had just targeted the identical URL, which is true of the content and
      // false of whether it arrived.
      if (fetchedAbstractOnly) await extract();
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
    fetchResolved = true;
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
          sourceUrl,
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
