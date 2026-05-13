# AI Pipeline Integration — Handoff

You are picking this up mid-flight. Read this end-to-end, then [`docs/ai-pipeline-integration.md`](./ai-pipeline-integration.md) (the contract between bible-editor and bp-assistant), before doing anything else. Both are short.

## Status (last update: 2026-05-13)

**Phase 1 shipped and verified live.** A successful tqs run for `ZEC 3` was triggered from the editor against bp-assistant on `uw-bt-bot.fly.dev`. The pipeline completed; the editor's polling surfaced state transitions correctly; the output landed on Door43 via the bot's existing `repo-insert` flow.

**Phase 2a shipped (parser + staging).** On the first `state="done"` poll the Worker fetches each `output[].rawUrl`, parses USFM/TSV, and stages rows into `pending_imports`. Idempotent on re-poll (existence guard on `job_id`; `pipeline_jobs.output_json` is only stamped after a successful import + apply, so a failure auto-retries on the next poll). Validated against `docs/samples/` fixtures: ZEC 3 yields 10 ULT verses, 49 TN rows, 9 TQ rows.

**Phase 2b shipped then mostly removed.** 2b built a placeholder review dialog and per-section "Review proposals" buttons. The model was then revised — AI output is now better than what it replaces, so the default action is **overwrite**, not review. Phase 2c (below) replaced 2b's UI with a lock + auto-apply model. The staging table (`pending_imports`), parsers, endpoint, and 2a importer are preserved; only the user-facing review dialog and the per-section buttons were deleted.

**Phase 2c shipped (lock + auto-apply + TN keep marks).**

- **Server-enforced chapter lock.** [`api/src/chapterLock.ts`](../api/src/chapterLock.ts) returns the first non-terminal `pipeline_jobs` row covering a `(book, chapter)`. [`api/src/rows.ts`](../api/src/rows.ts) checks the lock on POST/PATCH/DELETE and rejects with `409 {error: "chapter_locked", jobId, pipelineType, startedAt}`. PATCH on `tn` is exempt — the first PATCH on an untouched TN doubles as the "keep" action by setting `updated_by`. [`api/src/verses.ts`](../api/src/verses.ts) checks the lock on PATCH.
- **Keep endpoint.** `POST /api/rows/tn/:id/keep` — lock-exempt; bumps version, sets `updated_by`, appends an `edit_log` row with `action='keep'`. Called by the TN card's Keep checkbox.
- **Auto-apply.** [`api/src/pipelineImport.ts`](../api/src/pipelineImport.ts) now does both staging and apply in a single `importJobOutput`. Stage is idempotent on `pending_imports` existence; apply is idempotent per-row via `pending_imports.accepted_at`. TN-delete phase only targets `updated_by IS NULL AND deleted_at IS NULL` rows — re-runs are no-ops. Every apply write attributes `updated_by` to the pipeline-starting user and appends an `edit_log` row with `source='ai_pipeline'`.
- **Edit-log provenance.** Migration [`0010_edit_log_source.sql`](../api/migrations/0010_edit_log_source.sql) adds a nullable `source` column to `edit_log`. Human edits leave it NULL; the apply path sets `'ai_pipeline'`.
- **Frontend lock awareness.** [`Shell.tsx`](../web/src/components/Shell.tsx) derives `chapterLock` from `pipelineStore` (any non-terminal job covering the active chapter), threads it to columns, mounts an Alert banner above the pipeline-menu strip, and surfaces an outbox-result toast when a write is rejected as `chapter_locked`. [`ScriptureColumn.tsx`](../web/src/components/ScriptureColumn.tsx) + [`DocColumn.tsx`](../web/src/components/DocColumn.tsx) + [`BookView.tsx`](../web/src/components/BookView.tsx) OR `locked` into their existing `readOnly` derivation (which already handled UHB/UGNT). [`ResourceColumn.tsx`](../web/src/components/ResourceColumn.tsx) hides "new" buttons when locked. [`QuestionsTable.tsx`](../web/src/components/QuestionsTable.tsx) renders inputs read-only. [`WordsTable.tsx`](../web/src/components/WordsTable.tsx) disables interaction (pointer-events). [`NoteCard.tsx`](../web/src/components/NoteCard.tsx) is the most involved — when locked + `updated_by IS NULL`, the card is read-only with a Keep checkbox at the top of its header; when locked + `updated_by IS NOT NULL`, a Kept chip shows and the card stays editable.
- **Outbox 409 handling.** [`outbox.ts`](../web/src/sync/outbox.ts) gained a `locked` result kind. Ops that hit `chapter_locked` are dropped (not retried) — retrying would race with the auto-apply step. Shell subscribes to result events and toasts a "Edit dropped" message.

Out of scope so far — every one of these is "still to do":
- Marking AI-authored rows visually in the UI (chip from `edit_log.source='ai_pipeline'`). Schema is in place; UI follow-up.
- Worker-side cron polling (today: browser polls only while a tab is visible). If a translator's tab is closed when the pipeline finishes, the next tab-open triggers the apply.
- Per-stage progress beyond `current.skill`.
- Cancellation.

## One-paragraph mental model

`bible-editor` runs as a Cloudflare Worker + D1 + React/Vite SPA. Translators edit translation notes / questions / word links / aligned ULT-UST verses; edits land in D1 first and DCS gets a nightly snapshot. There is an external "AI pipeline" service ([github.com/unfoldingWord/bp-assistant](https://github.com/unfoldingWord/bp-assistant), deployed at `uw-bt-bot.fly.dev`) that runs Claude-Code-driven skills to generate chapter-scale ULT/UST/notes/questions. Runs take ~30–100 minutes. The editor can now trigger those pipelines and watch their state. The pipeline writes results to Door43 (`unfoldingWord/en_{ult,ust,tn,tq}` repos). **The editor does not yet read those results back** — that's Phase 2.

## What exists today

### Backend

| File | Purpose |
|---|---|
| [`api/migrations/0008_pipeline_jobs.sql`](../api/migrations/0008_pipeline_jobs.sql) | `pipeline_jobs` table. Stores per-job state, output blob (verbatim JSON), error info, timestamps. Indexed on `(user_id, state, updated_at)` and `(book, start_chapter, pipeline_type, state)`. |
| [`api/migrations/0009_pending_imports.sql`](../api/migrations/0009_pending_imports.sql) | `pending_imports` staging table. Generic JSON-blob shape: `kind ∈ {tn, tq, verse}`, `payload_json` carries a row body matching the live POST shape. The auto-apply step now stamps `accepted_at` on each row after the corresponding live mutation lands; `rejected_at` is unused under the current overwrite model. |
| [`api/migrations/0010_edit_log_source.sql`](../api/migrations/0010_edit_log_source.sql) | Adds nullable `source TEXT` to `edit_log`. NULL for human edits, `'ai_pipeline'` for rows the auto-apply step wrote. Drives a future "✨ AI" chip in the UI. |
| [`api/src/chapterLock.ts`](../api/src/chapterLock.ts) | `activePipelineForChapter(env, book, chapter)` returns the first non-terminal `pipeline_jobs` row covering this scope (locks are global — any user's pipeline locks the chapter for everyone). `lockedResponseBody(lock)` returns the canonical 409 body. |
| [`api/src/pipelines.ts`](../api/src/pipelines.ts) | Three handlers: `POST /api/pipelines/start`, `GET /api/pipelines/:jobId`, `GET /api/pipelines?state=...`. Auth-gated via the existing JWT middleware. Pulls DCS username from JWT (never from request body) and injects it into the upstream payload. Bearer-swap to `BT_API_TOKEN` upstream. The status-poll handler invokes `importJobOutput` (stage + apply) on the first `done` transition. |
| [`api/src/rows.ts`](../api/src/rows.ts) | Existing POST/PATCH/DELETE for tn/tq/twl rows. Now lock-checked: POST always, PATCH on non-tn kinds, DELETE always. New endpoint `POST /api/rows/tn/:id/keep` is lock-exempt and sets `updated_by` so the auto-apply step preserves the row. `newRowId()` is exported for the apply path. |
| [`api/src/verses.ts`](../api/src/verses.ts) | PATCH now lock-checks before mutating. UHB/UGNT remain blocked via the existing `source_text_is_read_only` 403. |
| [`api/src/importParsers.ts`](../api/src/importParsers.ts) | Pure parsing helpers for USFM (whole-book → verses in a chapter range, with `content_json` + `plain_text`) and TSV (Reference → `[chapter, verse]`). `scripts/import-book.mjs` still has its own copy of the same logic for the one-shot initial-book seeding case (deliberately not refactored — script is stable and standalone). |
| [`api/src/pipelineImport.ts`](../api/src/pipelineImport.ts) | `importJobOutput` now does both phases. **Stage**: fetch each `output[].rawUrl`, parse, INSERT into `pending_imports` (idempotent on existing rows). **Apply**: for every unresolved `pending_imports` row, mutate the live table and stamp `accepted_at`. Per-phase: TN delete (only `updated_by IS NULL AND deleted_at IS NULL`) → TN insert (fresh ids via `newRowId`) → TQ upsert by id → verse update by composite key. Every audit row gets `source='ai_pipeline'`. `updated_by` is the pipeline-starting user. Per-row idempotency means a mid-apply crash retries safely on the next poll. |
| [`api/src/importParsers.test.mjs`](../api/src/importParsers.test.mjs) | Smoke test against `docs/samples/`. Runs with `node --experimental-strip-types --no-warnings src/importParsers.test.mjs`. |
| [`api/src/pendingImports.ts`](../api/src/pendingImports.ts) | `GET /api/pending-imports?book=&chapter=`. Kept after the 2b rollback because it's useful for ad-hoc audit queries from a dev console / wrangler tail. No UI consumes it today. |
| [`api/src/index.ts`](../api/src/index.ts) | Routes registered at `/api/pipelines` and `/api/pending-imports`. `PIPELINE_API_BASE` env var on the `Env` interface. |
| [`api/wrangler.toml`](../api/wrangler.toml) | `PIPELINE_API_BASE = "https://uw-bt-bot.fly.dev"` default. Override per env if/when bp-assistant moves. |

### Frontend

| File | Purpose |
|---|---|
| [`web/src/sync/api.ts`](../web/src/sync/api.ts) | Types for `PipelineStartRequest` / `PipelineRequestOptions` / `StatusResponse` / `JobRow` / `PendingImport` mirror the partner contract. Client methods: `pipelineStart`, `pipelineStatus`, `pipelineList`, `getPendingImports`, `keepNote`. Exports `isChapterLockedBody` for 409 body narrowing. |
| [`web/src/sync/pipelineStore.ts`](../web/src/sync/pipelineStore.ts) | In-memory store with the same `subscribe(fn) => unsubscribe` shape as [`outbox.ts`](../web/src/sync/outbox.ts). Hydrates on first subscribe via `GET /api/pipelines`. Polls each non-terminal job every 2 minutes while the tab is visible (pauses on `document.hidden`, resumes on `visibilitychange`). Emits completion events via `onComplete(fn)`. Persists a per-browser `sessionKey` in localStorage as `bible-editor/{userId}/{uuid}`. Includes a `findActive(type, book, chapter)` helper for the trigger UI. |
| [`web/src/sync/outbox.ts`](../web/src/sync/outbox.ts) | Drain dispatcher now recognizes a `locked` result kind for 409 chapter_locked. Locked ops are dropped (not retried, not surfaced as conflicts) — the auto-apply step will overwrite anyway. `onOutboxResult` fires so Shell can toast. |
| [`web/src/components/PipelineMenu.tsx`](../web/src/components/PipelineMenu.tsx) | Button + dropdown + confirmation dialog in the chapter view, just below `TopBar`. Three options (`generate`, `notes`, `tqs`). For `generate`, four sub-checkboxes (ULT / UST / ULT-align / UST-align) gate on the contract's per-content-type options; when both content types are on, the alignment pair is linked because the pipeline doesn't support asymmetric alignment in one call. Choices persist to `bible-editor.pipeline.generate.options` in localStorage. |
| [`web/src/components/PipelineStatusBar.tsx`](../web/src/components/PipelineStatusBar.tsx) | Bottom-area pill (sits left of `SyncStatusBar`). Shows running count, expands to a per-job panel. For `done` jobs the panel now displays "AI output applied to ZEC N." Retry button surfaces for resumable failure kinds. |
| [`web/src/components/NoteCard.tsx`](../web/src/components/NoteCard.tsx) | When the chapter is locked (`locked` prop = `Boolean(chapterLock)`) AND `row.updated_by IS NULL`, the card is read-only and shows a Keep checkbox in its header (clicking fires `api.keepNote(id)`). When locked but `updated_by IS NOT NULL`, a Kept chip shows and the card stays editable. When not locked, behaves as before. Sparkles disabled while read-only. |
| [`web/src/components/ResourceColumn.tsx`](../web/src/components/ResourceColumn.tsx) | Accepts `locked` + `onKeepNote`. Hides the "new" button on each section head when locked. Threads `locked` to QuestionsTable and WordsTable; threads `locked` + `onKeepNote` to each NoteCard. |
| [`web/src/components/ScriptureColumn.tsx`](../web/src/components/ScriptureColumn.tsx) | Accepts `locked`. ORs it into `readOnly` for ULT/UST verses (UHB/UGNT were already read-only). Threads `locked` to StackedBody and BookView. |
| [`web/src/components/QuestionsTable.tsx`](../web/src/components/QuestionsTable.tsx) | Accepts `locked`. Inputs go `readOnly`; delete buttons hide. |
| [`web/src/components/WordsTable.tsx`](../web/src/components/WordsTable.tsx) | Accepts `locked`. Disables interaction via `pointerEvents: none` + reduced opacity (simpler than threading through every drag handler; TWLs aren't AI-touched so this is purely a UX-consistency carve-out). |
| [`web/src/components/BookView.tsx`](../web/src/components/BookView.tsx) | Accepts `locked`. ORs into the per-cell `readOnly` derivation so editable bibles match the chapter view in book mode. |
| [`web/src/components/Shell.tsx`](../web/src/components/Shell.tsx) | Derives `chapterLock` from `pipelineStore` jobs. Mounts an `Alert` banner above the pipeline-menu row when locked. Subscribes to `onOutboxResult` and toasts when a write is dropped as `chapter_locked`. Threads `locked` to both columns + `handleKeepNote` to ResourceColumn. |

### How to test

```powershell
npm --workspace api run db:migrate:local      # apply pipeline_jobs migration
npm run dev                                   # vite :5173 + wrangler :8787
# Navigate to http://localhost:5173/#/ZEC/3
# Click "AI pipelines" -> "Write translation questions" -> Start
# Watch the bottom-right pill; expand it for details.
```

Local dev auto-signs in as `"dev"` via `/api/auth/dev` (gated by `DEV_AUTH_ENABLED=true` in `wrangler.toml`). No DCS OAuth round-trip needed for testing. `BT_API_TOKEN` and `JWT_SIGNING_KEY` are in `api/.dev.vars`.

Local D1 currently has only `ZEC` imported. Do not trigger pipelines on PSA — the user has explicitly carved PSA out of the editor's scope while other work happens there.

## Phase 2 — Inbound import + review flow

Bp-assistant returns an `output[]` array on `state: "done"` (see contract §4 and §6). Each element has a `rawUrl` pointing at a file on Door43. The editor needs to fetch, parse, and surface those changes for the translator to review.

### 2a. Parser only — DONE

Output shapes per contract §6 (re-iterated for reference):
- `pipelineType: "generate"` → two `output[]` entries: USFM files at `{nn}-{BOOK}.usfm` in `unfoldingWord/en_ult` and `unfoldingWord/en_ust`. Whole-book USFM; extract only the chapter range the job ran for.
- `pipelineType: "notes"` → one entry: TSV at `tn_{BOOK}.tsv` in `unfoldingWord/en_tn`. Whole-book TSV; filter to `pipeline_jobs.start_chapter…end_chapter`.
- `pipelineType: "tqs"` → one entry: TSV at `tq_{BOOK}.tsv` in `unfoldingWord/en_tq`. Same caveat.

Shipped as described in the file table above. Key points a Phase 2b agent needs to know:
- Staging schema chosen was **Option A** (`pending_imports` JSON-blob table). The original three options (A/B/C) are no longer in play — that decision is closed.
- The `payload_json` in each `pending_imports` row mirrors the body shape the existing `POST /api/rows/:kind` accepts (book, chapter, verse, ref_raw, tags, support_reference/quote/note/question/response, occurrence). For `kind='verse'` it's `{book, chapter, verse, bible_version, content_json, plain_text}` — Phase 2d will need to slightly massage this for the verses PATCH path. We deliberately do NOT diff against live rows at import time — every row in range is staged. The review UI in 2b/2c is where the diff happens.
- The pipeline-typed parsers handle the well-known repos (`en_ult`/`en_ust`/`en_tn`/`en_tq`). Anything else lands in `result.skipped` (logged, not stored). Worker logs are the only surface for now; no UI.
- Verse-object alignment (`\zaln-s` milestones, `\w` tokens) is preserved verbatim in `content_json` — `extractVersesForRange` doesn't strip anything. `web/src/lib/alignment.ts` is the existing read/write surface and is the natural starting point for the verse-review UI in 2c.

### 2b / 2c / 2d — all DONE under a revised model

The original 2b–2d plan called for a review dialog with per-row diff + accept/reject + an explicit accept-action step. The user revised the model in flight: AI output is now better than what it replaces, so the default action is **overwrite**, not review. The lock + auto-apply design above replaces the entire 2b–2d arc.

Highlights of the revised design:
- **No review dialog.** Translators don't see "accept this proposal" prompts. The auto-apply step runs on the first done-poll and overwrites verses, upserts TQs by stable id, deletes un-kept TNs, and inserts the AI's new TN set.
- **TN keep checkbox** is the only translator-facing choice. It lives on each TN card during a pipeline run; checking it fires `POST /api/rows/tn/:id/keep` which sets `updated_by` so the auto-apply step skips that row when sweeping un-kept TNs.
- **Server-enforced lock** prevents concurrent edits from racing the apply step. Already-queued offline edits that arrive during a lock are 409'd and discarded (the apply will overwrite anyway).
- **Audit trail** is preserved via `edit_log.source='ai_pipeline'`. A future UI feature can paint a chip on AI-authored rows; the data is in place.

What this trades off vs. the original review plan:
- We lose per-row "show me the diff before it lands." If a translator hated a specific AI suggestion, they'd have to edit it back manually after the apply.
- The dialog infrastructure built in 2b (`PendingImportsDialog`, `pendingImportsStore`, per-section Review buttons) was deleted.
- The `pending_imports` table still exists and is populated — it's now the apply input + audit ledger, not a queue for human review.

## Phase 3+ — follow-ups (each its own plan)

In rough priority order:

1. **Worker-side cron polling.** Today's browser polling pauses when the user closes the tab; an 80-minute `generate` will not complete in the editor's view unless the tab is open. Move polling into a scheduled Worker that runs every 5 minutes against all non-terminal `pipeline_jobs` rows (already filtered by user_id). The completion event fires for the user the next time they sign in. Wire via [`api/wrangler.toml`'s existing `[triggers]` block](../api/wrangler.toml) — second cron alongside the 06:00 export.
2. **AI-provenance display.** Once `edit_log.source` exists (from 2d), show a small "✨ AI" chip on rows whose latest entry has `source='ai_pipeline'`. The chip disappears the next time a human edits the row.
3. **Concurrency UX for shared chapters.** Today, if translator A starts `notes` for `ZEC 3` and translator B also tries, the server returns `409 conflict` with the existing `jobId`. The UI shows a toast. Better: render translator B a read-only view of A's running job, so B can see progress and join the review when it lands.
4. **Per-stage progress for `makeBP` / `generate`.** Contract §4 documents `current.skill` transitions like `initial-pipeline` → `align-all-parallel` → `door43-push` for `generate`. Surface these as a 3-step indicator in the expanded `PipelineStatusBar` panel. Per-wave progress inside `initial-pipeline` is intentionally NOT exposed by bp-assistant.
5. **Cancellation.** Contract §11 says it's not in v1. If the user wants it later, it's a coordinated change with bp-assistant — they'd need a `DELETE /api/pipeline/:jobId` and a corresponding handler.
6. **`generate` chapter macro.** The contract has three pipelineTypes; `generate` is the most expensive (~60–100 min). A higher-level "Generate everything for this chapter" macro that fires `generate` + `notes` + `tqs` sequentially (or in parallel where the contract permits) would save clicks once the basic flow is proven.
7. **`already_running` UX when it's the user's own.** Today a 409 surfaces as a toast. The store should detect "same user, just hit it twice" and silently open the running job's status panel.

## Open architectural decisions

All four original decisions are closed under the revised lock + auto-apply model:

1. ~~**Staging schema choice.**~~ **Closed: Option A** (`pending_imports` JSON-blob table). Shipped in migration 0009.
2. ~~**Conflict resolution policy.**~~ **Closed: no conflict resolution.** Verses and TQs overwrite unconditionally; TNs are wiped except for the ones the translator explicitly Keeps. The chapter lock prevents concurrent edits from creating conflicts in the first place.
3. **Worker polling vs browser polling.** Still open. Browser-only today; Phase 3.1 still tracks "Worker-side cron polling" as a follow-up. With auto-apply, the impact of a closed tab is bigger — the apply doesn't fire until *some* user opens a tab that polls the job to done. The pipeline-starter would be the natural candidate for "fire on next sign-in." Worth surfacing to the user when the topic comes up.
4. ~~**Proposal lifetime.**~~ **Closed: soft-resolved.** Each `pending_imports` row gets `accepted_at` stamped by the apply step. `rejected_at` is never set today (no review path) but the column stays for future audit/undo features.

## Reference material

- **Contract with bp-assistant:** [`docs/ai-pipeline-integration.md`](./ai-pipeline-integration.md). Authoritative on request/response shapes, error codes, output URLs, provenance markers. Read sections 3, 4, 6, 9, and 10 carefully before Phase 2.
- **Approved Phase 1 plan:** `C:\Users\benja\.claude\plans\write-up-a-data-cheerful-penguin.md`. Captures the scoping decisions that led to "trigger + poll + status only" for the first PR.
- **Partner repos:**
  - [github.com/unfoldingWord/bp-assistant](https://github.com/unfoldingWord/bp-assistant) — the bot itself. `src/api/pipeline.ts` (the new endpoint pair) and `src/door43-push.js` (the `repo-insert` flow) are the relevant entry points if you need to verify behavior.
  - [github.com/unfoldingWord/bp-assistant-skills](https://github.com/unfoldingWord/bp-assistant-skills) — the Claude Code skill markdowns. Useful for understanding what a `generate` run actually produces.
- **Project-level handoff:** [`docs/handoff.md`](./handoff.md) — the broader bible-editor "where things live" doc.
- **Architecture decisions:** [`docs/plan.md`](./plan.md) — canonical project plan; AI integration is an addition, not a replacement.

## What to do first

In order, when you start a fresh session with the user:

1. Read this file and `ai-pipeline-integration.md`.
2. Sanity-check the build:
   - `cd api && npx tsc --noEmit`
   - `cd web && npx tsc -b --noEmit`
   - `cd api && node --experimental-strip-types --no-warnings src/importParsers.test.mjs` (parser smoke against `docs/samples/`)
3. Verify lock + auto-apply end-to-end against an **untouched** chapter (ZEC 6–12 — ZEC 3 has prior editor work and a partial tqs run that'd give noisy diffs):
   - Navigate `#/ZEC/7`, click "AI pipelines → Write translation questions" → Start.
   - The chapter banner should appear within ~2s ("AI tqs run in progress…").
   - Try to edit a TQ in the UI — input is read-only. Try via curl — receives 409 chapter_locked.
   - Click Keep on a TN — card flips to editable, Kept chip shows.
   - When the run completes: `wrangler d1 execute bible_editor --local --command "SELECT count(*), source FROM edit_log WHERE row_key LIKE 'ZEC/7%' GROUP BY source"` should show a chunk of `source='ai_pipeline'` rows.
4. Decision **#3** (Worker vs browser polling) is the next open one — with auto-apply, the impact of "tab closed when done" is bigger than under the old review model. Surface it to the user.

Do NOT propose changes to bp-assistant from inside this repo. That's a separate session in a separate clone with its own Claude. If you discover the contract needs revision, write up the proposed change as text and hand it to the user to relay.
