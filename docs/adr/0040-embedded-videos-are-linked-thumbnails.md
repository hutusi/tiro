# ADR 0040: An embedded video becomes a linked thumbnail

Status: accepted (2026-10). Extends what `videosAsPostersIn` does for
`<video>` to embedded players. It touches neither identity nor the document
format, so `tiro.schema` is unchanged.

## Context

A clipped article from The Atlantic was missing the video its original
embeds. That turned out to be a whole class of loss, not one page.

**Turndown is where the video is lost.** Readability keeps an `<iframe>` whose
attributes name a known player (its `REGEXPS.videos`: YouTube, Vimeo,
Dailymotion, Twitch, archive.org…) and cleans every other frame away.
Turndown has no rule for an iframe and writes nothing for one.

**Measured on the sweep's 426 cached corpus pages**, 9 hold a YouTube iframe:

- Readability kept the 8 that sit in an article body: Stratechery ×3, Noema,
  IEEE Spectrum, calebhearth, Sebastian Raschka's Substack and poloclub.
- It dropped the other embeds, and was right to. Two pages carry a floating
  "Latest video" promo, and one blog carries videos in its comment thread.
- Every one of the 8 was then lost. The vault holds no trace of any of them.

So the judgement of *which* frames are content is already right, and is
Readability's. What was missing is a markdown shape for the frames it keeps.

Some of these embeds carry more than an id:

- Raschka's starts at 9:03 (`start=543s`), and the author meant that minute.
- Spectrum's address sits in `data-runner-src` until a lazy loader moves it.
- Stratechery's has a real title. YouTube's default embed code titles every
  player "YouTube video player", which says nothing.

## Decision

### 1. A player Readability keeps becomes the shape a `<video>` already has

`<a href=watch><img src=still alt=label></a>`, which converts to
`[![label](still)](watch)`. It is the shape `videosAsPostersIn` builds for a
`<video>` with a poster, so every later stage already handles it:

- the figure fold treats it as a linked image and folds a caption beside it;
- the processor downloads the still into `assets/` like any image, so the
  article keeps a picture of the video even if the video is taken down;
- translation sees one image block, so `zh.md` stays aligned (ADR 0003);
- the site renders a linked image, and nothing from YouTube runs on it.

Where the link goes and what the still is:

- **YouTube** (`youtube.com`, `youtube-nocookie.com`, `/embed/<id>`): the
  watch page, with the embed's `start` carried as `t`. The still is
  `i.ytimg.com/vi/<id>/hqdefault.jpg`.
- **Vimeo**: the video's own page, keeping the hash an unlisted video needs.
  No still, so it is a plain link.
- **Any other player Readability keeps**, a YouTube playlist included: a plain
  link to the player itself, which a reader can open.

The label is the player's `aria-label` or `title`, unless it is embed-code
boilerplate ("YouTube video player", "embedded interactive content"…). Then it
is "Video", as for a `<video>`.

### 2. Readability's list is the one list

`VIDEO_EMBEDS` is Readability's own `REGEXPS.videos`, copied with a citation,
and `clipPage` hands it back to Readability as `allowedVideoRegex`. The pass
after Readability converts a frame only when its address matches the same
list, held to the start of the address so that a query string merely naming a
player does not count. Readability tests every attribute, so the pass reads
`src` first and then any attribute a lazy loader parked the address in.

The two can therefore never disagree about what an embed is. A frame the list
does not name is left for Turndown to drop, as before; only the raw-body
fallback lets one through.

## Rejected

- **Embedding a player on the site**, or a click-to-play facade. It would run
  third-party code on a fully public site, and would put an `<iframe>` past the
  sanitizer (invariant 5) for a feature a link already gives.
- **`maxresdefault.jpg`.** It is the larger still, but YouTube does not make
  it for every video. A still that 404s is a broken image once processing
  falls back to hotlinking it. `hqdefault` exists for every video; it is 4:3,
  so a 16:9 video shows bars above and below.
- **A pass before Readability.** Readability's own allowlist already keeps the
  right frames, and its visibility, comment and promo judgements stand only if
  nothing rewrites the DOM it judges (ADR 0011).

## Consequences

- An article with an embedded video gains one image block, or one link, where
  the video was. Re-clip to pick it up; the 8 corpus articles above are owed.
- A still is the video's thumbnail, not the moment it starts at.
- `&apos;`-style double escaping in a publisher's `title` reaches the alt text
  as written; markdown decodes it when rendering.
