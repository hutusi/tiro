# ADR 0051: Collections can have sections

Status: accepted (2026-10). Extends ADR 0029. An optional, additive field on a
collection item, so `tiro.schema` is unchanged.

## Context

A collection is an ordered list of slugs, drawn as one list of cards. That is
enough for a shelf a person fills one article at a time, and not for a list
someone else already organized. The first such list in the live vault mirrors
The Electric Typewriter's "200 best articles and essays from The Atlantic",
which comes in 34 sections — Science & Tech, Life, History, Politics — and
reads very differently as 190 undivided cards. The order alone keeps the
grouping but hides where one group ends and the next begins.

## Decision

### `section` on the item, on every member of the section

```yaml
items:
  - slug: "theatlantic-com-…-a"
    section: "Science & Tech"
  - slug: "theatlantic-com-…-b"
    section: "Science & Tech"
  - slug: "theatlantic-com-…-c"
    section: "Computers & the Internet"
```

Consecutive members with the same `section` are one group, drawn under one
heading; a member with no `section` is drawn under none. A collection with no
sections is one untitled group and renders exactly as before.

The heading rides on every member rather than on the first, because the
collection is edited one member at a time by tools that know nothing about
sections:

- **Removing a member never moves another.** The popup's toggle, Remove
  (ADR 0036) and `dropCollectionMember` all filter items. Were the heading the
  first member's alone, removing that member would delete it, and the rest of
  its group would slide silently under the heading before — every one of them
  now listed somewhere the owner never put it.
- **A rename keeps it.** `renameCollectionMember` rewrites the slug and keeps
  the rest of the item, so `sweep --recanonicalize` carries a section with no
  code of its own.
- **The prepend lands under no heading.** The clipper prepends a new member
  without a section (ADR 0029), so it shows above the first heading until the
  owner files it — visibly new rather than quietly misfiled.

A section that comes back after another one is a second group with the same
heading, in file order. The site does not regroup: file order is the curation
order, and no sort overrules it (ADR 0029).

Grouping happens after the listed join, so a run broken only by an unlisted or
missing member is still one group. Under a heading, the article titles become
`<h3>` so the page's outline nests; the look does not change.

### The schema declares it

`CollectionItemSchema` names `section`, for the reason it names `cover` one
level up: the clipper rewrites a collection through the schema, and zod drops
keys it was not told about. Undeclared, every section would be stripped from
every member the next time anyone ticked that collection. An empty or blank
`section` is refused rather than drawn as a heading with no words.

## Consequences

- **The extension must be rebuilt before it touches a sectioned collection.**
  An extension built before this change parses with the old schema and would
  write the collection back without its sections. Nothing else needs to move
  in lockstep: the site before this change ignores the field and draws one
  list, and `validate` accepts it either way.
- A sectioned file is longer — the heading is repeated on every member. It is
  still hand-editable, and it is the price of edits that cannot misfile.
- Headings are plain text. There is no table of contents or per-section
  anchor yet; a long sectioned collection is navigated by scrolling.

## Rejected

- **Heading entries in `items`** (`- section: "Life"` between members). It
  reads best by hand, but every consumer that walks items expects a slug —
  the clipper's tick, `validate`, the rename and the removal — and each would
  have to learn to skip a non-member.
- **The heading on a section's first member only.** Shorter files, and the
  removal and prepend failures above.
- **A collection-level `sections:` map of heading to slugs.** Two places say
  what is in the collection and in what order, and they can disagree.
- **One collection per section.** 34 collections for one list, each a card in
  the gallery and a line in the clipper's tick-list.
