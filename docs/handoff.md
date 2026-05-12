# Handoff — bible-editor

You are picking this up mid-flight. Read this doc end-to-end, then [`docs/plan.md`](./plan.md), before doing anything else. Both are short.

## Where things live

- **Repo (private)**: <https://github.com/deferredreward/bible-editor>
- **Local clone**: `C:\Users\benja\Documents\GitHub\bible-editor`
- **HEAD when this was written**: `b220b03` (10 commits on `main`)
- **Plan**: [`docs/plan.md`](./plan.md) — the canonical spec
- **Design source**: [`docs/design/project/Timeline Variations.html`](./design/project/Timeline%20Variations.html) — wireframes for Screens A/B/C/D, with chat intent in [`docs/design/chats/chat1.md`](./design/chats/chat1.md)
- **Sample bible data**: `docs/samples/` (OBA from initial exploration; ZEC imported into D1)

## One-paragraph mental model

This is a tactical 7-month replacement for gatewayEdit + tcCreate. **DCS is no longer the live concurrency point** — edits land in a Cloudflare D1 (SQLite) database via Workers, every keystroke is durably queued in an IndexedDB outbox first, and DCS receives a nightly snapshot commit. Row-level optimistic concurrency (`If-Match: <version>`) replaces whole-file git commits. The UI is a 3-column shell (Timeline rail · Scripture · Resources) with stacked, columns, and alignment modes, built in React 18 + MUI v5/v6 + Vite. Node 24 LTS, pinned via Volta.

## What's in (and verified)

| Commit | Status | What |
|---|---|---|
| 7478350 | ✅ build | Workspace scaffold: `api/` (Wrangler+Hono) and `web/` (Vite+React+MUI). Health endpoint live. |
| 1926b49 | ✅ live | **Spike**: `usfm-js` round-trips alignment markers byte-perfect (OBA 72,647 B → 72,647 B). |
| 7eb22ba | ⚠️ parked | **Spike**: `enhanced-word-aligner-rcl` installs but doesn't bundle under Vite/Rollup (core-js v2/v3 path collision). See `web/src/spikes/AlignerSmoke.tsx`. Phase 3 went with a custom aligner instead. |
| e8559cf | ✅ live | D1 schema, ZEC import (633 verses / 653 tn / 133 tq / 663 twl across 14 chapters), API routes with `If-Match`. PATCH v1→v2 and stale-PATCH 409 verified end-to-end. |
| 1cbf66e | ✅ build | Screen A UI + IndexedDB outbox + chapter hook. |
| 54392de | ✅ build | Phase 2: columns mode (Screens B & C) for ULT/UST/UHB doc-style editing. |
| 43d2a8b | ✅ build | Phase 3: custom drag-drop alignment editor (Screen D) — handles compound (nested) source words. |
| a58bd33 | ✅ build | Phase 1.5: TopBar + chapter nav, verse-done checkbox, inline +new on notes, version tooltip, support-ref/TW typeahead, Hebrew serif fonts, sticky section header, `\n` → newline in notes. |
| b220b03 | ✅ build | Quote-driven highlighting: active note paints aligned target words in ULT/UST (yellow `<mark>`); matches source words directly in UHB. |

**"build" means typechecked + bundled clean.** **Visual smoke testing is the user's job** — the agent was denied permission to spawn a long-running `vite dev` server. The user has run it and given feedback once already (the eleven items in `a58bd33`), then again (note→highlight in `b220b03`).

## Architecture summary

```
[Browser]
  React 18 + MUI v5/v6 (Vite SPA)
  ├── components/Shell.tsx                 — 3-column layout, owns active verse + note state
  │   ├── TopBar.tsx                       — book/chapter dropdowns, prev/next, hash routing
  │   ├── TimelineRail.tsx                 — left rail, verse tiles, "done" checkboxes
  │   ├── ScriptureColumn.tsx              — mode toggle, stacked vs columns
  │   │   ├── (stacked) ActiveLine         — blue active card; renders highlight HTML
  │   │   └── (columns) DocColumn.tsx      — N parallel Word-style version columns
  │   ├── ResourceColumn.tsx               — sections + clickable count chips
  │   │   ├── NoteCard.tsx                 — id chip + support typeahead + Quote/Note fields
  │   │   ├── WordsTable.tsx               — Ref + Original (Hebrew) + TW typeahead
  │   │   └── QuestionsTable.tsx           — Question/Response pairs
  │   └── AlignmentDialog.tsx              — Screen D modal (HTML5 drag-drop, no react-dnd)
  ├── hooks/useChapter.ts                  — chapter payload + subscriber to outbox results
  ├── hooks/useCatalogs.ts                 — supportRefs + twLinks (single-module cache)
  ├── sync/api.ts                          — fetch client with If-Match handling
  ├── sync/outbox.ts                       — IndexedDB write-ahead queue, drain on focus/online
  ├── lib/alignment.ts                     — parse/serialize \zaln-s tree, move targets
  └── lib/highlight.ts                     — quote → aligned target tokens; renderHighlightedHTML

[Cloudflare Workers (Hono on Wrangler v4)]
  api/src/index.ts                         — routing entry
  api/src/chapters.ts                      — GET /api/chapters/:book, /:book/:ch (full payload)
                                              PATCH /api/chapters/:book/:ch/:v/status (done)
  api/src/rows.ts                          — GET/POST/PATCH/DELETE /api/rows/:kind[/:id]
                                              with If-Match optimistic concurrency
  api/src/verses.ts                        — PATCH /api/verses/:book/:ch/:v/:bibleVersion
                                              (UHB/UGNT are 403 — source is read-only)
  api/src/catalogs.ts                      — GET /api/catalogs (typeahead options)
  api/src/chapterRoom.ts                   — Durable Object stub for presence (no UI yet)
  api/migrations/0001_init.sql             — users, sessions, tn/tq/twl rows, verses, edit_log, ...
  api/migrations/0002_verse_status.sql     — verse_statuses(book, ch, v, done) — global for now

[Storage]
  D1 (local SQLite at api/.wrangler/state/v3/d1)
    └── ZEC currently imported. Run `scripts/import-book.mjs <CODE>` to add more,
        then apply `scripts/out/import-<CODE>.sql` via wrangler d1 execute.
  R2 (bound as BLOBS) — bucket not used yet; will hold export archives.
```

## Dev loop

**Node + npm are NOT on the default PATH.** Volta is installed but its bin dir is only on the user-PATH; child shells from this agent harness don't inherit it. Every shell command that calls `node`/`npm`/`npx`/`wrangler` must prefix:

```powershell
$env:Path = "C:\Program Files\Volta;$env:LOCALAPPDATA\Volta\bin;$env:Path"
```

(For a real human terminal that was started fresh, just `node --version` works — this is only a quirk of the agent's tool-execution environment.)

Once PATH is set, the standard loop:

```sh
cd C:\Users\benja\Documents\GitHub\bible-editor
npm install          # only on first checkout
npm run dev          # runs `wrangler dev` (port 8787) + `vite dev` (port 5173) in parallel
```

Workspace scripts:
- `npm --workspace api run typecheck` / `run dev` / `run deploy` / `run tail`
- `npm --workspace web run typecheck` / `run build`
- `npm --workspace api run db:migrate:local` / `db:migrate:remote`

## Quirks the next agent should remember

1. **Wrangler must be v4.** Wrangler v3 has a hash-table bug that hangs on the 2092-statement bulk SQL import. We bumped to `^4.90.0`.
2. **`wrangler d1 execute --local` is correct in v4** (the `--local` flag still exists and is the default; pass `--remote` for prod).
3. **The aligner package is NOT in the live bundle.** `web/src/spikes/AlignerSmoke.tsx` exists for reference but is excluded from `tsconfig.json` and not imported. Phase 3 wrote a custom drag-drop aligner in `web/src/components/AlignmentDialog.tsx` against the same `\zaln-s` data shape.
4. **`core-js` is dependency-tree polluted.** `babel-runtime` (transitive) pulls `core-js@2`; we don't try to alias around it. The aligner's webpack-only build is what breaks under Rollup.
5. **`contentEditable + dangerouslySetInnerHTML` pattern.** ScriptureColumn `ActiveLine` and DocColumn `VerseSpan` both set DOM via `useEffect` + ref (not React children) so the cursor doesn't jump while typing. A `lastSetRef` tracks the last value we wrote; we only resync the DOM when highlights/content change from outside.
6. **TSV `\n` literals.** Note bodies coming from DCS TSVs contain literal `\n` (two chars). `NoteCard` converts to real newlines on display via `tsvToDisplay`. On save, whatever's in the field gets sent verbatim — D1 transitions to true newlines as users edit.
7. **DCS OAuth is stubbed.** `api/wrangler.toml` reserves env vars for `DCS_CLIENT_ID` / `DCS_CLIENT_SECRET` / `JWT_SIGNING_KEY` / `DCS_SERVICE_TOKEN` but no auth is enforced yet. All writes go through unauthenticated. Real auth lands when the user provides creds; the JWT + outbox refresh flow is already designed in the plan.
8. **Verse-done is global, not per-user.** The `verse_statuses` table has no `user_id`. When OAuth lands, add a column and key on the JWT subject (per the Phase 1 plan update).
9. **Permission classifier denies long-running dev servers.** When the agent tried `npx vite dev` it got denied. Wrangler dev as a background task is fine; vite needs the user to start. The user is expected to do visual smoke tests.
10. **Commits use a HEREDOC** with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer. User isn't on this commit's git config; we pass `-c user.email=... -c user.name=Benjamin` per commit so the trailer doesn't fight the local config.

## What's deliberately deferred (don't touch unless asked)

- **DCS OAuth + JWT** (Phase 1, blocked on creds — register an OAuth app at git.door43.org/user/settings/applications)
- **Nightly export cron** (Phase 1, blocked on service-account token; cron trigger already set for 06:00 UTC in `wrangler.toml`)
- **Per-user verse-status** (extension of current global flag once auth lands)
- **Full edit-history UI** (Phase 4; `edit_log` table already captures every patch)
- **Compound-alignment editor UX** beyond rendering (current dialog renders nested sources as a stack of Hebrew boxes, but drag-drop assumes a single target group per source chain — fine for non-compound; compound mass editing will need more work)
- **The other design file** — `docs/design/project/Hybrid Views.html` was the round-1 design (5 options, ranked); the user picked option 3 which became "Timeline Variations". The hybrid file is reference only.

## Smoke-test path (for the user)

```sh
cd C:\Users\benja\Documents\GitHub\bible-editor
npm run dev
# open http://localhost:5173 — boots into ZEC 1:1
```

Things that have already been smoke-tested by the user once and behave correctly per them:
- Timeline tile click → active verse changes; ULT/UST/UHB active card updates
- Note edit → debounce 300ms → outbox → API → version bump → UI reflects new version
- Word/Question edit → same flow
- Columns toggle → 1/2/3 ULT/UST/UHB; UHB read-only
- ⌭ icon → Alignment dialog with verse strip + drag-drop chips
- Chapter nav (`#/ZEC/3`) — bookmarkable URLs
- "Done" checkbox in timeline
- `+ new` (section header sticky on Notes, inline on each note)
- Support-ref / TW article typeahead chips
- Quote-driven highlight on active note (the most recent feature)

If anything in that list regresses, that's a bug to file in the next conversation.

## Commit message style

```
<one-line scope-noun: imperative>

Optional 3-7 line body explaining the why and any nuance. Bullet
lists for multi-item changes. Always keep the user-facing intent
visible.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Use HEREDOC: `git commit -m "$(cat <<'EOF'...EOF)"`.

## Bookmark a fresh starting commit before a new task

Per the user's global `CLAUDE.md`: before starting a task, do an empty bookmark commit so the work can be `git reset --hard` away. Use:

```sh
git -c user.email=... -c user.name=Benjamin commit --allow-empty -m "bookmark: <task name>"
```

After completing, run `git log --oneline -10` to show recent history.

## When in doubt

- Read the plan: [`docs/plan.md`](./plan.md)
- Check what the user actually wanted: [`docs/design/chats/chat1.md`](./design/chats/chat1.md)
- Look at the previous session's commits for tone + scope of changes
- **Ask the user** rather than guess. The user is involved and will answer fast.
