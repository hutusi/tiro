# tiro-vault

Content vault for [Tiro](https://github.com/hutusi/tiro): clipped articles,
their Chinese translations, and the processing workflow.

## Layout

```
articles/<slug>/index.md   # original article + frontmatter
articles/<slug>/zh.md      # paragraph-aligned Chinese translation
articles/<slug>/assets/    # images downloaded by the workflow
collections/<id>.md               # a hand-picked list of articles (favorites.md is one)
config/tiro.yml                   # LLM provider config + category taxonomy
.github/workflows/process.yml     # the processing workflow
.github/workflows/publish.yml     # redeploys the site when a collection changes
.github/workflows/tokens.yml      # warns before TIRO_DISPATCH_TOKEN expires
```

Articles arrive via the Tiro Chrome extension; the workflow summarizes, tags,
translates, and localizes images, then commits the results back. It also runs
once a day (03:17 UTC), which finishes anything an earlier run left for later.

A translated article also carries `articles/<slug>/.tiro-zh-cache.json` — a
translation checkpoint, keyed by the source text of each block. One run has a
bounded budget (`processing.run_budget_ms`), so an article too long to
translate in one go saves its finished batches there and resumes on the next
run rather than starting over.

It is **kept** once the article completes, pruned to the blocks that article
still holds, so a later re-clip pays only for the paragraphs whose text
actually changed (ADR 0010). It is dropped only when a translation comes out
misaligned — resuming from the blocks that broke alignment would make a
recoverable fault permanent. Leave these files alone; expect them in `git log`,
and expect them to come to roughly 1% of the vault's size.

Collections are the one part of the vault a person writes rather than a
machine. Each file is a title and an ordered list of article slugs; the
filename is the id, so keep it to lowercase ASCII words joined by dashes. A
push under `collections/` redeploys the site through `publish.yml` and never
starts processing. Delete an article and you must also drop it from any
collection that lists it — `tiro-process validate` reports which.

A collection may also carry a `description:` line, shown under its title, and
a `cover:` naming one article image by its vault path,
`articles/<slug>/assets/<file>`. Without a cover, the site builds one from the
members' own pictures (ADR 0030), so most collections never need one.

## Setup

1. Create a new GitHub repository (e.g. `tiro-vault`) and copy the contents
   of this `vault-template/` directory into it (including the hidden
   `.github/` directory). Commit to `main`.
2. Edit `config/tiro.yml` if you want a different LLM provider/model — any
   OpenAI-compatible chat-completions endpoint works.
3. Add two **Actions secrets** (repo → Settings → Secrets and variables →
   Actions):
   - `TIRO_LLM_API_KEY` — your LLM provider API key. Keeping the default name
     is the easy path. To use a different one you must change it in *three*
     places: the secret, `llm.api_key_env` in `config/tiro.yml`, and the
     `env:` key in `.github/workflows/process.yml` — the workflow exports one
     fixed name, while the processor reads whichever name the config gives, so
     changing only the first two fails with `missing API key`.
   - `TIRO_DISPATCH_TOKEN` — a fine-grained PAT that lets both workflows ping
     the site repo to redeploy: token scoped to the `tiro` repository with
     **Contents: Read and write** permission.
4. For the Chrome extension, create another fine-grained PAT scoped to
   **this vault repository** with **Contents: Read and write**, and paste it
   into the extension's options page.

> Fine-grained PATs expire (max ~1 year). `tokens.yml` checks
> `TIRO_DISPATCH_TOKEN` weekly and fails 30 days before it expires, so GitHub
> emails you. Run it once by hand after setup and check the date it prints
> against your token settings. The extension's **Test connection** says when
> its own token expires.

## Manual operations

- **Reprocess one article**: Actions → Process articles → Run workflow, with
  the article's slug (and "force" if it was already processed).
- **Reprocess everything**: run with "force" and no slug.
- A re-run without "force" is always a safe no-op: articles are selected by
  the missing `tiro.processed_at` frontmatter marker, not by push diffs.
- **Hand edits publish themselves.** Hiding an article (`unlisted: true`),
  deleting one, or any other push under `articles/` redeploys the site when the
  processing run it starts ends, even with nothing to process.
- **Updating this vault's workflows**: the files under `.github/workflows/`
  are copies. When the Tiro repo's `vault-template/` changes them, copy the new
  versions in by hand — nothing propagates them.
