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

> Clip the page you're reading as clean Markdown, committed straight to a GitHub repository you own. No server in the middle.

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
>   the extension talks to api.github.com and nowhere else.
> - Nothing is read in the background. A page is read only when you open the
>   Tiro popup on it, to build the preview — and on first run, only after you
>   agree to the disclosure the popup shows you. Close it without clipping and
>   the result is discarded.
> - No analytics, no tracking, no remote code.
>
> Setup takes a minute: open Settings, enter your GitHub username, the
> repository to clip into, the branch, and a fine-grained personal access token
> scoped to that one repository with Contents: Read and write.
>
> Tiro Clipper is the capture end of Tiro, an open-source personal
> read-it-later system: <https://github.com/hutusi/tiro>

## Single purpose

> Save the current web page into a user-specified GitHub repository as a
> Markdown file.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `activeTab` | Reads the current tab's content only after the user clicks the toolbar button, so the article can be extracted and converted to Markdown. No access to any other tab, and none until that click. |
| `scripting` | Injects the extraction script (`clipper.js`) into the active tab on that same click. It is bundled with the extension; nothing is fetched or evaluated at runtime. |
| `storage` | Stores the user's own settings — GitHub username, repository, branch, and access token — so they are not re-entered on every clip, plus a UI language preference, plus a record of their acceptance of the first-run disclosure, plus a local record of successful clips (a slug derived from the clipped page's address, and a timestamp; at most 500 entries) that powers the "already clipped" status in the popup. All local to the machine. |
| `https://api.github.com/*` | The destination the clip is committed to, via the GitHub Contents API, using the user's own token. It is the only host the extension contacts. |

## Data use declarations

Declare generously. Google defines "handle" as "collecting, transmitting, using,
or sharing", requires disclosure even for data that never leaves the device, and
since the August 2026 policy update requires it "regardless of whether the data
is closely related to the extension's single purpose". None of the categories
below are excused by the data being user-supplied or going to the user's own
repository — a declaration that reads narrower than the code is a rejection.

- **Personally identifiable information**: **Yes** — a GitHub username, typed by
  the user on the options page. Google's definition of PII enumerates
  "username". It is stored locally and sent to `api.github.com` only as part of
  the repository path it identifies.
- **Health / financial / payment information**: No
- **Authentication information**: **Yes** — a GitHub personal access token the
  user creates and enters themselves. Stored in `chrome.storage.local` on their
  machine, sent only to `api.github.com`, as the `Authorization` header of the
  GitHub API requests the extension makes — the connection test on the options
  page and the commit itself. Never sent anywhere else, and never to the
  developer.
- **Web history**: **Yes** — the URL of a page the user chooses to clip is
  stored in the article's frontmatter, encoded in its directory name, and
  committed to the user's repository. A slug derived from that URL is also kept
  locally (with a timestamp, at most 500 entries) so the popup can show an
  "already clipped" status; that record never leaves the device. Google's
  definition covers "the domains or URLs the browser interacts with" and
  publishes no carve-out for a URL the user deliberately saves, so this is
  declared rather than argued.
- **Personal communications, location, user activity**: No
- **Website content**: **Yes** — the text of a page, read when the user opens
  the popup on it, and transmitted only if they then clip it, only to their own
  GitHub repository.

**How consent is obtained**: on first use the popup shows a disclosure panel
naming what is read and when, and the extension injects nothing until the user
presses "I understand — continue". A one-line notice then stays beside the
preview. `DISCLOSURE_VERSION` in `src/storage.ts` re-prompts existing users if
this disclosure ever changes.

Required certifications, all true of this extension:

- Data is **not** sold to third parties.
- Data is **not** used or transferred for purposes unrelated to the item's
  single purpose. (The one transfer is to GitHub, at the user's direction — it
  *is* the single purpose.)
- Data is **not** used to determine creditworthiness or for lending.

## Remote code

**No.** Everything executes from the packaged bundle. The clipper is built as an
IIFE precisely so it can be injected as a file rather than evaluated as a string
(ADR 0005).
