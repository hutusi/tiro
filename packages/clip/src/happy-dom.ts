import { Window } from "happy-dom";

/**
 * Fetched HTML as a document the clipper can read, outside a browser
 * (ADR 0034). Node-only, and its own entry point (`@tiro/clip/happy-dom`) so
 * the extension, which has a real DOM, never bundles it.
 *
 * Built for input nobody vetted, in a process that may hold secrets — the
 * processor runs with the LLM key and a token that can push to the vault — so
 * the page gets a document and nothing else:
 *
 * - **No script runs.** A script parsed through `innerHTML` never runs, here as
 *   in a browser, and nothing the clipper does to the document changes that.
 *   The one way happy-dom runs one is a script element created and connected;
 *   evaluation is switched off explicitly (it is also happy-dom 20's default)
 *   so a future change doing that still runs nothing.
 * - **No request leaves.** happy-dom fetches for itself, not through whatever
 *   fetch the caller guards: a `<link rel=preload as=script>` really is
 *   requested, and nine pages in the vault carry one. Script and CSS loading
 *   and every kind of navigation are switched off, and an interceptor refuses
 *   whatever is left, so nothing this page names is ever asked for.
 * - **Closed after use**, even when `fn` throws: one window per article held
 *   for a whole run is how a long corpus becomes a memory problem.
 *
 * `documentElement.innerHTML` rather than a full parse, because happy-dom has
 * no document parser that keeps `<head>`. The wrapper is trimmed so the head's
 * `<link>` and `<meta>` land where Readability looks for them. The document's
 * URL is `url`, so relative links resolve as they did on the page.
 */
export async function withHtmlDocument<T>(
  html: string,
  url: string,
  fn: (doc: Document) => T | Promise<T>,
): Promise<T> {
  const window = new Window({
    url,
    settings: {
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
        disableFallbackToSetURL: true,
      },
      fetch: {
        interceptor: {
          beforeAsyncRequest: async ({ window: frame }) =>
            new frame.Response(null, {
              status: 403,
              statusText: "Blocked: Tiro does not load a page's resources",
            }),
          beforeSyncRequest: ({ request, window: frame }) => ({
            status: 403,
            statusText: "Blocked: Tiro does not load a page's resources",
            ok: false,
            url: request.url,
            redirected: false,
            headers: new frame.Headers(),
            body: null,
          }),
        },
      },
    },
  });
  try {
    const doc = window.document as unknown as Document;
    doc.documentElement.innerHTML = html
      .replace(/^[\s\S]*?<html[^>]*>/i, "")
      .replace(/<\/html>[\s\S]*$/i, "");
    return await fn(doc);
  } finally {
    await window.happyDOM.close();
  }
}

/**
 * What Chrome builds for a `text/plain` response: the bytes in one `<pre>`.
 *
 * The one response type where the bytes and the document a browser shows
 * differ. Without it a markdown file would be parsed as HTML — which is
 * neither what the clipper sees in a tab nor anything at all, since
 * `# Heading` is not a tag — and the clipper's markdown branch, which keys on
 * exactly this shape, would never fire.
 */
export function plainTextShell(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<html><head></head><body><pre>${escaped}</pre></body></html>`;
}
