# AI Pipeline Integration — Handoff

You are picking this up mid-flight. Read this end-to-end, then [`docs/ai-pipeline-integration.md`](./ai-pipeline-integration.md) (the contract between bible-editor and bp-assistant), before doing anything else. Both are short.

## Status (last update: 2026-05-13)

**Phase 1 shipped and verified live.** A successful tqs run for `ZEC 3` was triggered from the editor against bp-assistant on `uw-bt-bot.fly.dev`. The pipeline completed; the editor's polling surfaced state transitions correctly; the output landed on Door43 via the bot's existing `repo-insert` flow. The doc you are reading covers what's next.

Out of scope so far — every one of these is "still to do":
- Parsing the Door43 output (`output[].rawUrl`) back into the editor's D1.
- Any UI for reviewing or accepting AI-generated content.
- Marking AI-authored rows distinctly in `edit_log` or in the UI.
- Worker-side cron polling (today: browser polls only while a tab is visible).
- Per-stage progress beyond `current.skill`.
- Cancellation.

## One-paragraph mental model

`bible-editor` runs as a Cloudflare Worker + D1 + React/Vite SPA. Translators edit translation notes / questions / word links / aligned ULT-UST verses; edits land in D1 first and DCS gets a nightly snapshot. There is an external "AI pipeline" service ([github.com/unfoldingWord/bp-assistant](https://github.com/unfoldingWord/bp-assistant), deployed at `uw-bt-bot.fly.dev`) that runs Claude-Code-driven skills to generate chapter-scale ULT/UST/notes/questions. Runs take ~30–100 minutes. The editor can now trigger those pipelines and watch their state. The pipeline writes results to Door43 (`unfoldingWord/en_{ult,ust,tn,tq}` repos). **The editor does not yet read those results back** — that's Phase 2.

## What exists today

### Backend

| File | Purpose |
|---|---|
| [`api/migrations/0008_pipeline_jobs.sql`](../api/migrations/0008_pipeline_jobs.sql) | New `pipeline_jobs` table. Stores per-job state, output blob (verbatim JSON), error info, timestamps. Indexed on `(user_id, state, updated_at)` and `(book, start_chapter, pipeline_type, state)`. |
| [`api/src/pipelines.ts`](../api/src/pipelines.ts) | Three handlers: `POST /api/pipelines/start`, `GET /api/pipelines/:jobId`, `GET /api/pipelines?state=...`. Auth-gated via the existing JWT middleware. Pulls DCS username from JWT (never from request body) and injects it into the upstream payload, so a caller can't attribute runs to other translators. Bearer-swap to `BT_API_TOKEN` upstream — same shared secret as `/api/tn-quick`. |
| [`api/src/index.ts`](../api/src/index.ts) | Route registered at `/api/pipelines`. New `PIPELINE_API_BASE` env var added to the `Env` interface. |
| [`api/wrangler.toml`](../api/wrangler.toml) | `PIPELINE_API_BASE = "https://uw-bt-bot.fly.dev"` default. Override per env if/when bp-assistant moves. |

### Frontend

| File | Purpose |
|---|---|
| [`web/src/sync/api.ts`](../web/src/sync/api.ts) | Types for `PipelineStartRequest`/`StatusResponse`/`JobRow` mirror the partner contract. Three new client methods: `pipelineStart`, `pipelineStatus`, `pipelineList`. |
| [`web/src/sync/pipelineStore.ts`](../web/src/sync/pipelineStore.ts) | In-memory store with the same `subscribe(fn) => unsubscribe` shape as [`outbox.ts`](../web/src/sync/outbox.ts). Hydrates on first subscribe via `GET /api/pipelines`. Polls each non-terminal job every 2 minutes while the tab is visible (pauses on `document.hidden`, resumes on `visibilitychange`). Emits completion events via `onComplete(fn)`. Persists a per-browser `sessionKey` in localStorage as `bible-editor/{userId}/{uuid}`. Includes a `findActive(type, book, chapter)` helper for the trigger UI. |
| [`web/src/components/PipelineMenu.tsx`](../web/src/components/PipelineMenu.tsx) | Button + dropdown + confirmation dialog in the chapter view, just below `TopBar`. Three options (`generate`, `notes`, `tqs`). Disables an option when a non-terminal job for the same `(type, book, chapter)` already exists locally. Handles `409 conflict` (another translator triggered it) by showing a toast rather than erroring. |
| [`web/src/components/PipelineStatusBar.tsx`](../web/src/components/PipelineStatusBar.tsx) | Bottom-area pill (sits left of `SyncStatusBar`). Shows running count, expands to a per-job panel with state, current skill, elapsed time. "Retry" button surfaces for `errorKind ∈ {transient_outage, usage_limit, interrupted, sdk_error}` — re-POSTs the start body and the server resumes from checkpoint. Accepts a transient toast from parent for "started" / "already running" messages. |
| [`web/src/components/Shell.tsx`](../web/src/components/Shell.tsx) | Mounts `PipelineMenu` below `TopBar` and `PipelineStatusBar` next to `SyncStatusBar`. Owns toast state for both `PipelineMenu.onMessage` callbacks and `pipelineStore.onComplete` events. |

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

This is the next concrete piece of work. Bp-assistant returns an `output[]` array on `state: "done"` (see contract §4 and §6). Each element has a `rawUrl` pointing at a file on Door43. The editor needs to fetch, parse, and surface those changes for the translator to review. Recommended phasing within Phase 2:

### 2a. Parser only (~half a day)

Goal: when a `pipeline_jobs` row transitions to `state = "done"`, fetch each `output[i].rawUrl`, parse it into structured row payloads, store the structured form in a new table. **No UI yet, no integration into the chapter view yet.** This phase proves the parsers work and lets you eyeball results in `wrangler d1 execute`.

Output shapes per contract §6:
- `pipelineType: "generate"` → two `output[]` entries: USFM files at `{nn}-{BOOK}.usfm` in `unfoldingWord/en_ult` and `unfoldingWord/en_ust`. **Whole-book USFM** — extract only the chapter the job ran for.
- `pipelineType: "notes"` → one entry: TSV at `tn_{BOOK}.tsv` in `unfoldingWord/en_tn`. **Whole-book TSV mutated in place** — read all rows, filter to the chapter range from `pipeline_jobs.start_chapter…end_chapter`.
- `pipelineType: "tqs"` → one entry: TSV at `tq_{BOOK}.tsv` in `unfoldingWord/en_tq`. Same caveat — whole-book file.

Reusable parsing infrastructure already in the repo:
- `usfm-js` (already a dependency) — `usfm.toJSON(raw)` returns `{ headers, chapters }`. The [`scripts/import-book.mjs`](../scripts/import-book.mjs) is the existing canonical example of USFM → verse-objects → D1 row payload. Lines ~100–135 are the verse-walking + plain-text extraction; lines ~119–135 are the recursive token walker. **Don't reinvent this — extract it into a shared `lib/usfmImport.ts` that both the script and the new inbound code import.**
- TSV: `scripts/import-book.mjs` lines ~143–156 has a naive split-by-tab parser that's been battle-tested against the unfoldingWord TSVs. Same: extract to a shared module rather than re-implement.
- Verse-object alignment (`\zaln-s` milestones, `\w` tokens): the parsers already preserve it in `content_json`; `web/src/lib/alignment.ts` knows how to read/write it.

The natural Worker entry point: a new function in [`api/src/pipelines.ts`](../api/src/pipelines.ts) (or a new sibling file `api/src/pipelineImport.ts`) called from the existing `GET /api/pipelines/:jobId` handler when the upstream response says `state: "done"` AND `output_json` was previously NULL. Fetch each `rawUrl`, parse, write to staging. Idempotent on re-poll — already-imported jobs become a no-op.

Decision needed up front: **the staging schema**. Three viable shapes (the original exploration agent identified four; here's the trimmed list):

| Option | Schema | Pro | Con |
|---|---|---|---|
| **A. `pending_imports` JSON-blob table** | One new table; `(job_id, kind, book, chapter, verse, payload_json)` | One table for all four kinds (tn/tq/verse-ult/verse-ust); cleanest separation; easy to drop a whole proposal set if rejected | Accept-action must materialize blob → row, not atomic with normal write path |
| **B. `proposed_at` column on existing tables** | Add `proposed_at INTEGER` to `tn_rows`/`tq_rows`/`twl_rows`; new `verse_proposals` for verses | Live queries filter `WHERE proposed_at IS NULL`; accept is just `UPDATE … SET proposed_at = NULL` | Forget the filter once, AI rows leak into the editor; verses are awkward (composite PK so "two versions of one verse" doesn't fit) |
| **C. Shadow tables per kind** | `tn_proposals`, `tq_proposals`, `verse_proposals` mirroring the live shapes | Clean separation, can index proposals independently | Schema duplication; accept = cross-table INSERT |

**Recommendation: Option A.** The "JSON blob" downside is mostly aesthetic — the accept-action would be `INSERT INTO tn_rows … SELECT FROM (json_extract proposal payload)`, which D1 can do in one statement. Option A is also kind-agnostic, which matters since the proposal volume is heterogeneous (`generate` writes 20–200 verses, `notes` writes 50–500 TN rows).

Tentative shape:

```sql
CREATE TABLE pending_imports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT    NOT NULL REFERENCES pipeline_jobs(job_id),
  kind            TEXT    NOT NULL,        -- 'tn' | 'tq' | 'twl' | 'verse'
  book            TEXT    NOT NULL,
  chapter         INTEGER NOT NULL,
  verse           INTEGER NOT NULL,
  bible_version   TEXT,                    -- 'ULT' | 'UST' for kind='verse', NULL otherwise
  payload_json    TEXT    NOT NULL,        -- row body suitable for the live POST/PATCH path
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  accepted_at     INTEGER,
  accepted_by     INTEGER REFERENCES users(id),
  rejected_at     INTEGER,
  rejected_by     INTEGER REFERENCES users(id)
);
CREATE INDEX pending_imports_job ON pending_imports(job_id);
CREATE INDEX pending_imports_scope ON pending_imports(book, chapter, kind);
```

**Talk to the user before committing to this.** They explicitly opted for the smallest-first PR last time; they may want to split Phase 2a into "parse and dump to a sandbox table" first and defer schema decisions to 2b.

### 2b. Surfacing in chapter view (~1 day)

Goal: a translator viewing `#/ZEC/3` sees "this chapter has AI-proposed changes" once Phase 2a has populated the staging table. The simplest first slice:

- Add a count to `PipelineStatusBar`'s expanded panel: "5 ULT verses, 47 notes, 12 questions proposed."
- Add a "Review proposals" button per resource section (notes column, questions column, scripture column).
- Don't yet render the proposals inline — clicking the button opens a dialog/drawer listing them.

### 2c. Per-row accept-reject UI (~2 days)

Goal: the dialog from 2b becomes a real review surface. For each proposed row:
- Show the proposed content alongside the current live row (if any) — visual diff.
- Accept / Reject / Skip-for-now buttons.
- Accept all / Reject all at the top.
- For verses: render the proposed USFM with alignment cards so the translator can eyeball it before committing.

Code locations to copy from:
- `NoteCard.tsx`'s confirm dialog pattern (line ~641) is the right MUI surface for the per-row UX.
- `AlignmentDialog` is the existing model for "review a verse with alignment context before committing."
- The "switch to v{N}" history dialog (`NoteHistoryDialog`) is the existing pattern for "accept this snapshot" → flows through the normal outbox/PATCH path.

### 2d. Accept-action wiring (~1 day)

Goal: clicking Accept materializes a proposal into the live D1 tables via the **existing** write paths. **Don't bypass them.**

- TN/TQ/TWL row creation: existing `POST /api/rows/:kind` ([`api/src/rows.ts`](../api/src/rows.ts) line ~104). Mints a server-side 4-char id, INSERTs into the live table, appends to `edit_log` with `action='create'`. Reuse it.
- TN/TQ/TWL row update (when proposal overlaps an existing row): existing `PATCH /api/rows/:kind/:id` with `If-Match: <version>`. Pre-flight check on the client: if the live row's `version` doesn't match what we saw when we surfaced the proposal, surface a conflict in the dialog ("the translator changed this since the AI ran — show diff or skip?").
- Verse update: existing `PATCH /api/verses/:book/:chapter/:verse/:bibleVersion` with `If-Match`.
- Edit log provenance: this is the place to add `source = 'ai_pipeline'` to the `edit_log` row. The contract gives us `X-AI-Pipeline:` commit trailer on the Door43 side; we should mirror that on the editor side so audit history shows AI-authored rows distinctly. Implementation: add an optional `source` column to `edit_log` in migration 0009, plumb it through the row/verse PATCH handlers when the proposal-accept path sets it.

Each accept goes through the outbox, so a translator who accepts 50 notes and then closes the tab still gets all 50 committed when they reopen.

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

A fresh agent picking up Phase 2 should resolve these with the user **before writing code**:

1. **Staging schema choice.** Option A vs B vs C above. Recommendation: A.
2. **Conflict resolution policy when a translator has edited the same row.** Three plausible defaults:
   - (a) Show the live edit, hide the AI proposal as "superseded by your edit at HH:MM."
   - (b) Show both, let the translator pick. **Probably the right default** — that's the whole point of staging.
   - (c) Auto-reject the proposal if the live row's `version` is newer than the snapshot when bp-assistant started. Aggressive; loses good AI suggestions.
3. **Worker polling vs browser polling timeline.** Phase 1 ships browser-only. Phase 3.1 adds Worker polling. The user may want this earlier than 3.1 — ask before assuming.
4. **Proposal lifetime.** When do `pending_imports` rows get cleaned up? Options:
   - On accept or reject (clean, but loses the audit trail of "rejected this AI suggestion").
   - Soft-delete via `rejected_at` (the column shown in the schema sketch above).
   - Never — keep forever for analytics on "AI quality."
   The schema sketch picks soft-delete. Confirm with the user.

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
2. Run `npm run dev`, navigate to `#/ZEC/3`, click **AI pipelines → Write translation questions** to confirm the round-trip still works in the user's current environment. (If they already have a `done` job in `pipeline_jobs` from earlier testing, skip this — the staging work is what they need next.)
3. Check `wrangler d1 execute bible_editor --local --command "SELECT job_id, pipeline_type, book, start_chapter, state FROM pipeline_jobs ORDER BY updated_at DESC LIMIT 5;"`. There should be at least one `done` row from the recent ZEC 3 tqs success — that's your Phase 2a fixture.
4. Ask the user the four "Open architectural decisions" questions above. Don't write code until they've answered #1 and #2 (staging schema and conflict policy).
5. Once those land, plan Phase 2a in `plans/` and proceed.

Do NOT propose changes to bp-assistant from inside this repo. That's a separate session in a separate clone with its own Claude. If you discover the contract needs revision, write up the proposed change as text and hand it to the user to relay.
