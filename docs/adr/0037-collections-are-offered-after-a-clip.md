# ADR 0037: Collections are offered after a clip

Status: accepted (2026-10). Extends ADR 0029, which offered collections only
on a Tiro page.

## Context

ADR 0029 put collection editing on the Tiro page: the popup reads the page's
`#tiro-page` island, which carries the catalog, and draws a tick-list from it.
That is the right place to curate what is already in the library, and the wrong
place to file what has just been saved. Filing a fresh clip meant waiting for
the processing run and the deploy, opening the article on the site, opening the
popup there, and ticking — minutes later, in a second visit. The moment a reader
knows *why* they saved something is the moment they clip it, and that was
exactly when the popup could not help.

The owner asked for collections at clip time, as an optional step in the same
popup.

## Decision

### The tick-list appears under the clip once it has saved

When a clip commits, the popup reads the vault's collections and shows the same
panel a Tiro page shows, under the saved links: favorites first and always (the
first tick creates `favorites.md`), then every collection in the site's order —
favorites, then by `updated_at` as an instant, then id — then any created on
this machine and not yet in the vault, and "New collection…". A re-clip comes up
with its memberships already ticked, read from the vault itself.

Everything after the tick is ADR 0029's machinery, unchanged: the toggle goes to
the service worker, the only writer of the queue; the queue flushes as one
commit when the popup closes or on "Save now"; the footer counts what is
pending. Ticking nothing changes nothing — the step is optional and the clip is
already done.

### After the clip, not before it

A picker beside the preview, ticked before Clip, was considered and rejected:

- **The disclosure promises nothing reaches the vault before the Clip click.**
  Listing `collections/` before then is a request to the vault all the same.
  The alternative — a catalog cached on the machine — is empty the first time,
  misses a collection made on another machine, and cannot say which collections
  already hold a re-clip until after the commit anyway.
- **The flush accepts an add only for an article the vault has**
  (`articles/<slug>/index.md` at head, ADR 0029). Before the clip there is
  none; after it, there is.
- **It is no fewer clicks.** Tick, Clip, close is three; Clip, tick, close is
  three.

Nor is the clip and its collections one commit. The clip is a Contents-API PUT
with its own conflict rebuild (ADR 0017's `unlisted` carry, ADR 0026's stub
body); folding collection files into it would mean rebuilding that path on the
Git Data API for a saving of one push, and the site's deploy group already
collapses the two builds to the newest.

### The catalog is read from the vault, at one commit

`readClipCollections` reads every file under `collections/` from the head
commit, with the same pinned reader `commitFiles` hands a builder, so the list
never mixes two states. Reading the ref first means an unreachable vault throws
rather than reading as "no collections". Only after the clip has committed,
and after the clip record is written (below).

A collection file that does not parse is left out of the list and counted in
the intro; every other collection can still be ticked, and the flush refuses to
rewrite the broken one anyway. The read failing outright costs one line under
the clip — "Could not read your collections" — and never relabels the clip,
which is saved whatever happens here.

### An add for an article just clipped is deferred, not refused

GitHub's read side can trail its write by a moment; the popup already knows
this from Remove, which says "not visible yet" for an article it has just
clipped. A flush right after a clip can therefore read a head without the new
`index.md`, and ADR 0029's rule refuses such an add — and a refused add is
dropped for good, because for a slug from someone else's Tiro site it could
never succeed.

For a slug this machine clipped within the last ten minutes, read from the clip
history it already keeps, "not there" now means "not yet": the add is
**deferred** — neither sent nor refused — so it stays pending and the next
close or "Save now" tries again. If Save now meets it, the footer says GitHub
has not shown the article yet and that the change is kept. Past ten minutes the
old rule applies again: a clip removed elsewhere, or a vault switched, is
refused as any other add. Remove's `forgetClip` clears the record, so a removed
article never earns the grace.

### The disclosure moves to version 7

Version 6 had shipped (0.16.0), and placed collection writes on Tiro pages —
"On a Tiro site … the popup offers collections instead". A box ticked on an
ordinary page and committed on close is a write that sentence does not cover.
Same destination and no new permission, but a narrower description than what
the extension now does, so the number moves and every install re-accepts once.

## Consequences

- The popup now reads the vault on an ordinary page, once per clip: one ref
  read, one listing, one read per collection file. Trivial against the API's
  rate limit for a personal vault, and never before the Clip click.
- A clip that is ticked into a collection is two pushes — the clip, then the
  collections flush — and so two deploy dispatches, which the site's deploy
  group collapses to the newest when they overlap. The collections push may build the site before
  processing finishes; the article is already in the vault, so it is a member,
  and its card fills in when processing's own deploy lands.
- Out of scope, and unchanged: "Clip link" in the right-click menu, the iPhone
  shortcut and the options page's PDF import. The first two write a URL to
  `inbox/` and the article does not exist until the processor runs; carrying a
  collection through that would need a new inbox format the processor
  understands, which is its own decision.

## Rejected

- **A picker before Clip, from a locally cached catalog.** See above: no fewer
  clicks, a stale or empty list, and no truthful membership for a re-clip.
- **Reading the catalog when the popup opens.** Breaks the disclosure's one
  hard promise for the sake of a list most clips will not use.
- **One commit for the clip and its collections.** Rebuilds the clip's write
  path for a saving the deploy group already makes.
- **Retrying a deferred add inside the worker on a timer.** An MV3 worker can
  be stopped at any time, so a timer is not a guarantee; the queue already is,
  and the next popup close is never far off.
