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

What remains is narrow and worth stating exactly, because the earlier version of
this record claimed more than the code did: a machine is left with defaults only
if its worker has seen no change *and* it has never read since sync was enabled.
Such a machine never used the settings either.

Enabling never overwrites a value `sync` already holds. On a second machine,
sync already carries the settings and the form on screen is empty or stale;
flipping the toggle must adopt the shared settings, not push a local copy over
them.

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
