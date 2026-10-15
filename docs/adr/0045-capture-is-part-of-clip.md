# ADR 0045: Capture is part of Clip

Status: accepted (2026-10). Amends ADR 0039 in three places:

- §2, "a picture of it, when the reader asks", with its "Never automatic";
- the Rejected entry "Capturing on every clip";
- the consequence "a re-clip without capture goes back to links".

It also amends ADR 0044's capture wording, and ADR 0022's premise that the
options page is the only writer of the synced keys. Changes nothing in the
document format, so `tiro.schema` is unchanged.

## Context

ADR 0039 made a picture of a script-drawn figure an explicit step before
Clip. The popup offered "Capture N figures", and the reader then pressed
"Clip to vault" in the same popup. ADR 0044 extended this to every chart drawn
as `<svg>`, which made capturing common. Using it for real showed what an
optional pre-step costs:

- **Two actions for one intent.** Capture, wait, read the note, then Clip.
- **The default gave the worse result.** Clip alone saved a link, so the
  reader had to know to capture first.
- **A fragile gap.** The pictures lived in the popup between Capture and Clip.
  A click on the page the capture had just scrolled closed the popup and
  discarded them, silently. The owner captured the GitHub chart that prompted
  ADR 0044, and it was published as a link this way. A note added in #78 only
  warned about it.
- **Nothing to see.** The popup never showed the picture.
- **A re-clip silently downgraded.** Without a capture it put the link back,
  and processing pruned the picture.
- **Refusals with no reason.** "They stay as links to the page" was all the
  reader learned, whether the figure was taller than the window, covered by a
  banner, or not yet drawn.

## Decision

### 1. One action

On a tab body with drawn figures (ADR 0039, ADR 0044), Clip takes their
pictures first and then commits. The button says so, and how many:
"Clip to vault with 3 pictures", or "Re-clip to vault with 3 pictures". It
keeps "Clip to vault", the words the disclosure promises nothing is sent
before. The hint beside it says how long the capture takes and asks the
reader to keep the popup open.

### 2. Only on the Clip click

Capture still never runs when the popup opens. ADR 0039's objection to
capturing on every clip was moving the page uninvited, for tens of seconds.
A Clip button that names the pictures and states the time is an invitation,
and it comes with a Stop and a remembered opt-out. Opening the popup is
reading a preview; pressing Clip is asking to save the article as it reads.

### 3. A remembered opt-out

A box above Clip, "Save figures as pictures", is ticked by default. Unticked,
Clip commits links as before. Its label carries no count, so the disclosure
can quote it.

The choice is remembered under its own synced key, `tiroCapturePictures`,
the way the language is. That makes the popup a second writer of a synced key.
ADR 0022 accepted a per-realm mutation queue on the premise that the options
page is the only writer; for one boolean, whose worst race is a stale tick on
another machine and never a credential, that premise is relaxed.

### 4. Stop clips with what was taken

During the capture, "Stop and clip" is the only button. It finishes the
picture under way, then commits the pictures taken and links for the rest.

### 5. A popup closed mid-capture commits nothing

The page's watchdog puts the scroll back, and the vault keeps what it had.
That is worse than ADR 0039's loss of the pictures alone: a closed popup now
loses the clip. The hint and the progress both ask the reader to keep the
popup open. A loop owned by the service worker would end this, and is
deferred (Rejected).

What the popup cannot do, gone, the worker does: it says so. From the Clip
click until the commit settles the popup holds a port (`tiro-clip`) and
posts what the clip has reached, `capturing` or `committing`, repeating it
every ten seconds so the worker is not idled out of hearing the port close.
The port closing before the popup posts `done` puts a red "!" on that tab's
toolbar button. Its tooltip says the page was not clipped, or, if the popup
went while committing, that it may not have been: the last write may have
landed. It stays until Tiro is next opened on that tab — the reader closed
the popup by clicking away, and may not look at the button for a while.

A saved clip posts `done` at once. A failed one posts it only after the popup
has outlived the failure by a second. Closing the popup aborts the commit's
requests, and the clip's failure path runs while the page unloads, before
the port closes — measured in Chromium, between `beforeunload` and
`pagehide` — so a `done` posted straight away told the worker the clip had
settled in the very close it listens for, and a popup closed mid-upload left
no badge. A closing page runs no timers, so a closed popup never posts it.
A reader who closes the popup within that second of a real failure sees the
badge too, and it is true: the clip was not saved.

### 6. Why each figure stayed a link, and what to do

The capture records a refusal for every figure it does not take:

| Refusal | Said as | Remedy |
|---|---|---|
| `too-big` | taller or wider than the window | Enlarge the window and clip again. |
| `covered` | covered by a banner or a sticky header | Close the banner or scroll the header away, and clip again. |
| `blank` | not drawn yet | Let the page finish, scroll through it once, and clip again. |
| `moving` | kept moving | Clip again once the page has settled. |
| `changed` | lost when the page changed | Reload, scroll through it once, and clip again. |
| `stopped` | not reached before Stop | none |
| `too-heavy` | too large to keep | none |
| `error` | could not be made | none |

`changed` covers a figure the page removed, a tab that navigated, and a
figure the clip after the capture could not find again.

Once saved, the popup says what the pictures came to in one sentence. The
reasons come most common first, and only the first one that has a remedy gives
it, since a list of instructions would be read as none. The popup also shows
the pictures themselves.

### 7. A failed commit keeps the pictures

The body carrying the pictures is pinned once they are taken. Retrying Clip
commits the same pictures without scrolling the page again.

### 8. Re-clips keep their pictures

Capturing is the default, so a re-clip takes the pictures again. An unticked
re-clip says it will replace the pictures an earlier clip saved.

### 9. A leftover request is cleared

A popup that closed between leaving its snapshot request in the page and
running the clipper left the request behind. The next popup's own clip took
it and answered as a capture nobody was waiting for, and that popup sat on
"Reading…" until its fallback gave up. Every ordinary clip now clears such a
request first.

## Rejected

- **Capturing when the popup opens.** That moves the page uninvited, which is
  ADR 0039's objection and still right.
- **Keeping a separate Capture button.** That is the two-step flow this
  replaces.
- **Committing links first and the pictures in a second commit.** It costs
  two commits, two processing runs, two deploys, and a state on the site
  between them that the reader did not ask for.
- **A confirmation step before capturing.** The button already says what it
  will do.
- **Remembering the choice per site.** One box, one meaning, is easier to
  trust and to see.
- **The service worker owning the loop, for now.** It would let the popup
  close freely, which is the real cure for §5. Two things make it its own
  change:
  - `clip-commit.ts` imports the `@tiro/shared` root, which invariant 6 keeps
    out of the worker.
  - ADR 0039 kept page pixels out of the worker on purpose.

## Consequences

- **A Clip on a figure page takes longer**, about two seconds per figure,
  and closing the popup during that time saves nothing. The toolbar says so
  afterwards; nothing can save it.
- **The box's choice follows the reader** to their other machines when
  settings sync is on.
- **The disclosure stays at version 7.** Its capture sentence is reworded:
  7 has not been released, as ADR 0039's own wording also joined it.
- **Capture is still checked only live.** The scroll, the screenshot and the
  crop need a real browser.
