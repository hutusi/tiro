# ADR 0036: Removing an article from the extension

Status: accepted (2026-09). Takes up the Remove that ADR 0015 left out of the
popup redesign, and hardens the processing workflow's commit-back against the
deletion it makes routine.

## Context

Removing an article has only ever been a hand edit: delete its directory,
and — since collections (ADR 0029) — drop its slug from every collection that
names it, commit both together, push. ADR 0015 listed a popup Remove as "a new
capability, not a restyle" and left it for its own decision.

The likeliest moment to remove something is right after clipping it by
mistake. That is also exactly when the vault's processing run is working on
it: the clip's own push started that run. And the run's commit-back could not
survive it. It rebases onto `main` with `-X theirs`, which settles two edits of
one file but not an edit of a file `main` deleted — the rebase stops on a
modify/delete conflict, the step fails, and every article the run finished,
with every translation checkpoint it wrote, is thrown away. Files the run
*added* under the deleted article (`zh.md`, the checkpoint, `assets/`) did not
even conflict: they would have been replayed onto `main` as an orphan directory
the site publishes images from. A hand deletion always had this flaw; a button
makes it the common case.

## Decision

### 1. Two places offer Remove, and both ask the vault first

The control is the same in both: "Remove" with a small trash icon at the left
of the popup's footer, opposite Settings — quiet, and out of the way of the
actions a page is opened for. It opens a confirmation card just above the
footer: a heading, the article's title, a note saying what goes and that
history keeps it, and Cancel beside Remove. Never a browser dialog.

- **On a Tiro article page**, beside the collections the popup already shows
  there. The slug comes from the page's `#tiro-page` marker. The page itself is
  never clipped — it is a rendering of an article that came from somewhere.
- **On the page the article came from**, when this machine's clip record says
  it was clipped — the "already clipped" and just-saved states. The slug is
  derived from the tab's URL, as a clip derives it.

Neither is trusted to name what gets deleted. The marker is deliberately not
tied to a hostname (ADR 0029), so any page can carry one, and a slug in it
could name a different article of yours than the page shows; the clip record
is local and blind to other machines. So Remove first reads the article's
`index.md` from the vault, and the card names **the vault's own title** and
the repository. An article that is not there says so, and
nothing is committed.

That lookup reads the branch ref before the file. The Contents API answers 404
both for a missing file and for a repository the token cannot see; read alone,
a misconfigured token would report every article as "already gone" and the
popup would forget clips that are still there.

### 2. What is removed: the directory, and every mention of it

An article is its whole directory — `index.md`, `zh.md`, `assets/`, and the
processor's checkpoints — so every file under `articles/<slug>/` is deleted,
found by listing the directory at the head being committed on. "An article"
means what `validate` means: a directory without an `index.md` is not one, and
removing it is "not in your vault".

Every collection naming the slug drops it, and a collection whose pinned
`cover` is one of the article's images loses the cover — whether or not the
article is a member — and falls back to one built from its members (ADR 0030).
`updated_at` is left alone: the site orders collections by it, and a removal is
not the owner deciding anything about the collection.

A collection file that cannot be parsed stops the removal only if its text
contains the slug. Slugs end in a hash, so a file that does not contain it does
not name the article, and a broken collection unrelated to this one should not
make an article impossible to remove.

Both lists — the article's files and the collections — come from the Contents
API, which returns at most 1,000 entries of a directory and says nothing when
it stops. A listing that reaches that cap is refused, not trusted: acting on
part of `collections/` would report the removal done while leaving the article
named in every collection past the cut. It is refused for every listing the
extension reads, not only these two, since a partial one answers "is it there"
wrongly too. A vault meets it only with 1,000 collections, or an article with
1,000 images.

### 3. One commit, through the Git Data API

The article's files and the changed collections go in one commit made the way
collection edits already are (ADR 0029): read the head, build against it,
create a tree on it, commit, move the branch without forcing. A deleted file is
a tree entry with `sha: null`, which GitHub documents for exactly this. If
anything commits in between — typically the processing run finishing this very
article — the ref update is refused and the commit is rebuilt from the new
head, so files that run just added are listed and deleted too.

It runs in the popup, like a clip. The ref update is the only step anyone sees,
so a popup closed halfway leaves the vault as it was, and reopening it offers
Remove again.

After a removal the popup forgets this machine's clip record for the article
and ends there: it does not offer Clip, so the article is not re-added by a
click meant for something else. Reopening the popup offers Clip as usual.

### 4. The collections queue is left alone

A queued add for the removed article is already refused when the queue is
flushed — the flush checks the article's `index.md` at the head it commits on —
and a queued removal from a collection it has left is a no-op. Nothing needs
clearing, and a removal never writes the queue, whose one writer is the
service worker.

### 5. In the commit-back, a deletion wins

`process.yml`'s commit step now measures, before each rebase, which articles'
`index.md` `main` deleted since the run checked it out, and restores each of
those directories in the run's own commit to what the run started from. The run
then replays nothing under a deleted article: no modify/delete conflict, and no
orphan. Everything else it did commits as before. A run whose whole work was
under deleted articles commits nothing, and says so.

The run logs a notice naming each directory it dropped. A slug rename by
`sweep --recanonicalize` also deletes an `index.md`, and is treated the same
way: that run's work on the article is redone at its new slug.

The step also declares `shell: bash`, so it runs as `bash -eo pipefail`
rather than the bare `bash -e` GitHub uses for a step that names no shell, and
records `committed=true` only after its push succeeds rather than before.

## Consequences

- Removal is not erasure. The vault's git history keeps every version, and the
  confirmation says so. Erasing an article means rewriting that history.
- The site drops the article on its next deploy, which the removal's own push
  starts (ADR 0032). When collections changed too, `publish.yml` dispatches a
  second deploy; the deploy workflow cancels the older one.
- A link saved to `inbox/` for the same URL, still waiting for its run, brings
  the article back as a stub. So does any later save or clip of it — slugs are
  derived from the URL, so it returns at the same address.
- Removing the vault's last article removes `articles/` itself, and the site's
  build refuses a vault without one (ADR 0006); the previous deployment, still
  listing the article, stays live. The operations runbook says to keep one.
- Another machine's clip record still says "already clipped" until its own
  Remove finds the article gone and forgets it.
- A hand deletion of a single file inside an article a run is modifying — its
  `zh.md`, say — still stops the rebase. The step now aborts it and says so
  rather than failing on a half-finished rebase; the run's work is redone next
  time, as before.
- The template's `process.yml` does not propagate: the live vault needs it
  copied in by hand, and until then the race is open there.
- The disclosure's version 6 describes Remove. Neither 5 nor 6 has been
  released, so the sentence joins 6 rather than asking every user to accept a
  7.

## Rejected

- **One `sha: null` entry for the whole directory.** Shorter, and it is
  reported to work, but GitHub documents `sha: null` for files; a delete that
  silently did nothing would leave an article the popup reported removed.
- **The Contents API's DELETE.** One commit per file: an article with images
  would be a burst of commits, each a push, a workflow run and a build, and
  collections would be edited in yet another commit after them.
- **Refusing to remove an article processing has not finished.** Closes the
  race without touching the workflow, but it blocks exactly the mistaken clip
  this exists for, and spends LLM credit translating a page before it may be
  thrown away.
- **Running the removal in the service worker.** The queue needs it there
  because a collection edit outlives the popup; a removal is one confirmed act
  the reader watches finish, like a clip.
- **`unlisted` as a soft delete.** It exists already (ADR 0017) and keeps the
  article built and reachable at its URL; it answers a different question.
- **Refusing to remove the last article.** It would cost a listing of all of
  `articles/` on every removal to prevent a state a personal vault does not
  reach, and the runbook already covers it.
