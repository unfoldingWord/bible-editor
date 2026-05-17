# CLAUDE.md

> **No remote backend deployed yet.** `--remote` D1 migrations, `wrangler deploy`, OAuth callbacks, and any path through `uw-bt-bot` will fail until provisioning per [`docs/deploy.md`](docs/deploy.md). Work in `--local` mode only. **Remove this notice once we've deployed.**

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Context

- Tactical 7-month replacement for gatewayEdit + tcCreate. Read [`docs/plan.md`](docs/plan.md) and [`docs/handoff.md`](docs/handoff.md) before non-trivial work.
- We borrow a lot of code from `../tcc-ge-dcs` — look there for help/inspiration.
- We are intentionally rethinking the backend to remove DCS from the loop except for once daily.
- Volta-pinned: Node 24.15.0, npm 11.12.1. npm workspaces (`api/`, `web/`).

## Common commands

Run from repo root:

```sh
npm install
npm run dev          # parallel: wrangler (api, :8787) + vite (web, :5173 with /api proxy)
npm run typecheck    # tsc --noEmit across both workspaces
npm run build        # api typecheck + web vite build → web/dist
npm run deploy       # builds web, then `wrangler deploy` from api/ (bundles SPA as [assets])

npm run test:e2e     # Playwright concurrency suite (auto-starts dev server)
npm run test:e2e:ui  # same, with Playwright UI

# single Playwright test
npx playwright test tests/concurrency/s2-same-verse.spec.ts -g "<grep>"
```

API-only operations (from `api/`):

```sh
npx wrangler d1 migrations apply bible_editor --local    # apply migrations locally
npx wrangler d1 migrations apply bible_editor --remote   # apply migrations to prod
npx wrangler d1 execute bible_editor --local --file=../scripts/out/import-ZEC.sql
npm run tail                                              # wrangler tail (live API logs)
```

Web-only:

```sh
npm --workspace web run test    # node strip-types runner for src/lib/alignment.test.mjs
```

Importing books / lexicon (from repo root):

```sh
node scripts/import-book.mjs ZEC      # generates scripts/out/import-ZEC.sql
node scripts/import-lexicon.mjs       # UHAL + UGL → scripts/out/import-lexicon.sql
```

Fresh git worktree: run `scripts/worktree-init.ps1` from the worktree root to junction `node_modules` from main (skips `npm install`). If you bump deps in the branch, delete the junctions and run `npm install` so changes don't leak into main.

## Architecture

### Save protocol — the single reliability claim

The whole point of this project: **edits never touch DCS in the hot path.** Every keystroke flows:

1. Component updates local React state immediately.
2. Debounce → push op into IndexedDB outbox (`web/src/sync/outbox.ts`).
3. Drain worker FIFOs each op as `PATCH /api/rows/{kind}/{id}` (or `/verses/...`) with `If-Match: <expected_version>`.
4. **200** removes op, updates local version. **409** surfaces a merge prompt and re-queues. **401** triggers silent JWT refresh — outbox is never cleared on auth failure. **5xx/network** retries with backoff; durable across tab close.
5. Cron Workflow at 06:00 UTC renders D1 → TSV + USFM and commits to a DCS fork branch (`live-snapshot`). If that fails, edits stay safe in D1; next night catches up.

The fetch client in `web/src/sync/api.ts` is the only thing that talks to `/api/*`. Don't bypass it — its `If-Match` / 409 / 401 handling is what makes the outbox correct.

### Backend (`api/`)

- Cloudflare Workers + Hono router. Entry: `api/src/index.ts`. One Worker serves both `/api/*` and the SPA (bundled into `[assets]` via `wrangler.toml`).
- D1 SQLite stores tn/tq/twl rows, verses (`content_json` = `usfm-js` per-verse object), lexicon, edit_log audit, pipeline jobs, verse_statuses. Migrations in `api/migrations/`.
- R2 (`BLOBS`) stores USFM originals + export snapshots.
- Durable Object `ChapterRoom` (`api/src/chapterRoom.ts`) — per-`{book}/{chapter}` WS presence + change fanout. WS messages are hints; **HTTP + `If-Match` is the source of truth**.
- Workflow `ExportWorkflow` (`api/src/exportWorkflow.ts`) — nightly DCS export, one retryable step per `book × resource`. Triggered by the 06:00 cron in `scheduled()`.
- Second cron `*/5 * * * *` polls non-terminal pipeline_jobs (AI auto-apply needs to fire even when no translator has a tab open). The `scheduled()` handler branches on `controller.cron`.
- Auth (`api/src/auth.ts`): DCS OAuth → our own JWT (TTL decoupled from DCS access token). Dev mode mints via `POST /api/auth/dev` (gated by `DEV_AUTH_ENABLED`); `web/src/App.tsx` silently mints on first load in `import.meta.env.DEV`.
- AI pipeline proxy: `/api/tn-quick` and `/api/pipelines/*` forward to `uw-bt-bot.fly.dev` (override via `TN_QUICK_URL` / `PIPELINE_API_BASE`). Absence of `BT_API_TOKEN` disables those routes.

### Frontend (`web/`)

- React 18 + Vite + MUI v6 + emotion. Vite dev server proxies `/api/*` → `127.0.0.1:8787` (Wrangler).
- Single `Shell` (3-column: Timeline rail · Scripture column · Resource column) with three scripture modes — **rows** (stacked active-verse card), **columns** (parallel doc), **book** (lazy-loaded whole book via IntersectionObserver). Alignment is a separate panel/dialog wrapping a custom HTML5 DnD aligner (NOT `enhanced-word-aligner-rcl`; see `docs/plan.md` for the Vite/Rollup bundler reason).
- Hooks: `useChapter` (rows + verses + statuses), `useBook` (summary for nav), `useLexicon` (UHAL + UGL by Strong's), `useCatalogs` (ta / tw type-ahead lists), `useAiDrafts`.
- Routing is hash-based: `#/{book}/{chapter}/{verse}` (see `parseHash` in `App.tsx`). `useBook` is hoisted in `App.tsx` so its chapter cache survives chapter navigation.
- USFM ↔ JSON via `usfm-js`. Word alignment data is part of the per-verse JSON tree; `\zaln-s`/`\zaln-e` round-trip losslessly. `web/src/lib/alignment.ts` and `web/src/lib/replace.ts` handle smart text edits that preserve alignments when word counts line up.
- Hebrew Unicode: UHB stores combining marks in legacy "consonant-dagesh-vowel" order; milestones from ZEC/LAM come out NFC. Every Hebrew↔Hebrew compare must go through `nfc()` from `web/src/lib/hebrew.ts` (see `docs/handoff.md` for measured impact).

### Note save semantics

Notes save on deactivation/unmount, not on blur. This is intentional. Don't suggest changing it.

### Concurrency tests (`tests/concurrency/`)

One Playwright worker, no test-level parallelism — every test shares the seeded ZEC fixture and races multiple `browserContext`s *inside* one test (the parallelism is per-test, not across tests). Running tests in parallel would cross the streams.

The `webServer` polls `/api/health` through Vite's proxy so it waits for **both** Vite and Wrangler to be up before tests start.

### Deploy

Single command from repo root: `npm run deploy` builds `web/dist` then `wrangler deploy` from `api/`. The Worker serves both `/api/*` and the SPA. See [`docs/deploy.md`](docs/deploy.md) for first-time provisioning (D1 create, R2 bucket, secrets `JWT_SIGNING_KEY` / `DCS_CLIENT_ID` / `DCS_CLIENT_SECRET` / `DCS_SERVICE_TOKEN` / `BT_API_TOKEN`).

Production must set `ALLOWED_ORIGINS` (CORS allowlist) and `DEV_AUTH_ENABLED=false` in `wrangler.toml`.
