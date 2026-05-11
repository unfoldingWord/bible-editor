# Tactical Replacement for gatewayEdit + tcCreate (7 months, then archived)

## Context

The current gatewayEdit + tcCreate stack costs significant editor time to slow saves, failed saves, and unexpected logouts that take unsaved work with them. The root cause is that DCS (Gitea) is the live concurrency point: every edit is a whole-file TSV rewrite + Git commit, the load-time file SHA goes stale silently, a 401 immediately wipes the auth IndexedDB store (taking any unsaved edits with it), and there is no client-side outbox to survive network/auth blips.

We need an editor that:
- Lets multiple editors work the same book/chapter without clobbering.
- Never loses an edit to a network or auth failure.
- Eventually lands the data back in DCS so the work isn't trapped.
- Shows multiple verses/notes simultaneously (separate UI work, this plan accommodates it).
- Lives ~7 months, then is archived. Bias hard toward simple, boring, and easy to tear down.

Decisions locked via interview:
- **Identity**: DCS OAuth (existing DCS users).
- **Scope**: tn + tq + twl + USFM body + active word-alignment editing.
- **Hosting**: Cloudflare (Workers + D1 + R2 + Durable Objects).
- **DCS flow**: Import once at project start; nightly export at 06:00 UTC of a snapshot commit to a DCS fork branch. DCS is read-only to the editor during the project.
- **Dev loop**: `wrangler dev` on Windows (real Workers runtime via Miniflare; local D1; same code in dev and prod).
- **UI spec**: the user-supplied Timeline Variations design bundle (Screens A/B/C/D — a single shell with stacked/columns/alignment modes). Layout and behavior from the design; **visual styling** matches the existing tcCreate / gatewayEdit look (Material UI), since users are already trained on that grammar.

## Design overview

```
Browser SPA (React)
  ├── Multi-pane editor shell (separate design WIP)
  ├── IndexedDB write-ahead "outbox" — every keystroke buffered, drained by worker
  ├── WebSocket client for presence + change broadcast
  └── HTTP client for REST API (versioned upserts)
       │
       ▼
Cloudflare Workers (API)
  ├── /auth/* — DCS OAuth dance, issues our own JWT (longer TTL than DCS access token)
  ├── /chapters/{book}/{ch} — bulk reads (tn, tq, twl rows + verse JSON trees)
  ├── /rows/{kind}/{id} — single-row upsert with expected_version
  ├── /verses/{book}/{ch}/{v} — single-verse upsert (USFM JSON tree)
  └── /presence (WS) — routed to a Durable Object per book+chapter

  Durable Object: ChapterRoom
    - In-memory list of connected clients
    - Broadcasts row/verse change events on successful writes
    - Serializes writes for its chapter (eliminates D1 contention for that chapter)

Storage
  ├── D1 (SQLite): all structured rows (tn, tq, twl, verses, users, sessions, audit log)
  └── R2: USFM source dump (originals), nightly export archive, alignment auto-save backups

Nightly Cron Worker
  └── Renders D1 → TSV + USFM, commits to DCS fork branch via Gitea API
```

The core move: **DCS is no longer in the save hot path.** Edits land in our own DB. DCS receives a snapshot commit nightly — if that commit ever fails, edits are still safe in D1 and the next night's commit will catch up.

## Data model (D1)

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  dcs_user_id INTEGER UNIQUE NOT NULL,
  dcs_username TEXT NOT NULL,
  dcs_token_encrypted BLOB,             -- only used server-side, for read-back if needed
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (                  -- our JWT refresh tokens, longer-lived than DCS
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER DEFAULT 0
);

CREATE TABLE tn_rows (
  id TEXT PRIMARY KEY,                  -- 4-char sticky ID matching DCS convention
  book TEXT NOT NULL,                   -- e.g. "OBA"
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,               -- 0 for front:intro, "-1" handled at app layer
  ref_raw TEXT NOT NULL,                -- e.g. "1:1" or "front:intro" — preserves edge refs
  tags TEXT,
  support_reference TEXT,
  quote TEXT,
  occurrence INTEGER,
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                    -- soft delete
);
CREATE INDEX tn_chapter ON tn_rows(book, chapter, verse);

CREATE TABLE tq_rows (... same shape, plus question/response ...);
CREATE TABLE twl_rows (... same shape, plus orig_words/twlink ...);

CREATE TABLE verses (                   -- one row per Bible verse
  book TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  content_json TEXT NOT NULL,           -- usfm-js verse object (preserves \zaln-s/\zaln-e)
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (book, chapter, verse)
);

CREATE TABLE edit_log (                 -- append-only audit; cheap insurance
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                   -- 'tn' | 'tq' | 'twl' | 'verse'
  row_key TEXT NOT NULL,                -- id or "book/ch/v"
  user_id INTEGER NOT NULL,
  prev_version INTEGER,
  new_version INTEGER,
  payload_json TEXT,                    -- full new content
  created_at INTEGER NOT NULL
);
CREATE INDEX edit_log_row ON edit_log(kind, row_key);
```

Verse content is stored as the `usfm-js` per-verse JSON object (the same shape `enhanced-word-aligner-rcl` already produces) so alignment markers survive losslessly. **No need to reinvent the alignment format.**

## Save protocol (the key reliability change)

Client side — every field is wrapped with this flow:

1. **Type** → component updates local React state immediately (no flicker).
2. **Debounce 250ms** → push edit to IndexedDB `outbox` table:
   ```ts
   { kind: 'tn', id: 'xm1w', expected_version: 7, payload: {note: '...'}, queued_at: t }
   ```
3. **Outbox worker** drains FIFO: `PATCH /rows/tn/xm1w` with `If-Match: 7`.
4. Responses:
   - **200** → row deleted from outbox; local state updated with `new_version`.
   - **409 version mismatch** → server returns current row. Client merges (default: last-edit-wins for solo fields like `note`; conflict prompt for structural fields). Re-queue at new version.
   - **401** → silent token refresh (we hold a long-TTL JWT for our API; the DCS token is only needed at login). Retry. **Outbox is never cleared on auth failure.**
   - **5xx / network** → exponential backoff, max 30s. Outbox is durable across tab close/crash.
5. **Service Worker** keeps the outbox alive; on next page load, drain resumes. A pre-unload handler warns only if drain is incomplete after a grace period.

Why this works for our failure modes:
- **Slow saves**: row-level upsert is ~1KB vs whole-file TSV (50KB+). D1 single-row write is sub-100ms p99.
- **Failed saves**: outbox retries silently. Edits don't get lost just because the network blinked.
- **Unexpected logouts**: our JWT TTL is decoupled from DCS token TTL. If our JWT expires, silent refresh. If refresh fails, login modal — **outbox is preserved**, drain resumes after re-login.
- **Two editors same row**: 409 with merge UI; very rare in practice (different authors usually work different verses).
- **Two editors same chapter, different rows**: trivially fine — different primary keys.

## ChapterRoom Durable Object (presence + fanout)

One DO per `{book}/{chapter}`. Clients viewing that chapter open a WS to it. The DO:
- Tracks who's connected (user_id, current verse/row focus).
- Brokers writes for its chapter: client can POST through the DO, which writes to D1 and then fans out the change to all other connected clients with the new version stamp.
- Broadcasts presence updates ("Alice is editing tn 1:3 xm1w").

WS messages are presence/freshness hints. **The HTTP API with `If-Match` is the source of truth.** If the WS drops, the editor still works correctly; you just lose live presence until reconnect.

## UI implementation (Timeline Variations design)

The user's design bundle ships four "screens" that are actually **four modes of one shell**, not four different pages. Source: `ge-tcc/project/Timeline Variations.html` (extracted from the design URL; will be copied into `docs/design/` in the new repo for reference).

**Shell (always present)**

- **Timeline rail** (~54-64px wide, left edge): vertical column of verse numbers for the current chapter. Each tile shows: empty / `has` (yellow dot = has resources) / `warn` (⚠ glyph = has issues) / `active` (filled blue). Click to navigate; cursor keys / J-K scroll.
- **Scripture column** (middle, flex): toolbar at top with `columns` toggle, `📍 stick` snap-back, and a version segment picker (ULT | UST | UHB | +). Body changes between **stacked** and **doc** modes (see below). `📍 To 1:4` snap-back pill in bottom-right when active verse is offscreen.
- **Resource column** (right, flex): toolbar with verse ref + count chips. Body is a vertical stack of sections (Notes, Words, Questions) each with a header showing count and a green `＋ new note` / `＋ add` button.

**Scripture column · stacked mode (Screen A — default)**

- Verses render as `scripVerse` rows: dim for non-active (ULT line above, UST line below indented, no UHB), `active` for current.
- The active verse renders as a single `activeEdit` blue card with three lines: `ULT` editable, `UST` editable, `UHB` read-only (Hebrew, RTL). Each line has an inline ⌭ `alignClip` icon → opens alignment modal for that version of that verse.
- Browser spellcheck enabled via `contenteditable="true" spellcheck="true"` on editable lines.

**Scripture column · doc mode (Screens B/C)**

- Toggled by the `columns` icon in the toolbar. When on, the version segment picker becomes the source of truth for which versions show as parallel columns (1, 2, or 3).
- Each visible version becomes a `docCol` rendering verses as a continuous Word-style document: `docVerse` rows, each editable (ULT/UST) or `ro` (UHB). Verse number `vnum` is inline at the start of each verse, with a ⌭ alignment icon right after.
- Active verse gets the blue `active` halo; clicking any verse makes it active.
- Cursor traverses verses naturally — typing across a verse boundary stays in the same column.
- Resizer hint between scripture column and resource column when ≥2 columns are on (drag-to-resize, persisted to localStorage per user).

**Resource column · Notes section**

- Each `noteCard` (default expanded) shows:
  - **Head**: grip handle `⋮⋮`, 4-char `noteId` chip (e.g. `sb2j`), **support chip** (e.g. `figs-explicit`) that opens a type-ahead popover for the support reference (search-as-you-type from the `ta` catalog; only short form shown), `⌫` delete button.
  - **Body**: two fields. `Quote` (Hebrew, RTL, editable, spellcheck off). `Note` (markdown-ish body, editable, spellcheck on).
- **No** occurrence field. If `quote` is empty we save `occurrence=0`; otherwise `occurrence=1` on export. Hidden from UX entirely.
- **No** separate second support reference field. The support chip is the only knob.
- Active note gets the blue halo + inset border.
- Section header `Notes <count> ＋ new note` is the only place to add. (No duplicate `+ add` elsewhere.)

**Resource column · Words section (= deduplicated Words + TWL)**

- Single `wordTable` with columns: `Reference` (editable, e.g. `1:4`), `Original` (Hebrew, RTL, editable), `TW article` chip (showing friendly name like `Moab` + path hint `names`; not the raw `rc://*/tw/dict/...`), `⌫` delete.
- TW article chip click → type-ahead picker from the `tw` catalog.
- The schema this writes back to disk is the **TWL** schema (one row per OrigWords+ref+twlink); when round-tripping, we present and edit as one table.
- TW article *content* (definitions) is **not** editable in this UI — that's gatewayEdit's territory and out of scope.

**Resource column · Questions section**

- Simple two-column table: `Question` (editable), `Response` (editable), `⌫` delete. `＋ add` in section header.

**Alignment modal (Screen D)**

- Triggered by any ⌭ icon (verse-version specific).
- Layout: dialog with header (`⌭ Aligning OBA 1:1 · ULT` + `esc · close`), verse strip (current verse's ULT + UST rendered as paragraphs so meaning stays in view), body (left rail = unaligned GL words bag, right = grid of `alignBox` cards each with the Hebrew/Greek word as title and dropped GL words as chips), footer (Suggestions: ⟳ refresh / ✓ accept / ✕ reject, then cancel / reset / save).
- Implementation: **wrap `enhanced-word-aligner-rcl`** for the actual drag-and-drop and alignment data structure. The verse strip + dialog chrome is our own. `Esc` returns to the exact prior scroll position.

**Styling**

- Use **Material UI v5** (`@mui/material`, `@mui/icons-material`, `@emotion/react`, `@emotion/styled`) as the component library — this is the same family that gatewayEdit and tcCreate use today (gatewayEdit already has MUI v5; tcCreate is on v4 / Material-UI). Users get the same look, feel, and component grammar they're used to.
- The Timeline Variations HTML is the **layout/structure/behavior spec only** — not the visual spec. We translate it into MUI: `Stack`/`Grid` for the three-column shell, `IconButton` for ⌭ alignment buttons, `Autocomplete` for the support/TW typeaheads, `Chip` for note IDs and support refs, `TextField` (multiline + spellcheck) for editable fields, `Tabs`/`ToggleButtonGroup` for the columns mode toggle, `Dialog` for the alignment modal.
- Default MUI theme (light, clean, sans-serif). Active-state highlighting still uses blue (`primary.light` background, `primary.main` border) — the same visual hint the wireframe used, just MUI-native.
- Keep the sketchy hand-drawn HTML around at `docs/design/Timeline Variations.html` for reference, but production renders in MUI.

**Data wiring**

- `useChapter(book, ch)` → `{verses, tnRows, tqRows, twlRows}` plus a `subscribe()` for live updates from the DO.
- `useRow(kind, id)` → `{row, version, save(patch), isPending}` driving the outbox.
- `useVerse(book, ch, v)` → same shape, returning the verse JSON tree.
- `useTaCatalog()` and `useTwCatalog()` → static-ish lists for the support-chip and TW-chip type-aheads. Loaded once from the API; cached in IndexedDB; refreshed daily.
- The Timeline rail computes `has` / `warn` flags from `useChapter`'s row counts and any open issues.

## DCS export (nightly Cron Worker)

Runs at 06:00 UTC. For each book that has changes since the last export:

1. Read all rows (tn, tq, twl) for the book from D1.
2. Render to TSV in the canonical column order (matching what we sampled in `data samples/`).
3. Read all verses for the book; reconstruct the USFM string via `usfm-js`'s `toUSFM(bookObject, {forcedNewLines: true})`.
4. Commit each file to a single DCS fork branch (e.g., `live-snapshot`) on the relevant repo, via Gitea API, using a service-account token.
5. Record the snapshot manifest (book → commit SHA) in D1 for traceability.

If the cron fails, retry next night. **Edits remain in D1 regardless.**

## Borrow / bend / break / build inventory

| Item | Verdict | Notes |
|------|---------|-------|
| `usfm-js` | **Borrow** | Canonical USFM ↔ JSON tree, lossless for `\zaln-*`. Used by tcCore and gatewayEdit. |
| `enhanced-word-aligner-rcl` (v1.4.4) | **Borrow** | Already used in gatewayEdit. Reuse the React component for alignment UI. |
| `scripture-tsv` (TSV parse/render) | **Borrow** (export only) | Use only inside the nightly export worker, not in the hot path. |
| `gitea-react-toolkit` | **Break** | Replace with our own thin JWT + fetch client. The toolkit's auth/save model is the root cause of current pain. |
| `dcs-branch-merger` | **Break** | Not needed — there is no live branch merging because DCS is read-only during the project. |
| TSV-in-Git as source of truth | **Break** | Replaced with row-keyed D1 tables. |
| DCS as live concurrency point | **Break** | Replaced with our API + DO + D1. DCS receives nightly snapshots only. |
| Multi-pane shell | **Build** | New, but the user is leading the design. |
| Outbox + sync engine | **Build** | The single piece most worth getting right. ~300 LOC. |

## Assumptions to validate before commit (disconfirmers)

| Assumption | If wrong, what breaks | How to validate (cheap) |
|---|---|---|
| `enhanced-word-aligner-rcl` works outside gatewayEdit's context providers | Alignment editor blocks; would have to inline gatewayEdit code | **SPIKE RUN 2026-05-11 — partial fail.** Package installs and exports the components, but its dep tree mixes core-js v2 and v3 import paths. Webpack tolerates this; Rollup/Vite does not. See `web/src/spikes/AlignerSmoke.tsx` for details. Three forward paths for Phase 3, ranked by effort: (1) **write our own aligner UI** in ~300 LOC of react-dnd against the same `{verseAlignments, targetWords}` data model — cheapest, no bundler fights; (2) build the aligner as a webpack UMD bundle and load it via `<script>` at runtime — works but adds a parallel build pipeline; (3) reconfigure Vite/Rollup with surgical aliases and CommonJS handling — fragile. Recommend (1) unless the suggester/training features are essential. |
| `usfm-js` round-trips all 66 books losslessly | Word alignments could drift on save | Import sample USFMs, export, diff. Run across the full unfoldingWord ULT/UST set. **Day 1 spike.** |
| DCS Gitea allows long-lived service tokens for export | Nightly export needs interactive auth | Confirm with DCS ops; fall back to a personal access token from a dedicated service account. |
| D1 throughput is fine for our editor count | Saves queue up during peak | Whole team is <10 people; typical concurrency on one chapter is <3. D1 publishes ~1k writes/sec — we expect single-digit writes/sec at peak. Disconfirmer is essentially impossible at this scale. |
| Cloudflare DOs handle our concurrency | Presence/fanout degrades | Same: <10 total team, <3 typically on the same chapter. Trivially within DO limits; non-blocking failure (HTTP path still works regardless). |

## Dev loop

`wrangler dev` natively on Windows. Miniflare runs the real Workers runtime locally — local D1 (SQLite-backed), simulated R2, working Durable Objects, hot reload. Same code in dev and prod; `wrangler deploy` to push to Cloudflare whenever a real URL is wanted (staging + production environments configured in `wrangler.toml`). No mocks, no porting step.

The web frontend runs under `vite dev` on a separate port and is proxied to the local Workers API via a Vite config rule.

## Phased delivery

**Phase 0 — Repo + spikes (3-5 days)**
- Create a new **public** GitHub repo at `github.com/deferredreward/bible-editor` (final name TBD — proposing `bible-editor`; happy to swap) via `gh repo create`. Clone into `C:\Users\benja\Documents\GitHub\bible-editor` alongside the existing `tcc-ge-dcs` workspace.
- Lay out the workspace: `api/` (Cloudflare Workers + Wrangler) and `web/` (Vite + React). Commit an initial scaffold + README + this plan as `docs/plan.md`.
- Confirm `wrangler dev` runs the empty Worker + Vite proxy works end-to-end on Windows before touching the real features.
- `usfm-js` round-trip test across full ULT/UST corpus.
- `enhanced-word-aligner-rcl` standalone embed.
- Confirm DCS service-account token strategy.

**Phase 1 — Shell + tn/tq/twl editing (3 weeks)**
- Auth via DCS OAuth → our JWT.
- D1 schema + import script (pull tn/tq/twl/USFM for chosen books from DCS).
- API: row upsert with `If-Match`, chapter bulk read.
- IndexedDB outbox + drain worker.
- Build Screen A (stacked mode) of the design: Timeline rail + Scripture column (stacked, read-only initially) + Resource column with Notes/Words/Questions editing.
- Type-ahead popovers backed by `ta`/`tw` catalog endpoints.
- Nightly export cron (TSV for tn/tq/twl; USFM passed through unchanged from import).
- Verify with 2-3 editors on the same chapter for a week.

**Phase 2 — USFM verse editing + columns mode (2 weeks)**
- Verse-level edit endpoint (`PATCH /verses/...`) with optimistic concurrency.
- Build Screen B/C: columns toggle, single/parallel doc-style editing of ULT/UST (UHB read-only), draggable resizer between scripture and resource columns.
- Verify USFM round-trip preserves alignment markers via the nightly export.

**Phase 3 — Alignment editor (2 weeks)**
- Build Screen D: alignment modal wrapping `enhanced-word-aligner-rcl`, with our verse strip chrome on top.
- Wire ⌭ icons throughout Screens A/B/C to open the modal for that specific verse-version.
- Verify alignments save and round-trip via export.

**Phase 4 — Hardening for the remaining months**
- Error reporting, admin views (recent changes, who edited what), export history.
- Final-snapshot script for the end-of-7-months handoff.

## Critical files to create (in the new `bible-editor` repo)

- `api/src/index.ts` — Workers entry, routing.
- `api/src/auth.ts` — DCS OAuth + JWT issuance/refresh.
- `api/src/rows.ts` — row upsert handlers with `If-Match`.
- `api/src/verses.ts` — verse upsert handlers.
- `api/src/chapterRoom.ts` — Durable Object for presence + fanout.
- `api/src/exportCron.ts` — nightly export job (06:00 UTC).
- `api/src/dcsImport.ts` — one-time import script (run via Wrangler).
- `api/migrations/0001_init.sql` — D1 schema.
- `api/wrangler.toml` — D1 binding, R2 binding, DO binding, cron trigger.
- `web/src/sync/outbox.ts` — IndexedDB outbox + drain worker.
- `web/src/sync/api.ts` — fetch client with `If-Match`/version handling.
- `web/src/hooks/useChapter.ts`, `useRow.ts` — data subscriptions.
- `web/src/components/Shell.tsx` — three-column outer layout (Timeline / Scripture / Resources).
- `web/src/components/TimelineRail.tsx` — left rail with verse tiles, `has`/`warn`/`active` states.
- `web/src/components/ScriptureColumn.tsx` — switches between stacked and doc modes; owns the columns toggle + version segment picker + snap-back.
- `web/src/components/ActiveVerseCard.tsx` — Screen A's blue card with editable ULT/UST + read-only UHB.
- `web/src/components/DocColumn.tsx` — Screen B/C's single-version doc editor.
- `web/src/components/ResourceColumn.tsx` — wraps Notes/Words/Questions sections.
- `web/src/components/NoteCard.tsx` — note card with ID chip, support typeahead, editable quote + body.
- `web/src/components/WordsTable.tsx` — deduplicated Words+TWL table.
- `web/src/components/QuestionsTable.tsx`.
- `web/src/components/AlignmentDialog.tsx` — Screen D modal wrapping `enhanced-word-aligner-rcl` with the verse strip.
- `web/src/components/SupportChipTypeahead.tsx` and `TwChipTypeahead.tsx`.
- `web/src/theme.ts` — MUI theme (default light theme + a few overrides for active-verse halo and the timeline rail tiles).
- `docs/plan.md` — this plan, committed to the repo for traceability.
- `docs/design/Timeline Variations.html` — the original design file, kept in-repo as the spec.
- `docs/design/chat1.md` — the design transcript, kept as intent record.
- `docs/design/uploads/*.png` — reference screenshots of the legacy tools.
- `README.md` — short overview, "tactical 7-month editor" framing, getting-started.

Critical existing files to read for reference patterns (do **not** modify):
- [ResourceCard.jsx:412-454](gateway-edit/src/components/ResourceCard.jsx) — what the old save flow looked like.
- [AuthContext.jsx:96-150](gateway-edit/src/context/AuthContext.jsx) — the 401-causes-data-loss pattern we are explicitly avoiding.
- [WordAlignerDialog.jsx:41,166,278](gateway-edit/src/components/WordAlignerDialog.jsx) — how to call `usfm-js` and feed the aligner.
- [useRetrySave.js](tc-create-app/src/...) — partial inspiration for our outbox, but our version is durable across reloads.

## Verification — how we'll know it works

End-to-end smoke (manual, on each phase):

1. Two browser sessions logged in as different DCS users, both viewing OBA chapter 1.
2. Edit tn row `xm1w` in browser A. Within 2s, browser B sees the new content (via WS).
3. Edit tn row `jdr1` in browser B while A is still on `xm1w`. No conflict; both saves succeed.
4. Disconnect browser A's network, edit two more rows, wait 30s, reconnect — those rows sync without prompting.
5. Hard-refresh browser A mid-edit (simulate crash). Reopen — pending edits drain automatically.
6. Force the DCS token to expire. Continue editing. JWT refresh keeps the outbox drainable; no logout.
7. Wait for the next nightly export. Pull the DCS fork branch and `git diff` against the previous snapshot — should match the edits made.
8. Round-trip test: pick a verse, edit alignment, save, export, re-import — alignment matches.

Tooling-level checks:
- `wrangler tail` for live API logs.
- `wrangler d1 execute --command "SELECT * FROM edit_log ORDER BY id DESC LIMIT 20"` to spot-check the audit log.
- A `/admin/exports` page listing recent snapshot SHAs per book.

## What this plan deliberately does **not** include

- Cell-level CRDT / real-time co-typing in the same field. Out of scope for 7 months; row-level concurrency handles the multi-editor requirement at ~5% of the complexity.
- A long-term migration path away from this tool. By design, the data lives in D1 + nightly DCS snapshots; the final snapshot at month 7 is the handoff artifact.
- Replacement of `enhanced-word-aligner-rcl` or `usfm-js`. We borrow, we don't bend or break those.
