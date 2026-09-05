import "@fontsource/spectral/latin-400.css";
import "@fontsource/spectral/latin-500.css";
import "@fontsource/spectral/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "../ui/tokens.css";
import {
  type ArxivRef,
  parseArxivUrl,
  readingMinutes,
  slugForUrl,
} from "@tiro/shared";
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
import {
  formatClipDate,
  getLocale,
  type Locale,
  type Messages,
  messages,
} from "../i18n.ts";
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
import {
  articleUrl,
  type Phase,
  type PopupLinks,
  type PopupState,
  type PopupView,
  popupView,
  vaultFileUrl,
} from "./view.ts";

const el = {
  label: document.getElementById("label") as HTMLSpanElement,
  disclosure: document.getElementById("disclosure") as HTMLElement,
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
  loading: document.getElementById("loading") as HTMLElement,
  loadingCaption: document.getElementById(
    "loading-caption",
  ) as HTMLParagraphElement,
  preview: document.getElementById("preview") as HTMLElement,
  meta: document.getElementById("article-meta") as HTMLParagraphElement,
  title: document.getElementById("article-title") as HTMLHeadingElement,
  excerpt: document.getElementById("article-excerpt") as HTMLParagraphElement,
  warning: document.getElementById("warning") as HTMLParagraphElement,
  note: document.getElementById("note") as HTMLParagraphElement,
  notice: document.getElementById("notice") as HTMLParagraphElement,
  progress: document.getElementById("progress") as HTMLDivElement,
  progressCaption: document.getElementById(
    "progress-caption",
  ) as HTMLParagraphElement,
  message: document.getElementById("message") as HTMLParagraphElement,
  arxivFetch: document.getElementById("arxiv-fetch") as HTMLButtonElement,
  clip: document.getElementById("clip") as HTMLButtonElement,
  saved: document.getElementById("saved") as HTMLDivElement,
  view: document.getElementById("view") as HTMLAnchorElement,
  open: document.getElementById("open") as HTMLAnchorElement,
  openHint: document.getElementById("open-hint") as HTMLParagraphElement,
  options: document.getElementById("options") as HTMLButtonElement,
};

/** Paint a view. The only place the DOM is written after startup. */
function apply(view: PopupView): void {
  el.label.textContent = view.label;
  el.label.dataset.tone = view.labelTone;
  el.message.hidden = view.message === null;
  el.message.textContent = view.message ?? "";
  el.message.dataset.tone = view.messageTone;
  el.loading.hidden = view.loading === null;
  el.loadingCaption.textContent = view.loading ?? "";
  el.progress.hidden = view.progress === null;
  el.progressCaption.textContent = view.progress ?? "";
  el.preview.hidden = view.preview === null;
  if (view.preview !== null) {
    el.meta.textContent = view.preview.meta;
    el.title.textContent = view.preview.title;
    el.excerpt.hidden = view.preview.excerpt === null;
    el.excerpt.textContent = view.preview.excerpt ?? "";
    el.warning.hidden = view.preview.warning === null;
    el.warning.textContent = view.preview.warning ?? "";
    el.note.hidden = view.preview.note === null;
    el.note.textContent = view.preview.note ?? "";
    el.notice.textContent = view.preview.notice;
  }
  el.arxivFetch.hidden = !view.arxivFetch;
  el.clip.hidden = !view.clip.visible;
  el.clip.disabled = !view.clip.enabled;
  el.clip.textContent = view.clip.label;
  el.clip.classList.toggle("btn-primary", view.clip.primary);
  el.clip.classList.toggle("btn-secondary", !view.clip.primary);
  el.saved.hidden = view.links === null;
  if (view.links !== null) {
    el.view.href = view.links.vault;
    el.open.href = view.links.site;
    el.openHint.hidden = !view.links.hint;
  }
}

el.options.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

/** The HTML ships English defaults; localizing up front keeps the swap to a
 * single early paint instead of text changing under the user later. */
function localize(locale: Locale, m: Messages): void {
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  el.disclosureTitle.textContent = m.disclosureTitle;
  el.disclosureBody1.textContent = m.disclosureBody1;
  el.disclosureBody2.textContent = m.disclosureBody2;
  el.accept.textContent = m.disclosureAccept;
  el.arxivFetch.textContent = m.arxivFetchButton;
  el.clip.textContent = m.clipButton;
  el.view.textContent = m.viewInVault;
  el.open.textContent = m.openInTiro;
  el.openHint.textContent = m.openHint;
  el.options.textContent = m.settingsLink;
}

async function main(): Promise<void> {
  if (__DEV_FIXTURES__) {
    // A development build paints a canned state on request and stops there
    // — before any chrome.* call, so the page also works served from dist/
    // by a plain HTTP server. See fixtures.ts. Never reached in production:
    // the define is `false` and this branch, and the import, are removed.
    const params = new URLSearchParams(location.search);
    const name = params.get("state");
    if (name !== null) {
      const locale: Locale = params.get("lang") === "zh" ? "zh" : "en";
      const m = messages(locale);
      localize(locale, m);
      const { fixtures } = await import("./fixtures.ts");
      const fixture = fixtures(m)[name];
      if (fixture !== undefined) apply(popupView(fixture, m));
      else el.label.textContent = `no fixture "${name}"`;
      return;
    }
  }

  const [config, locale] = await Promise.all([loadConfig(), getLocale()]);
  const m = messages(locale);
  localize(locale, m);

  const configured = isConfigComplete(config);
  const homepage = chrome.runtime.getManifest().homepage_url;

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
  /**
   * A commit has started, and has not failed.
   *
   * Both sources can still deliver while the upload runs, and a body arriving
   * then must change nothing: re-rendering would hand back a second Clip on top
   * of the one in flight — two PUTs to the same path — or relabel a finished
   * clip as ready. It stays set after success, so the screen keeps saying what
   * happened, and is cleared only on failure, the one case where pressing Clip
   * again is the right move.
   *
   * The late body is dropped rather than applied: the preview has to keep
   * describing what was committed. Reopening the popup clips it, which is the
   * "already clipped — clipping again updates it" path.
   */
  let committing = false;
  /** A note that belongs beside the preview rather than in the status line,
   * which the next clip result would overwrite. Describes the situation — a
   * declined permission, a failed fetch — so it outlives any one body. */
  let standingNote: string | null = null;
  /** The fetch came back with only the abstract page. Says nothing about which
   * body is on screen: the tab may still have beaten it. */
  let fetchedAbstractOnly = false;
  /** What the popup is doing, for the header label and the card underneath.
   * Without a configured vault nothing can be clipped, so the popup opens
   * blocked on the Settings instruction rather than "Reading…". */
  let phase: Phase = configured ? "reading" : "blocked";
  /** The sentence for a blocked or failed phase. */
  let problem: { text: string; error: boolean } | null = configured
    ? null
    : { text: m.settingsFirst, error: true };
  /** arXiv: the full text is being fetched. */
  let fetching = false;
  /** The permission is not held and the offer has not been used. */
  let fetchOffered = false;
  /** Set once the upload has returned. */
  let saved: { updated: boolean; links: PopupLinks } | null = null;
  /** Local record: where a previous clip of this page landed. */
  let previousLinks: PopupLinks | null = null;

  /** Everything known, as the view model wants it. */
  function render(): void {
    const gated =
      result !== null &&
      !clipReady(best, paper !== null, fetchResolved, tabResolved);
    // The page is still read when unconfigured — the preview is harmless and
    // shows what Settings would unlock — but the phase stays blocked on the
    // Settings instruction however far the extraction gets.
    const setupBlocked =
      !configured && (phase === "reading" || phase === "ready");
    const state: PopupState = {
      phase: setupBlocked ? "blocked" : phase,
      configured,
      preview:
        result === null || result.pdfViewer
          ? null
          : {
              title: result.title,
              host: new URL(result.url).hostname,
              words: countWords(result.markdown),
              minutes: readingMinutes(result.markdown),
              excerpt: result.excerpt,
              readabilityFailed: result.readabilityFailed,
              fromFetch: best?.fromFetch === true,
            },
      problem: setupBlocked ? { text: m.settingsFirst, error: true } : problem,
      clippedOn: clippedAt === null ? null : formatClipDate(locale, clippedAt),
      updated: saved?.updated ?? false,
      gated,
      fetchOffered,
      fetching,
      // "This is only the abstract" describes a body, not the session, so it
      // shows only while that body is the one that won. Without the second
      // condition it survived a tab full text beating the fetch, and told the
      // reader an abstract was about to be clipped while the full paper was on
      // screen.
      note:
        standingNote ??
        (fetchedAbstractOnly && best?.fromFetch === true
          ? m.arxivAbstractOnly
          : null),
      links: saved?.links ?? previousLinks,
    };
    apply(popupView(state, m));
  }

  /** A dead end: nothing more will happen on this page. */
  function block(text: string, error = true): void {
    phase = "blocked";
    problem = { text, error };
    render();
  }

  if (!configured) render();

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
    if (committing) return;
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
    if (committing) return;
    result = payload;
    fetching = false;
    // A PDF has nothing to preview and nothing to commit, so it stops here
    // whatever the configuration says: the button is never enabled. Before
    // this the readability warning appeared but the button did too, and an
    // empty article with `readability_failed: true` could be committed. On an
    // arXiv PDF it is not a dead end — the fetch button is already on screen.
    if (payload.pdfViewer) {
      block(paper === null ? m.cannotClipPdf : m.arxivOffer, paper === null);
      return;
    }
    // The whole point of the identity rule is that this article is the paper.
    // Committing the abstract page while its full text is one click away would
    // replace that full text — so the button waits for both sources (the view
    // computes the gate from the same facts).
    phase = "ready";
    problem = null;
    render();
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
    block(m.cannotClip);
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
    if (configured && result === null) {
      phase = "reading";
      render();
    }
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
      if (result !== null) {
        showPayload(result);
        return;
      }
      block(m.cannotRead(String(error)));
      return;
    }

    // executeScript resolves when injection starts, not when the clipper
    // messages back; if the clipper dies mid-run the popup would otherwise sit
    // on "Reading…" forever.
    setTimeout(() => {
      // Only if the clipper never answered. This used to fire unconditionally,
      // so on a page that answered in 200 ms it still re-rendered ten seconds
      // later — re-enabling Clip on top of an upload already in flight, and
      // turning a finished "Clipped." back into "Ready to clip.".
      if (tabResolved) return;
      tabResolved = true;
      if (result === null) {
        block(m.noClipResult);
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
    fetchOffered = false;
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
    // Reading again, whether or not the tab already put a body on screen: the
    // view keeps that preview and says the full text is being fetched. Without
    // this the offer's sentence stayed while its button had gone.
    fetching = true;
    phase = "reading";
    render();
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
    fetching = false;
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
      const slug = await slugForUrl(tabUrl);
      clippedAt = await lastClippedAt(config, slug);
      if (clippedAt !== null && homepage !== undefined) {
        previousLinks = {
          site: articleUrl(homepage, slug),
          vault: vaultFileUrl(config, `articles/${slug}/index.md`),
        };
      }
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
    fetchOffered = true;
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
      committing = true;
      phase = "clipping";
      render();
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
        saved = {
          updated: existing !== null,
          links: {
            site: articleUrl(
              homepage ?? "https://tiro.ainaive.com/",
              file.slug,
            ),
            vault: vaultFileUrl(config, path),
          },
        };
        phase = "saved";
        render();
        try {
          await recordClip(config, file.slug, nowIso);
        } catch {
          // The commit already succeeded; losing the hint record must not
          // relabel the clip as failed.
        }
      } catch (error) {
        console.error("clip failed:", error);
        committing = false;
        phase = "failed";
        problem = { text: describeClipError(error, m), error: true };
        render();
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
