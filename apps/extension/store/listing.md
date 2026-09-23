# Chrome Web Store listing

Everything the Developer Dashboard asks for, kept here so a resubmission is
copy-paste rather than rewriting from memory. Update it whenever the extension's
permissions or behaviour change — a listing that disagrees with the manifest is
how a review gets rejected.

**Visibility: Unlisted.** Installable by anyone with the link, invisible in
search. This is a personal tool; it is published for auto-updating installs
across machines, not for an audience.

## Item

- **Name**: Tiro Clipper
- **Category**: Productivity → Workflow & Planning
- **Language**: English (listing language; the extension UI itself is
  bilingual — it follows the browser's UI language, en/zh, with an override
  in Settings)
- **Homepage**: <https://tiro.ainaive.com/>
- **Privacy policy**: <https://tiro.ainaive.com/privacy/>

**Short description** (132 char limit):

> Clip the page you're reading, or a PDF, as clean Markdown, committed straight to a GitHub repository you own. No server in between.

**Detailed description**:

> Tiro Clipper saves the article you are reading into a GitHub repository you
> control, as Markdown you can read, grep, and diff years from now.
>
> Click the toolbar button and the extension extracts the readable article from
> the page, converts it to Markdown, and commits it to your repository with a
> token you supply. That is the whole flow.
>
> - Readable Markdown with frontmatter, not an archived blob of HTML.
> - Your repository, your token. There is no Tiro account and no Tiro server —
>   the extension talks to api.github.com, and to arxiv.org only if you allow it.
> - arXiv papers are clipped in full where arXiv has a full text to give.
>   Whichever of a paper's addresses you are on — abstract, PDF or HTML — it is
>   one article, and Tiro fetches the HTML edition for it. That needs your
>   permission for arxiv.org, which Chrome asks for the first time and never
>   before. Papers arXiv could not convert to HTML are clipped from their
>   abstract page instead.
> - PDFs are not a dead end. Clip a PDF you are viewing and Tiro saves its
>   address; the text is read from the document afterwards, by the open-source
>   processor in your own repository, not by the extension. A PDF already on
>   your computer can be imported straight from Settings without going through
>   a web address at all. Where the document's own typography says what its
>   structure is, the headings, code blocks and lists come from that.
> - On a Tiro site — any page carrying Tiro's marker, on any domain — the
>   button files an article into your collections instead: favorites, or any
>   list you name. The change is committed to the same repository when you
>   close the popup, and only for an article your repository already holds.
> - Nothing is read in the background. A page is read only when you open the
>   Tiro popup on it, to build the preview — and on first run, only after you
>   agree to the disclosure the popup shows you. Close it without clipping and
>   the result is discarded; a collection you ticked on a Tiro site is the one
>   thing kept, and it is saved when the popup closes.
> - No analytics, no tracking, no remote code.
>
> Setup takes a minute: open Settings, enter your GitHub username, the
> repository to clip into, the branch, and a fine-grained personal access token
> scoped to that one repository with Contents: Read and write.
>
> Tiro Clipper is the capture end of Tiro, an open-source personal
> read-it-later system: <https://github.com/hutusi/tiro>

## Single purpose

> Save a document the user chooses — the web page they are on, or a PDF on
> their own computer — into a user-specified GitHub repository as a Markdown
> file, and let the user file those saved documents into their own collections
> in that repository.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `activeTab` | Reads the current tab's content only after the user clicks the toolbar button, so the article can be extracted and converted to Markdown. No access to any other tab, and none until that click. |
| `scripting` | Injects the extraction script (`clipper.js`) into the active tab on that same click. Before that, on the same click, it runs a two-line function that looks for the marker a Tiro site publishes, so the popup can offer collections instead of a clip on the user's own site. Both are bundled with the extension; nothing is fetched or evaluated at runtime. |
| `storage` | Stores the user's own settings — GitHub username, repository, branch, and access token — so they are not re-entered on every clip, plus a UI language preference, plus a record of their acceptance of the first-run disclosure, plus a local record of successful clips (a slug derived from the clipped page's address, and a timestamp; at most 500 entries) that powers the "already clipped" status in the popup, plus collection changes not yet saved to the repository and the outcome of the last save (kept briefly after saving, at most a week, never synced). Local to the machine by default; the user may opt the settings (not the clip record, and not the disclosure acceptance) into `chrome.storage.sync` so a second machine on the same Chrome profile needs no setup. |
| `https://api.github.com/*` | The destination the clip is committed to, via the GitHub Contents API, using the user's own token. |
| `https://arxiv.org/*` (optional) | Fetches a paper's HTML full text (`arxiv.org/html/<id>`) when the user clips an arXiv page. Tiro treats a paper's abstract, PDF and HTML addresses as one article, so it reads the full text rather than whichever of the three the tab happens to show — the PDF address in particular has no readable text at all. Declared as an *optional* host permission and requested from the user's own click, so it is never held unless the user grants it, and revoking it returns the extension to clipping the current tab — except at a paper's PDF address, which holds no readable text for it to clip. |
| `https://raw.githubusercontent.com/*` (optional) | Fetches a Markdown file's own bytes when the user clips a `github.com` page showing one. The tab shows GitHub's rendering of the file — its chrome, its heading anchors, its emoji images — and committing that as the article's text would store a copy of the page rather than the file the user pointed at. Declared as an *optional* host permission and requested from the user's own click, so it is never held unless the user grants it. Revoking it does not degrade the clip silently: on a GitHub file page the extension declines and names the file's direct address to open instead, which needs no permission at all. Not needed to clip a Markdown file served as plain text anywhere, including `raw.githubusercontent.com` itself — the tab already holds the file. |

## Data use declarations

Declare generously. Google defines "handle" as "collecting, transmitting, using,
or sharing", requires disclosure even for data that never leaves the device, and
since the August 2026 policy update requires it "regardless of whether the data
is closely related to the extension's single purpose". None of the categories
below are excused by the data being user-supplied or going to the user's own
repository — a declaration that reads narrower than the code is a rejection.

- **Personally identifiable information**: **Yes** — a GitHub username, typed by
  the user on the options page. Google's definition of PII enumerates
  "username". It is stored locally — and also in `chrome.storage.sync`, and so
  replicated by Chrome, if the user turns on settings sync — and sent to
  `api.github.com` only as part of the repository path it identifies.
- **Health / financial / payment information**: No
- **Authentication information**: **Yes** — a GitHub personal access token the
  user creates and enters themselves. Stored in `chrome.storage.local` on their
  machine, sent only to `api.github.com`, as the `Authorization` header of the
  GitHub API requests the extension makes — the connection test on the options
  page and the commit itself. The extension sends it nowhere else, and never to
  the developer. If the user opts into settings sync on the options page, a copy is
  stored in `chrome.storage.sync` as well, and so is replicated by Chrome to
  the devices signed into their Google account; the option is off by default,
  the options page says what it does before they tick it, and unticking it
  clears the token from sync storage. This is transfer by the browser's own
  sync, not by the extension, which still sends the token nowhere but GitHub.
- **Web history**: **Yes** — the URL of a page the user chooses to clip is
  stored in the article's frontmatter, encoded in its directory name, and
  committed to the user's repository. A slug derived from that URL is also kept
  locally (with a timestamp, at most 500 entries) so the popup can show an
  "already clipped" status; that record never leaves the device, and is excluded
  from settings sync. On a Tiro site — recognized by its marker, not by who
  runs it — the slug of an article the user files into a collection is queued
  locally and then committed to a collection file in their repository, only
  for an article their repository already holds: a page they had already
  clipped, but a use of its address all the same, so declared. The same
  declaration covers both optional fetches: requesting
  `arxiv.org/html/<id>` tells that site which paper is being read, and requesting
  a file from `raw.githubusercontent.com` tells GitHub which file is being read,
  in each case whether or not the user goes on to clip it. Google's definition
  covers "the domains or URLs the browser interacts with" and publishes no
  carve-out for a URL the user deliberately saves, nor for one fetched to build a
  preview, so all of them are declared rather than argued. An imported local
  document has no URL; it is filed under a `local:` address built from the
  filename, which is not browsing history but does become the article's public
  name in the user's repository.
- **Personal communications, location, user activity**: No
- **Website content**: **Yes** — the text of a page, read when the user opens
  the popup on it, and transmitted only if they then clip it, only to their own
  GitHub repository. The same declaration is stretched to cover a PDF the user
  imports from their own computer, whose text the extension reads in the page
  and commits the same way. That file is not website content and Google
  publishes no category that fits it, so it is declared here rather than left
  undeclared — the file is chosen by the user in a file picker, read in the
  browser, and sent nowhere but their own repository.

**How consent is obtained**: on first use the popup shows a disclosure panel
naming what is read and when, and the extension injects nothing until the user
presses "I understand — continue". A one-line notice then stays beside the
preview. `DISCLOSURE_VERSION` in `src/storage.ts` re-prompts existing users if
this disclosure ever changes; it is at 5, having been bumped when the disclosure
gained the optional arxiv.org fetch, again when it gained opt-in settings sync,
again when it gained the raw.githubusercontent.com fetch, and again when
collections made the popup keep a change after it closes — which falsified the
sentence promising that closing it discards everything.

Required certifications, all true of this extension:

- Data is **not** sold to third parties.
- Data is **not** used or transferred for purposes unrelated to the item's
  single purpose. (Transfers at the user's direction, each of them the single
  purpose: the clip itself, to GitHub; a collection change, to the same
  repository; and — only once the user has granted the matching optional
  permission — the request to arxiv.org that fetches the paper being clipped,
  or to raw.githubusercontent.com for the markdown file being clipped, each of
  which tells that site which document it is.)
- Data is **not** used to determine creditworthiness or for lending.

## Remote code

**No.** Everything executes from the packaged bundle. The clipper is built as an
IIFE precisely so it can be injected as a file rather than evaluated as a string
(ADR 0005).
