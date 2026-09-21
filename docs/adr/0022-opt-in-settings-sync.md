# ADR 0022: Settings sync is opt-in, and the disclosure is not part of it

Status: accepted (2026-09). Reverses the "settings do not sync between
machines" decision recorded in `docs/operations.md`, which held that
`chrome.storage.sync` was ruled out because it would upload the PAT to Google.
That reasoning was right about the cost and wrong to treat it as settling the
question; what changes here is who decides, not whether the cost exists.

## Context

Every install of the clipper is configured by hand: GitHub owner, repository,
branch, and a fine-grained PAT typed into the options page. A second machine
means minting or re-pasting a token and re-entering three more fields, and a
reinstall means doing it again. For a tool whose whole promise is "clip in one
click", four fields of setup per machine is the largest remaining friction.

`chrome.storage.sync` removes it exactly: same API shape as `local`, replicated
across every device signed into the same Chrome profile, degrading to
local-only behaviour when the user is not signed into sync. The `storage`
permission already covers it, so nothing about the extension's permission
surface changes.

The reason it was rejected before is real and does not go away:

- **The token leaves the machine.** Chrome sync encrypts in transit and at
  rest, but unless the user has set a sync passphrase the key is derived from
  their Google account, so Google can decrypt it. A PAT in `local` is already
  plaintext on disk; the change is that it is now also on Google's servers.
- **It ends per-machine revocation.** `docs/operations.md` recommends minting a
  separate PAT per machine so a lost laptop can be revoked without breaking the
  others. One synced token is one revocation that breaks every machine at once.

Against that: the PAT is fine-grained and scoped to `Contents: Read and write`
on the vault repository alone. It cannot touch another repository and cannot
act on the account. The blast radius is one private content repo.

## Decision

**Sync is opt-in, off by default, and the user turns it on.**

The cost above is real but bounded, and it is a trade the owner of the account
is in a position to price and a default is not. Off by default also means every
claim the extension and the site currently make about on-device storage stays
true for anyone who never flips the switch — which matters because the
extension is on the Web Store and is not only installed by its author.

Three further choices follow from it:

**The flag lives in `sync`, not `local`.** A per-device flag would still make
every new machine a manual step, just a shorter one. Putting `tiroSyncEnabled`
in the synced area is what makes a second machine genuinely zero-setup: Chrome
pulls the flag down along with the settings beside it.

**`local` is kept current three ways, and it takes all three.** Writes go to
`local` always, and to `sync` as well when enabled. Reads record what they take
from `sync`. And the service worker mirrors synced changes as Chrome delivers
them. This is what makes turning sync *off* safe on every device at once —
disabling copies `sync` down on the machine that does it, clears the synced
keys, and every other machine falls back to a copy of its own. Clearing them is
the point of disabling rather than tidying after it: it is what takes the token
back off Google's servers.

Writes alone are not enough, and the omission strands exactly the machine this
feature exists for: a second computer configured entirely from the synced copy
never calls a writer, so a write-only mirror leaves it holding nothing, and
withdrawing the synced keys drops it to defaults.

Reads alone are not enough either, and the failure is quieter. A mirror
refreshed only when *this* machine reads is only ever as new as its last read:
if it read v1, another machine saved v2 and then switched sync off, it falls
back to v1 — settings that are not merely old but wrong, and wrong without
complaint, since a stale repository clips to the wrong destination and only a
stale token announces itself. So `background.ts`, until now an empty module,
registers a `chrome.storage.onChanged` listener. ADR 0005 governs how the
worker is built, not what it may do, and that file's own comment always
described it as the home for work of this kind.

**A removal must never be mirrored.** Switching sync off elsewhere reaches every
other machine as the synced keys disappearing. Copying that through would erase
the copy the machine is about to need — the guard becoming the failure it was
written to prevent — so only a change carrying a real `newValue` is taken.

### What this does not guarantee

Stated exactly, because earlier versions of this record twice claimed more than
the code delivered.

**A machine can be left with defaults** if its worker has seen no change *and*
it has never read since sync was enabled. Such a machine never used the
settings either.

**A machine can be left with a value older than the last one written.** Chrome
synchronises state, not an event log, and does not replay intermediate values.
If a machine is closed or offline while another saves v2 and then switches sync
off, it reconnects to the final state — the keys gone — having never been told
about v2, and falls back to the last value it saw. The mirror's promise is
therefore "the newest value this machine has observed", not "the newest value
written anywhere", and no amount of mirroring can make it the latter.

**A write racing a disable on another machine can briefly restore the token.**
Chrome takes seconds to propagate a disable, so a save here can read a stale
`true`, write, and undo a removal the user asked for. Two things narrow it: a
save re-reads the flag after writing and withdraws its own copy if the flag has
gone false, and whichever machine observes the switch go off clears synced
settings that outlived it. Neither closes it — the other machine's disable may
still be in flight when both checks run — and closing it properly needs a
versioned tombstone or equivalent profile-wide protocol, which
`chrome.storage.sync` gives no compare-and-set to build on. What holds is
weaker and worth stating as such: no machine knowingly leaves a token in sync
after seeing the flag go false, and any machine that later sees the disable
removes what is there.

**An empty form cannot be told from empty settings, so an incomplete config is
refused.** Amended 2026-09, after the case arrived: a profile where Chrome Sync
is off, paused, or excludes extension data — `SyncDisabled` or
`SyncTypesListDisabled` on a managed machine — degrades `chrome.storage.sync`
to a private local-only area, silently, and the options page then shows exactly
the empty form a first run shows. Pressing Save there published the emptiness.
The write reached the synced area, Chrome delivered it as a change carrying a
real `newValue`, and every other machine's worker mirrored it down — the mirror
three paragraphs above, the one that exists so no machine is left without
settings, becoming what spread the loss, with no copy left anywhere. So
`saveConfig` refuses any config `isConfigComplete` rejects, and enabling will
not push one up.

**The same rule binds on ingress, and that is not redundant.** Refusing to
publish only binds the machines running the refusal: every machine during a
rollout is on the older build, and one that never updates stays there, so an
incomplete config can still reach the synced area. All three ways a synced
value comes back down would then copy it faithfully — the mirror inside
`readSynced`, the worker's `onChanged` mirror, and the copy-down that
disabling performs, the last being the one most easily missed, since copying
down before removing is itself a guard against leaving a machine with nothing.
So an incomplete config never displaces a complete one, whichever direction it
arrives from. It is still adopted by a machine whose own copy is incomplete:
the guard protects the better copy, and refusing outright would strand exactly
the machine sync exists to configure. Read in the other direction the same
rule says a complete config may *replace* an incomplete one, which is what
enabling does — otherwise the residue is permanent and invisible, since every
configured machine is shielded from it and only the machines arriving fresh,
having no copy to be shielded by, take it. This also fixes what the rule is judged
by — the check compared fields to `""` against a value the type system had
vouched for, while half its callers pass raw `chrome.storage`, and
`loadConfig` deliberately tolerates a partial object from an older version, so
a legacy `{owner, repo}` read as complete and travelled without a token.

**A profile whose sync is already on is not healed automatically.** If an
older machine publishes an incomplete config while `tiroSyncEnabled` is
already `true`, no configured machine calls `setSyncEnabled(true)` again, so
the repair above never fires: every machine that has settings of its own is
shielded by the ingress guard and notices nothing, while a machine arriving
fresh adopts the incomplete value and has to be set up by hand. Any Save from
a configured machine overwrites it, and so does switching sync off and on
again — the copy-down is safe now, since it keeps the better copy — so the
state is recoverable, and it stops being reachable at all once no machine on
the profile predates the refusal. `docs/operations.md` carries the procedure.

Repairing it on observation was considered and rejected. Doing it in the
service worker would make the worker a writer of these keys, and "the options
page is the only writer" is the premise the per-page mutation queue above
rests on — breaking it silently invalidates that accepted trade rather than
re-deciding it. Doing it in `readSynced` would put a write to the synced area
on the most frequent path in the extension, widening the write-racing-a-
disable hazard exactly where it is hardest to reason about. Both are a poor
trade against a transitional fault whose worst outcome is one machine
configured by hand, which is what every machine did before sync existed.

Neither guard can adjudicate a *complete* config that is merely wrong, and
nothing here makes sync work where the profile forbids it; what they remove is
the one-click path from "sync did not arrive" to "settings are gone
everywhere". Chrome offers no way to ask whether sync is on or whether
extension data is in it — `chrome.identity` answers a different question and
would cost an install-time permission warning and a store re-review — so the
product states the precondition and names `chrome://settings/syncSetup` rather
than detecting it.

**Mutations are serialised per page, not per profile.** The queue in
`storage.ts` is module state, so each options tab and the worker hold their
own. A save issued in one options tab at the same instant as a sync toggle in
another can still finish with the newer config local and the older config in
sync, whereupon the next read restores the older one. This is accepted rather
than fixed: the options page is the only writer of these keys, and
`chrome.runtime.openOptionsPage` focuses an open options page instead of
opening a second, so two of them at once takes deliberate effort. The fix, if
the trade ever stops being worth it, is to make the worker the single authority
and route mutations to it — a messaging layer, and a new way for a save to fail
on a path that currently cannot.

Enabling never overwrites a value `sync` already holds. On a second machine,
sync already carries the settings and the form on screen is empty or stale;
flipping the toggle must adopt the shared settings, not push a local copy over
them.

**One exception, added later: a synced config that cannot clip counts as
absent** when the enabling machine's own copy can. That is not settings anyone
chose but the residue of an older machine's empty save, and "adopt, never
clobber" is otherwise exactly what preserves it forever. The rule is the
ingress rule read backwards — if an incomplete config may never displace a
complete one, a complete one may replace an incomplete one — and it is
deliberately no wider than that: republishing a local copy over any *complete*
synced value would break the headline case this paragraph exists to protect.

**Two keys stay in `local` unconditionally.**

`tiroClipHistory` is excluded on a hard constraint, not a preference. It is a
single key holding up to 500 entries, roughly 35–50 KB; `chrome.storage.sync`
caps one item at 8,192 bytes, so syncing it would start throwing on a
well-used vault. It is a per-device hint by design anyway (see the storage
notes in `docs/operations.md`), and the clip flow checks GitHub
authoritatively regardless.

`tiroDisclosure` is excluded by choice. Consent to read the open page belongs
to an install, not to an account. Syncing the acceptance would let a fresh
install skip the first-run disclosure before it first reads a page, which is
the one thing the disclosure exists to prevent. One click per machine is a far
cheaper price than that, and it is not "settings" in the sense the request was
about — nothing is typed.

## Consequences

- `DISCLOSURE_VERSION` moves to 3 and every existing user re-accepts once. A
  credential reaching Google's sync servers is a new outbound destination, and
  a stronger one than the arxiv.org case that justified the move to 2.
- The in-product token hint, the Web Store listing's permission justification
  and data-use declarations, and the public privacy page all stated that
  settings are local to the machine and not synced. All become conditional on
  the setting, in both locales.
- `docs/operations.md` keeps the per-machine-PAT recommendation, now scoped to
  users who leave sync off, and states plainly what turning it on costs.
- A user who enables sync and later loses a machine must revoke a token every
  other machine is also using. That is the trade, taken knowingly.
- Reading the flag answers "off" if the read fails, rather than throwing:
  `local` is kept current, so falling back to it still finds settings, whereas
  throwing would leave the popup with no config and no way to clip. **Only the
  read path may do this.** A write that took the same shortcut would store the
  config locally, report success, and let the older synced copy win again the
  moment the read recovered, so writes read the flag strictly and fail loudly.
