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
- **Vimeo**: the player address itself, whole. That keeps the `h=` hash an
  unlisted video needs and a `#t=1m30s` start time. No still, so it is a plain
  link.
- **Any other player Readability keeps**, a YouTube playlist included: the
  same, a plain link to the player itself, which a reader can open.

The label is the player's `aria-label` or `title`, unless it is embed-code
boilerplate ("YouTube video player", "embedded interactive content"…). Then it
is "Video", as for a `<video>`.

### 2. One list decides, for Readability and for the conversion

`VIDEO_EMBEDS` starts from Readability's own `REGEXPS.videos`, copied with a
citation (and extended in §3), and `clipPage` hands it to Readability as
`allowedVideoRegex`. The pass
after Readability converts a frame only when its address matches the same
list, held to the start of the address so that a query string merely naming a
player does not count. Readability tests every attribute, so the pass reads
`src` first and then any attribute a lazy loader parked the address in.

The two can therefore never disagree about what an embed is. A frame the list
does not name is left for Turndown to drop, as before; only the raw-body
fallback lets one through.

### 3. A publisher's own player is linked to the publisher's video page

The page that prompted this held no YouTube frame at all. The Atlantic embeds
its own player, `theatlantic.com/video/iframe/595672/`, titled "embedded
interactive content" and lazy-loaded from a `data-src`. That page loads the
YouTube player inside itself, so the video's id is named only there, and the
clip never sees it. Readability's list does not name the host either, so the
frame was dropped before anything could convert it.

`VIDEO_EMBEDS` is therefore Readability's list plus `PUBLISHER_PLAYERS`, a
short list of such players, one entry so far. Readability is told to keep
them, and each becomes a plain link to the publisher's page for the video:
for The Atlantic, `/video/index/<n>/`, which redirects to the slugged address
and plays it (checked live). There is no still, since only the player's page
names one.

A publisher's player joins the list only when its address shape is known to
mean a video. Any other frame from the same host is still dropped.

### 4. The site marks a picture that opens a video, and plays nothing itself

Without a mark, a linked still is a photograph like any other, and nothing
says a click plays something. `rehypeVideoLinks` runs after rehype-sanitize
and gives an `<a>` holding nothing but an image the class `video-link` when
its address opens a video:

- a YouTube watch page;
- a Vimeo video page;
- The Atlantic's video page;
- a video file (`.mp4`, `.webm`, `.mov`, `.m4v`), which is how the clipper
  links a `<video>`'s poster.

The stylesheet draws a play badge centred on the picture. It sits on the
picture, not on the paper, so one style serves every paper. A text link gets
no badge, since its words already say what it is.

The class is added after the sanitizer for the reason Shiki's are (ADR
0009). The schema allows a class on no link, so clipped markup cannot claim
the badge, and only this pass can grant it. The address is matched after
parsing it, so a query string that merely names a video page does not count.

Clicking opens the video where it lives, in the same tab, like every other
link in an article.

## Rejected

- **Embedding a player on the site**, or a click-to-play facade. It would run
  third-party code on a fully public site, and would put an `<iframe>` past the
  sanitizer (invariant 5) for a feature a link already gives.
- **Vimeo's own page, `vimeo.com/<id>`.** It is the nicer link, but a video set
  to "Hide from Vimeo" plays in an embed while that page refuses its readers.
  Nothing in the embed's address says which a video is. The player is the
  address the article was already playing, so it is the one known to work.
- **`maxresdefault.jpg`.** It is the larger still, but YouTube does not make
  it for every video. A still that 404s is a broken image once processing
  falls back to hotlinking it. `hqdefault` exists for every video; it is 4:3,
  so a 16:9 video shows bars above and below.
- **A pass before Readability.** Readability's own allowlist already keeps the
  right frames, and its visibility, comment and promo judgements stand only if
  nothing rewrites the DOM it judges (ADR 0011).
- **Reading the publisher's player page for the real video.** In the
  reader's tab that page is same-origin and readable, but only once a lazy
  loader has loaded it, which happens when the reader scrolls to it. It is
  never there on the saved-link path, which fetches one document (ADR 0034).
  A link that works every time beats a still that works sometimes.

## Consequences

- An article with an embedded video gains one image block, or one link, where
  the video was. Re-clip to pick it up; the 8 corpus articles above, and the
  Atlantic article that prompted this, are owed. The sweep cannot check The
  Atlantic, which refuses its fetches.
- A still is the video's thumbnail, not the moment it starts at.
- `&apos;`-style double escaping in a publisher's `title` reaches the alt text
  as written; markdown decodes it when rendering.
