# Handoff — bible-editor

You are picking this up mid-flight. Read this end-to-end, then [`docs/plan.md`](./plan.md), before doing anything else. Both are short.

## Where things live

- **Repo (private)**: <https://github.com/deferredreward/bible-editor>
- **Local clone**: `C:\Users\benja\Documents\GitHub\bible-editor`
- **HEAD when this was written**: `45b3bfae` (29 commits on `main`; **16 are unpushed** — the user is the only writer right now, push is a manual step they own)
- **Plan**: [`docs/plan.md`](./plan.md) — the canonical spec
- **Design source**: [`docs/design/project/Timeline Variations.html`](./design/project/Timeline%20Variations.html) — wireframes for Screens A/B/C/D, with chat intent in [`docs/design/chats/chat1.md`](./design/chats/chat1.md)
- **Sample bible data**: `docs/samples/` (OBA from initial exploration; ZEC imported into D1)

## One-paragraph mental model

This is a tactical 7-month replacement for gatewayEdit + tcCreate. **DCS is no longer the live concurrency point** — edits land in a Cloudflare D1 (SQLite) database via Workers, every keystroke is durably queued in an IndexedDB outbox first, and DCS receives a nightly snapshot commit. Row-level optimistic concurrency (`If-Match: <version>`) replaces whole-file git commits. The UI is a 3-column shell (Timeline rail · Scripture · Resources) with stacked / columns / alignment modes, built in React 18 + MUI v5/v6 + Vite. Node 24 LTS, pinned via Volta.

## What's in (and verified)

| Commit | Status | What |
|---|---|---|
| 7478350 | ✅ build | Workspace scaffold: `api/` (Wrangler+Hono) and `web/` (Vite+React+MUI). Health endpoint live. |
| 1926b49 | ✅ live | **Spike**: `usfm-js` round-trips alignment markers byte-perfect. |
| 7eb22ba | ⚠️ parked | **Spike**: `enhanced-word-aligner-rcl` installs but doesn't bundle under Vite/Rollup. Phase 3 went with a custom aligner instead. |
| e8559cf | ✅ live | D1 schema, ZEC import, API routes with `If-Match`. |
| 1cbf66e | ✅ build | Screen A UI + IndexedDB outbox + chapter hook. |
| 54392de | ✅ build | Phase 2: columns mode (Screens B & C). |
| 43d2a8b | ✅ build | Phase 3: custom drag-drop alignment editor (Screen D). |
| a58bd33 | ✅ build | Phase 1.5: TopBar + chapter nav, verse-done, +new on notes, typeahead, fonts, sticky header. |
| b220b03 | ✅ build | Quote-driven highlighting: active note paints aligned target words. |
| 999b14a | ✅ docs | First handoff. |
| dcfb0fa | ✅ build | Click-anywhere note activation; optimistic delete; no-refetch on create; word-click highlight (mutex with note). |
| a260921 | ✅ build | Columns-mode text regression fixed; ⌭ hidden on read-only versions. |
| 4361235 | ✅ build | tn_rows.sort_order migration (0003) + HTML5 drag-reorder + insert-after places note next to source. |
| 830a80b | ✅ build | PushPin → Undo on "go to active"; Hebrew font bumped. |
| 109b184 | ✅ build | Aligner: RTL block order, per-block ×, drag-merge Hebrew source words. |
| 96d8827 | ✅ build | twl_rows.sort_order migration (0004) + Words drag-reorder; patch accumulator merges note field edits per debounce window. |
| 4f54c9e | ✅ build | useChapter applies verse outbox results so doc-column edits reflect in the aligner. |
| 0e4cda6 | ✅ build | Aligner: multi-select drag (gateway-edit style), target-merge on source-merge, source-verse strip column, TW article hint. |
| 36b00ad | ✅ build | Word-bank UX: range-select (shift), additive-toggle (click), × clears selection, drop-onto-bag is no-op for already-in-bag. |
| 405fae5 | ✅ build | Alignment cards sort by source-verse word index; bumped Hebrew font sizes. |
| 45d5e87 | ✅ build | **Lexicon import**: UHAL + UGL into D1 (migration 0005), `/api/lexicon`, `useLexicon` hook, `SourceTooltipBody`. |
| 45b3bfa | ✅ build | parseAlignment enumerates UHB source words; synthesizes placeholder blocks for words the target USFM doesn't reference (e.g. לֵאמֹר); strong-based sort. |

**"build" = typechecked + bundled clean.** **Visual smoke testing is the user's job** — the agent's permission classifier denies long-running `vite dev`. The user runs it and sends back observations + screenshots per round.

## Architecture summary

```
[Browser]
  React 18 + MUI (Vite SPA)
  ├── components/Shell.tsx                 — 3-column shell; owns activeVerse + activeNoteId + activeWordId (mutex)
  │   ├── TopBar.tsx                       — book/chapter dropdowns, prev/next, hash routing
  │   ├── TimelineRail.tsx                 — verse tiles, "done" checkboxes
  │   ├── ScriptureColumn.tsx              — mode toggle, stacked vs columns
  │   │   ├── (stacked) ActiveLine         — blue active card with highlight HTML
  │   │   └── (columns) DocColumn.tsx      — parallel Word-style version columns
  │   ├── ResourceColumn.tsx               — sections, count chips, drag state for notes
  │   │   ├── NoteCard.tsx                 — id chip + support typeahead + Quote/Note fields; grip drag, click-anywhere activate
  │   │   ├── WordsTable.tsx               — grip + Quote + TW article (no Ref column); active halo; drag-reorder
  │   │   └── QuestionsTable.tsx           — Question/Response pairs
  │   └── AlignmentDialog.tsx              — Screen D modal: HTML5 DnD, RTL grid, ×-clear, drag-merge sources, multi-select bag, source strip, lexicon tooltip
  ├── hooks/useChapter.ts                  — chapter payload + applyLocalRow{Patch,Replacement,Delete,Insert} + applyLocalVerse
  ├── hooks/useCatalogs.ts                 — supportRefs + twLinks (single-module cache)
  ├── hooks/useLexicon.ts                  — Strong's → entry, batched + cached at module level
  ├── sync/api.ts                          — fetch client with If-Match handling
  ├── sync/outbox.ts                       — IndexedDB write-ahead queue, drain on focus/online
  ├── lib/alignment.ts                     — parse/serialize \zaln-s tree; clearGroup; moveSource (targets merge into dest on origin-empties); moveTargets (batch); placeholder synthesis from UHB
  └── lib/highlight.ts                     — quote → aligned target tokens; renderHighlightedHTML

[Cloudflare Workers (Hono on Wrangler v4)]
  api/src/index.ts                         — routing entry
  api/src/chapters.ts                      — GET /api/chapters/:book, /:book/:ch (orders tn/twl by sort_order NULLS LAST)
  api/src/rows.ts                          — POST/PATCH/DELETE /api/rows/:kind[/:id]; sort_order accepted in patch + create
  api/src/verses.ts                        — PATCH /api/verses/:book/:ch/:v/:bibleVersion (UHB/UGNT 403)
  api/src/catalogs.ts                      — GET /api/catalogs
  api/src/lexicon.ts                       — GET /api/lexicon/:strong, GET /api/lexicon?strongs=...
  api/src/chapterRoom.ts                   — Durable Object stub for presence (no UI yet)
  api/migrations/
    0001_init.sql                          — base schema
    0002_verse_status.sql                  — verse_statuses(book, ch, v, done)
    0003_tn_sort_order.sql                 — REAL sort_order on tn_rows, seeded rowid*100
    0004_twl_sort_order.sql                — REAL sort_order on twl_rows, seeded rowid*100
    0005_lexicon.sql                       — lexicon_entries(strong PRIMARY KEY, resource, lemma, part_of_speech, gloss, definition)

[Storage]
  D1 (local SQLite at api/.wrangler/state/v3/d1) — ~5.5 MB locally with ZEC + lexicon
  R2 (BLOBS binding) — not used yet

[Scripts]
  scripts/import-book.mjs                  — pulls a book's ULT/UST/UHB + TSVs from docs/samples/ → SQL
  scripts/import-lexicon.mjs               — downloads en_uhal + en_ugl zips, parses Strong's markdown → SQL
  scripts/out/, scripts/tmp/               — gitignored (generated SQL + extracted archives)
```

## Dev loop

**Node + npm require a Volta PATH prefix in the agent's harness.** Volta is installed but its bin dir is only on the user-PATH; child shells don't inherit it. Every PowerShell/Bash call that runs `node`/`npm`/`npx`/`wrangler` must prefix:

```powershell
$env:Path = "C:\Program Files\Volta;$env:LOCALAPPDATA\Volta\bin;$env:Path"
```

(In a real human terminal that was started fresh, just `node --version` works.)

```sh
cd C:\Users\benja\Documents\GitHub\bible-editor
npm install          # first checkout only
npm run dev          # wrangler dev (8787) + vite dev (5173) in parallel
```

Workspace scripts:
- `npm --workspace api run typecheck` / `run dev` / `run deploy` / `run tail`
- `npm --workspace web run typecheck` / `run build`
- `npm --workspace api run db:migrate:local` / `db:migrate:remote`
- `node scripts/import-book.mjs <CODE>` then `(cd api && npx wrangler d1 execute bible_editor --local --file=../scripts/out/import-<CODE>.sql)`
- `node scripts/import-lexicon.mjs` then `(cd api && npx wrangler d1 execute bible_editor --local --file=../scripts/out/import-lexicon.sql)`

## Quirks the next agent should remember

1. **Wrangler must be v4.** v3 has a hash-table bug that hangs on bulk SQL import.
2. **`wrangler d1 execute --local` is correct in v4** (`--remote` for prod).
3. **The aligner package is NOT in the live bundle.** `web/src/spikes/AlignerSmoke.tsx` is reference; production is `web/src/components/AlignmentDialog.tsx`.
4. **`core-js` is dependency-tree polluted.** Don't try to alias around it.
5. **`contentEditable + dangerouslySetInnerHTML` pattern.** `ActiveLine` and `VerseSpan` write DOM via `useEffect` + ref (not React children) so the cursor doesn't jump. `lastSetRef = null` means "first render — always paint" (otherwise plain-text mode never paints, columns appear empty — the bug fix in commit `a260921`).
6. **TSV `\n` literals.** Notes from DCS TSVs contain literal `\n` (two chars). `NoteCard.tsxToDisplay` shows real newlines; saves go back verbatim.
7. **DCS OAuth is stubbed.** All writes are unauthenticated; the JWT plumbing lives in `wrangler.toml` env vars only.
8. **Verse-done is global, not per-user.** Migrate to per-user when auth lands.
9. **Permission classifier denies long-running dev servers.** Wrangler dev as a background task is fine; vite needs the user.
10. **Commits use HEREDOC** + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. User isn't on this commit's git config; pass `-c user.email=ju-cldai724@abidinginhesed.com -c user.name=Benjamin` per commit.
11. **CRLF warnings on every commit** are expected (Windows checkout); they're not errors, ignore.
12. **sort_order math.** `pickSortOrder` chooses a midpoint between neighbors (REAL column, no rebalancing). Insertion at the head/tail jumps by 100. Tn and Twl share the helper via the generic `Sortable` type in `Shell.tsx`.
13. **RTL flex layout.** The aligner grid uses `direction: rtl` (not `flex-direction: row-reverse`) so the first card sits on the right. Card internals must override back to `direction: ltr` for GL chips. Same approach in `VerseStrip`'s source column.
14. **Strong's normalization.** ULT/UST source words carry forms like `b:H2320`, `d:H8066`, `H2148a` (prefix particle + classic + sense suffix). Both `useLexicon.normalizeStrong` and `api/src/lexicon.strongLookupKeys` extract the exact `[HG]\d+[a-z]?` token, strip leading zeros after the letter, and try an alpha-stripped fallback. UGL Strong's-Plus form (classic × 10) is normalized at import time by dividing — dirname is authoritative, the bullet inside each .md file is ignored for UGL.
15. **Source-position sort uses (strong, occurrence) primarily**, with (text, occurrence) as fallback because cantillation marks sometimes differ between the ULT/UST `\zaln-s` `content` attribute and the UHB `\w` `text`. UHB tokens have no explicit `occurrence` — we count running occurrences per strong during the walk.
16. **`scripts/out/` and `scripts/tmp/` are gitignored.** A predecessor commit accidentally checked in the entire extracted UHAL+UGL archive tree (~31k files). The ignore + the un-pushed reset prevent recurrences. Don't `git add -A` blindly when a fresh script run is sitting in tmp.
17. **Patch accumulator.** `NoteCard.queue` and `WordRow.queue` merge field-level patches into one PATCH per 350 ms debounce window so quote+note (or quote+tw_link) collapse to a single save. Important context for the next "edit-session-scoped versioning" feature in the queue.

## What's deliberately deferred (don't touch unless asked)

- **DCS OAuth + JWT** (Phase 1, blocked on creds at `git.door43.org/user/settings/applications`).
- **Nightly export cron** (Phase 1, blocked on service-account token; cron trigger already set for 06:00 UTC in `wrangler.toml`).
- **Per-user verse-status** (extension of current global flag once auth lands).
- **Full edit-history UI** (Phase 4; `edit_log` already captures every patch).
- **Compound-alignment UX beyond merge/clear** — the dialog drag-merges sources and clears blocks, but doesn't have a "split this one source out of compound" gesture (drag-out target is unclear; `clearGroup` is the current escape hatch).
- **`Hybrid Views.html`** — original design (5 options ranked). Reference only.

## Smoke-test path (for the user)

```sh
cd C:\Users\benja\Documents\GitHub\bible-editor
npm run dev
# open http://localhost:5173 — boots into ZEC 1:1
```

What should work as of `45b3bfa`:
- Timeline tile click → active verse changes.
- Note edit → 350 ms debounce → outbox → API → version bump. Multi-field edits in the same window merge into one PATCH.
- Word/Question edit → same flow.
- Columns toggle 1/2/3 versions; UHB read-only with Hebrew text in RTL.
- ⌭ icon (hidden on read-only) opens the AlignmentDialog with: RTL block grid, source verse strip, multi-select bag (click toggles, shift-range, × clears), per-block × to clear+ungroup, drag-merge Hebrew sources between blocks, placeholder blocks for source words not in target USFM, hover tooltip with lemma/POS/gloss/definition from UHAL/UGL.
- Chapter nav (`#/ZEC/3`) — bookmarkable URLs.
- "Done" checkbox in timeline.
- `+ new` on a note inserts directly under it (persistent via sort_order).
- Drag-reorder notes (grip on each card); drag-reorder words (grip on each row).
- Support-ref / TW article typeahead chips.
- Quote-driven highlight: clicking a note OR a word row paints `<mark>` on the active verse in ULT/UST and source-matching on UHB.

## Commit message style

```
<one-line scope-noun: imperative>

Optional 3-7 line body explaining the why and any nuance. Bullet
lists for multi-item changes. Always keep the user-facing intent
visible.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Use HEREDOC: `git commit -m "$(cat <<'EOF'...EOF)"`.

## Bookmark + log convention

Per the user's `~/.claude/CLAUDE.md`:
- Before starting a task, drop an empty bookmark commit so the work can be reset away cleanly:
  ```sh
  git -c user.email=ju-cldai724@abidinginhesed.com -c user.name=Benjamin commit --allow-empty -m "bookmark: <task>"
  ```
- After completing a task, run `git log --oneline -10` to show recent history.
- Ask the user before committing or pushing.

## Push + data backup posture (read before doing anything)

- **16 commits are unpushed** to `origin/main` as of this writing — the user is the only writer and pushes manually. Don't push unless asked.
- **D1 data is local-only.** ~5.5 MB at `api/.wrangler/state/v3/d1/`, gitignored. If the workstation is reimaged, the ZEC import + lexicon import + every in-progress edit goes with it. No remote D1 has been provisioned. Suggest a manual SQLite copy when the user asks.

## Open issues queued for the next session

The user signed off after seeing the source-order layout and lexicon tooltip on ZEC 1:1 UST and queued the following for the next round. Treat each like the previous rounds: batch related fixes per commit, build + typecheck before committing, HEREDOC + Claude trailer.

1. **"Go to active" doesn't scroll in multi-column view.** `ScriptureColumn.tsx`'s `activeRef` is only attached in stacked-mode `StackedBody`; columns mode (`DocColumn`) has its own internal scroll. The top-bar button needs to dispatch to the active `DocColumn`'s active verse span instead of (or in addition to) the stacked ref.
2. **Multi-column whole-book view with lazy loading + find/replace.** Today `useChapter(book, chapter)` loads one chapter at a time. The user wants the doc columns to scroll through an entire book, lazy-loading chapters as they come into view, plus a VS Code-style find/replace UI with regex support that works across the whole book. **Reference implementation lives in `../tcc-ge-dcs/dcs editor page`** — read it before designing. New chapter range endpoint, virtualization (probably react-window or hand-rolled IntersectionObserver), and a search UX that indexes lazily-loaded chunks are all in scope.
3. **Per-note edit-session versioning + save icon + undo-since-entry.** Today every debounce window bumps `version`. The user wants: edits to quote / note / support-ref while a note is "active" don't each bump the version. A save icon lights up on dirty; auto-save fires on blur (or on next-note focus); manual save is also clickable. An undo icon discards every edit made to this note since it became active (snapshot-on-enter behavior, *not* `version - 1` rollback). Touches `NoteCard.tsx` + a new local snapshot/dirty-state model. The current `queue` accumulator is a stepping stone; the new model needs to flush exactly once when focus moves on, and provide a revert path.
4. **Push / D1 backup.** See "Push + data backup posture" above — needs a decision, then maybe a small ritual or script.
5. **Questions need a `ref_raw` editor.** `QuestionsTable.tsx` currently shows only question + response. Questions sometimes span multiple verses (e.g. `1:1-3`), and the editor should be able to see and edit that span.
6. **Pin-per-section to scope a resource type to the whole chapter.** Add a pin icon on each of Notes / Words / Questions section heads. When pinned, the column shows that resource for *every verse in the chapter*, not just the active verse. In that view, Words needs a visible reference grouping (the column has no Ref column today; group by verse with one header per verse, not per row).
7. **Lexicon tooltip pointer-events.** The tooltip popper currently swallows hover events: with the mouse parked over a tooltip body, the source word under the popper doesn't trigger its own hover. The popper needs `pointer-events: none` (or move to a portal positioned out of the hover path) so the user can sweep across source words without dodging.

## When in doubt

- Read the plan: [`docs/plan.md`](./plan.md).
- Check user intent: [`docs/design/chats/chat1.md`](./design/chats/chat1.md).
- Skim the last ~10 commits before changing anything — they're tight and tell you what was just touched.
- Ask the user rather than guess. The user is involved and answers fast.
