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
- **Language**: English
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
> - Nothing is read in the background. The page is touched only when you click.
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
| `storage` | Stores the user's own settings — GitHub username, repository, branch, and access token — so they are not re-entered on every clip. Local to the machine. |
| `https://api.github.com/*` | The destination the clip is committed to, via the GitHub Contents API, using the user's own token. It is the only host the extension contacts. |

## Data use declarations

- **Personally identifiable information**: No
- **Health / financial / payment information**: No
- **Authentication information**: **Yes** — a GitHub personal access token the
  user creates and enters themselves. Stored in `chrome.storage.local` on their
  machine, sent only to `api.github.com`, as the `Authorization` header of the
  GitHub API requests the extension makes — the connection test on the options
  page and the commit itself. Never sent anywhere else, and never to the
  developer.
- **Personal communications, location, web history, user activity**: No
- **Website content**: **Yes** — the text of a page, but only the page the user
  explicitly clips, and only to the user's own GitHub repository.

Required certifications, all true of this extension:

- Data is **not** sold to third parties.
- Data is **not** used or transferred for purposes unrelated to the item's
  single purpose.
- Data is **not** used to determine creditworthiness or for lending.

## Remote code

**No.** Everything executes from the packaged bundle. The clipper is built as an
IIFE precisely so it can be injected as a file rather than evaluated as a string
(ADR 0005).
