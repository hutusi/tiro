# tiro-vault

Content vault for [Tiro](https://github.com/hutusi/tiro): clipped articles,
their Chinese translations, and the processing workflow.

## Layout

```
articles/<slug>/index.md   # original article + frontmatter
articles/<slug>/zh.md      # paragraph-aligned Chinese translation
articles/<slug>/assets/    # images downloaded by the workflow
config/tiro.yml                   # LLM provider config + category taxonomy
.github/workflows/process.yml     # the processing workflow
```

Articles arrive via the Tiro Chrome extension; the workflow summarizes, tags,
translates, and localizes images, then commits the results back.

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
   - `TIRO_DISPATCH_TOKEN` — a fine-grained PAT that lets the workflow ping
     the site repo to redeploy: token scoped to the `tiro` repository with
     **Contents: Read and write** permission.
4. For the Chrome extension, create another fine-grained PAT scoped to
   **this vault repository** with **Contents: Read and write**, and paste it
   into the extension's options page.

> Fine-grained PATs expire (max ~1 year) — set a reminder to rotate both.

## Manual operations

- **Reprocess one article**: Actions → Process articles → Run workflow, with
  the article's slug (and "force" if it was already processed).
- **Reprocess everything**: run with "force" and no slug.
- A re-run without "force" is always a safe no-op: articles are selected by
  the missing `tiro.processed_at` frontmatter marker, not by push diffs.
