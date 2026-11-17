# Bitrix24 KB 2.0 Deploy Action

Deploys Markdown files from a GitHub repository into a [Bitrix24 Knowledge Base 2.0](https://apidocs.bitrix24.com/api-reference/note/index.html)
via REST 3.0 (`note.*` methods). Written in TypeScript on the official [actions/toolkit](https://github.com/actions/toolkit) (`@actions/core`),
bundled to a single `dist/index.js`, runs on the **node24** runtime.

## Features

- 🌳 Directory structure → page hierarchy (`parentId`), directories become pages
- 📝 Front matter `title:` support; `index.md`/`README.md` is a directory page content
- 🔁 Idempotent: a manifest (`repo path → document ID`) prevents duplicates and enables updates
- 🗑️ Removed files are archived in Bitrix24 (subtree-aware)
- 🚦 Retries with backoff on `429`/`5xx`, honors `Retry-After`
- 🧮 Pre-flight checks for KB 2.0 limits (markdown ≤ 1 048 576 bytes, title ≤ 255 chars)
- 📋 Job summary with deploy stats

## Setup

1. In your Bitrix24, create an **incoming webhook** (`Developer resources → Webhooks → Add webhook`)
   with the **`note`** (Knowledge Base 2.0) scope. The webhook owner must have **edit** access
   to the target knowledge base. REST API requires a commercial plan (Vibe+).
2. Store the full webhook URL in the repo secret `BITRIX24_WEBHOOK_URL`.
3. The action commits the manifest file (`.kb-manifest.json`) back to the repo itself
   (via `@actions/github`) — it keeps document IDs stable between runs. Needs `contents: write`.

```yaml
# .github/workflows/deploy-kb.yml
name: Deploy docs to Bitrix24 KB
on:
  push:
    branches: [main]
    paths: ['docs/**/*.md', '.kb-manifest.json']

permissions:
  contents: write   # for committing the updated manifest back

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy to Bitrix24 Knowledge Base 2.0
        uses: <your-username>/bitrix24-kb-deploy-action@v1
        with:
          webhook-url: ${{ secrets.BITRIX24_WEBHOOK_URL }}
          # collection-id: 42          # or find/create by title:
          collection-title: Product Knowledge Base
          content-dir: docs
          # github-token: ${{ github.token }}  # default; commits the manifest back
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `webhook-url` | ✅ | — | Incoming webhook URL: `https://portal.bitrix24.ru/rest/api/{user_id}/{token}`. Scope: `note`. |
| `collection-id` | — | — | Knowledge base ID. If omitted, searched (or created) by `collection-title`. |
| `collection-title` | — | `GitHub Docs` | Title for finding/creating the knowledge base. |
| `content-dir` | — | `docs` | Directory with Markdown content. |
| `manifest-path` | — | `.kb-manifest.json` | Mapping of repo paths to document IDs. |
| `delete-removed` | — | `true` | Archive pages that disappeared from the repo. |
| `max-retries` | — | `5` | Retries on `429`/`5xx` before failing. |
| `github-token` | — | `${{ github.token }}` | Token for committing the updated manifest back via the Contents API (`contents: write`). Empty string disables the commit. |

## Outputs

| Output | Description |
| --- | --- |
| `collection-id` | ID of the knowledge base used for the deploy |
| `created` / `updated` / `archived` / `unchanged` | Per-run document statistics |

## Content conventions

```
docs/
├── index.md            → page "index" (top level)
├── faq.md              → page "faq" (top level)
└── guide/
    ├── index.md        → page "guide", content from this file
    └── install.md      → page nested under "guide"
```

- A directory becomes a page; its content is `index.md` or `README.md` (empty otherwise).
- Page title: front matter `title:` if present, otherwise the file/directory name:

```markdown
---
title: Installation Guide
---

# How to install
...
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit (strict)
npm run build       # esbuild bundle -> dist/index.js
npm test            # integration test against a mock Bitrix24 REST 3.0 server
```

> **Note:** `dist/index.js` is committed to the repo — GitHub Actions requires the
> compiled bundle. Rebuild and commit it after changing `src/`.
