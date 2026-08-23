# tiro-vault

Content vault for [Tiro](https://github.com/hutusi/tiro): clipped articles,
their Chinese translations, and the processing workflow.

## Layout

```
articles/<year>/<slug>/index.md   # original article + frontmatter
articles/<year>/<slug>/zh.md      # paragraph-aligned Chinese translation
articles/<year>/<slug>/assets/    # images downloaded by the workflow
config/tiro.yml                   # LLM provider config + category taxonomy
.github/workflows/process.yml     # the processing workflow
```

Articles arrive via the Tiro Chrome extension; the workflow summarizes, tags,
translates, and localizes images, then commits the results back.

## Setup

1. Create a new GitHub repository (e.g. `tiro-vault`) and copy the contents
   of this `vault-template/` directory into it (including the hidden
   `.github/` directory). Commit to `main`.
2. Edit `config/tiro.yml` if you want a different LLM provider/model — any
   OpenAI-compatible chat-completions endpoint works.
3. Add two **Actions secrets** (repo → Settings → Secrets and variables →
   Actions):
   - `TIRO_LLM_API_KEY` — your LLM provider API key. The secret name must
     match `llm.api_key_env` in `config/tiro.yml`.
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
