# ADR 0019: Short links — `/s/<id>`, derived from the slug, never assigned

Status: accepted (2026-09). Adds an alias; does not touch the identity contract
of ADR 0002 or the flat layout of ADR 0007.

## Context

Article URLs are long, because the slug is built to be readable in a git
checkout rather than pasteable in a chat. The longest in the vault today is 104
characters:

```
https://tiro.ainaive.com/articles/web-archive-org-web-20030201183139-http-mpt-phrasewise-com-d-f0d84dc2/
```

Wanting something shorter is the obvious half. The trap is the obvious answer to
it — mint a short id per article and remember which is which. That would put a
registry in the system: a counter or a random id, a map from it to the slug, and
somewhere durable to keep that map, which for this system means a file in the
vault. Every consequence of that is bad. Identity stops being a pure function of
the URL and becomes a table lookup, which is exactly what ADR 0007 removed. The
map is mutable state that can drift from the articles it describes. And a
committed file pairing every id with every slug would enumerate the vault,
including the articles ADR 0017 exists to keep out of exactly such a list.

None of it is necessary, because **a short id already exists**. `slugForUrl`
ends every slug with eight hex characters of the SHA-256 of the normalized URL
(`packages/shared/src/slug.ts`). Reading that suffix back out yields an id
produced by the same pure function that named the directory — so nothing has to
remember it, and any component that can compute a slug can compute the short
link without being told.

## Decision

- **`/s/<id>` redirects to `/articles/<slug>/`.** The id is
  `shortIdForSlug(slug)`: the slug's trailing 8-hex group, matched anchored, not
  sliced. A directory name that does not end in a hash yields `null` and gets no
  short link — `validate` is what keeps names derivable, and a name that escaped
  it must degrade to "no short link" rather than have eight arbitrary characters
  handed out as though they were a hash.

- **`/s/`, not `/a/`.** It reads as short/share. `/a/` sitting beside
  `/articles/` invites the reading that they are one route family and that
  either is the article's home; only one is.

- **The long URL stays canonical.** `/articles/<slug>/` is the address in the
  sitemap, the feed, `og:url` and `rel=canonical`. The alias is a way in, not a
  second identity. The `/s/` pages carry `noindex` and name the article as
  canonical, and are filtered out of the sitemap.

- **A clash drops the id from every article involved.** Two articles could in
  principle derive the same id. The kinder-sounding repair — keep one, give the
  other something else — is the worse one: the id would then depend on which
  article was seen first, and the site is rebuilt from scratch on every deploy,
  so a clash resolved one way today could resolve the other way tomorrow and
  silently re-point a link someone had already shared. A short link that 404s is
  a visible failure; one that quietly leads somewhere else is not. Both long
  URLs keep working regardless, and the build warns.

  Dropping rather than refusing the build is deliberate and follows the same
  reasoning as the empty-library guard in `articles.ts`: the deploy builds
  before it uploads, so a refusal leaves the *previous* deployment live.

  For the record, at 32 bits: ~1 in 900,000 at today's 97 articles, ~1 in 8,600
  at a thousand, ~1.2% at ten thousand. If it ever fires, the fix is a longer id
  — which stops it being the slug's own suffix and costs a hash per article at
  build time — not a registry.

- **Unlisted articles get short links.** An unlisted article's URL *is* its
  sharing mechanism (ADR 0017), so it is the one that most wants to be short.
  The alias is kept out of the sitemap for the same reason its long URL is.

- **Two mechanisms, deliberately.** `scripts/short-redirects.ts` generates
  Cloudflare `_redirects` lines so the edge answers a real 301, and the
  prerendered `/s/<id>/` page is what answers when that map is not in play. The
  page carries the article's own `og:` tags, because a link-preview scraper that
  stops at the alias rather than following the redirect should still show the
  right card.

  The generated map is written into `dist/` at build time and **never
  committed**: a file pairing every id with every slug is the enumeration this
  ADR and ADR 0017 both refuse.

- **One rule, two callers.** `buildShortLinks` in
  `apps/site/src/lib/short-links.ts` is a pure function of a list of slugs. The
  Astro route feeds it the content collection; the `_redirects` generator feeds
  it a directory listing after the build. Neither restates the collision policy.

## Consequences

- No new frontmatter field, no `tiro.schema` bump, no vault migration, no
  registry. The vault does not know short links exist.

- **The short link is not a stable identifier.** The hash is taken of the
  normalized URL and `canonicalizeUrl` runs *inside* `normalizeUrl`, so a
  canonicalization change (ADR 0013) moves the short id along with the readable
  base, exactly as it moves the long URL. `sweep --recanonicalize` therefore
  breaks short links too, and `docs/operations.md` says so where it already
  warns that slug migrations break URLs. The alias is shorter, not more durable.

- A shared short link exposes the same thing the long one does. The id is
  computable by anyone who knows the source URL, as the slug already was — ADR
  0017's "obscurity, not access control" is unchanged, in neither direction.

- Cloudflare Pages allows 2,000 *static* redirects plus 100 dynamic ones, a
  combined 2,100. Every rule here is static — a short id cannot be a
  placeholder, because only the map knows which slug it belongs to — so 2,000 is
  the budget and the extra 100 is not ours to spend. One line per article puts
  that a long way off at 97, the build warns before it is reached, and the page
  fallback keeps working past it for anything the map drops.

- **The rule carries the trailing slash, and one rule covers both forms.**
  Cloudflare matches redirect paths literally, so `/s/<id>` and `/s/<id>/` are
  different rules; the share button copies the latter, so that is the one that
  must exist. A slash-less request is normalized by Pages with a 308 to the
  canonical path, which then matches — one extra hop on a URL nothing generates.
  Registering both forms would halve how many articles fit under the cap to buy
  that hop back. `shortLinkPath` is the single definition of the path, called by
  both the share control and the rule generator, because the first version of
  this spelled it twice and they disagreed.
