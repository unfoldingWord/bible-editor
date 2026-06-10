# Handoff — bible-editor

You are picking this up mid-flight. Read this end-to-end, then [`docs/plan.md`](./plan.md), before doing anything else. Both are short.

## Where things live

- **Repo (private)**: <https://github.com/deferredreward/bible-editor>
- **Local clone**: `C:\Users\benja\Documents\GitHub\bible-editor`
- **HEAD when this was written**: `f635ff0d` + a follow-up alignment-parser session (Hebrew Unicode NFC normalization across the parse/display/highlight paths, compound-overlap strip in the dialog, occurrence fallback for over-numbered ULT/UST tagging). Check `git log` for the exact landing commit. **Fully pushed to `origin/main`**
- **Plan**: [`docs/plan.md`](./plan.md) — the canonical spec
- **Design source**: [`docs/design/project/Timeline Variations.html`](./design/project/Timeline%20Variations.html) — wireframes for Screens A/B/C/D, with chat intent in [`docs/design/chats/chat1.md`](./design/chats/chat1.md)
- **Sample bible data**: `docs/samples/` (OBA from initial exploration; ZEC imported into D1)

## One-paragraph mental model

This is a tactical 7-month replacement for gatewayEdit + tcCreate. **DCS is no longer the live concurrency point** — edits land in a Cloudflare D1 (SQLite) database via Workers, every keystroke is durably queued in an IndexedDB outbox first, and DCS receives a nightly snapshot commit. Row-level optimistic concurrency (`If-Match: <version>`) replaces whole-file git commits. The UI is a 3-column shell (Timeline rail · Scripture · Resources) with rows / columns / book modes plus an alignment dialog, built in React 18 + MUI v6 + Vite. Node 24 LTS, pinned via Volta.

## What's in (verified)

Grouped by feature area. "build" = typechecked + bundled clean. **Visual smoke testing is the user's job** — the agent's permission classifier denies long-running `vite dev`. The user runs it and sends back observations + screenshots per round.

| Area | Status |
|---|---|
| **Scaffold + import foundation (Phase 0)** | Workspace (`api/` + `web/`), `usfm-js` round-trip spike, initial book/lexicon import scripts. The old `enhanced-word-aligner-rcl` spike was removed after the production custom aligner shipped. |
| **D1 schema + import (Phase 1)** | Migrations 0001-0005 (verses, rows, statuses, sort_order on tn/twl, lexicon). ZEC fully imported. UHAL + UGL lexicon imported (~24 k Strong's). |
| **API (Phase 1+)** | Hono on Wrangler v4. Chapters / rows / verses with `If-Match`, lexicon lookup, durable-object stub for presence. |
| **Outbox + Shell (Phase 1)** | IndexedDB outbox with drain + retry + conflict; useChapter / useBook / useLexicon hooks; 3-column Shell with TopBar nav. |
| **Resource column** | Notes / Words (deduped twl) / Questions sections; per-section pin to scope to whole chapter; drag-to-reorder via sort_order REAL column with midpoint picks. |
| **Notes** | Active-card design with per-session versioning (snapshot on activation, save/undo icons, hasNetChanges drives both UI + save-skip on no-op). Inherited support-ref dropped on insert-after. Sparkles "AI generation" placeholder under the Note label. |
| **Words (twl)** | Editable orig_words + TW article picker, drag-reorder. |
| **Questions** | Editable ref_raw (multi-verse spans like "1:1-3") + question + response, debounced merged PATCH per row. |
| **Scripture column** | Three-way mode toggle: **rows / columns / book**. Rows mode (stacked card) has a narrow right-aligned label gutter (verse-num row + ULT/UST/UHB labels baseline-aligned with first text line). Columns mode is parallel doc-style for the current chapter; book mode lazy-loads the whole book through IntersectionObserver sentinels and renders a CSS-grid per-verse row across enabled versions. |
| **Find/replace** | VS Code-style overlay in book mode, Ctrl/Cmd+F. Regex + case toggles, prev/next/replace/replace-all, Tab between find and replace inputs, "load full book" button when chapters are still unloaded. Active-match scroll fires only on user-initiated navigation (the previous "matches reshape → scroll" was pulling users away mid-edit). |
| **Alignment dialog** | Custom HTML5-DnD aligner: source-order block layout, RTL grid, compound source words laid out side-by-side (was: stacked column), drag-merge sources, multi-select target bag with shift-range, per-block × clear, placeholder blocks for UHB source words not yet in the target, lexicon tooltip on every source-word hover (in both the alignment cards AND the verse strip). Other-version chip is clickable to switch which side is being aligned. ULT/UST cells in the verse strip are contentEditable — edits flow through the shared smart-edit pipe. Display merges adjacent groups whose source chain is identical (e.g. Zec 3:4's two `הָסִ֛ירוּ` milestones become one "Take off" card) and strips compound-internal source words that also appear as standalone groups (Zec 2:8's `אָמַר֮` shows once, not twice) — both are display-only; `state.groups` keeps the original chain so save round-trips. |
| **Smart text edits** | `lib/replace.ts` (`smartEditVerse` / `smartReplaceVerse` / `localizedRewriteVerse`) preserves alignment whenever word counts line up, and otherwise localizes destruction to just the milestones overlapping the change. Wires the strip, the doc/book mode editors, and find/replace through one path. |
| **Alignment serializer** | `AlignmentGroup.textBefore` carries verse-internal punctuation across parse → serialize so we no longer dump commas / quotes / braces at the end of the verse on save. Forward-only fix: legacy verses with the clumped tail need a re-import. |
| **Hebrew Unicode normalization** | Shared `lib/hebrew.ts` exports `nfc(s)`. UHB stores combining marks in legacy "consonant-dagesh-vowel" order (DAGESH CCC=21 before HIRIQ CCC=18); ZEC + LAM milestones come out NFC-normalized (HIRIQ first). Same glyph, different bytes. Every Hebrew↔Hebrew compare (`findSourcePosition`, `buildSourceIndexMap`, `findTargetHighlights`/`findSourceHighlights` in `lib/highlight.ts`, TWL `twHintFor`) normalizes both sides. Measured impact: 0% of ISA/OBA milestones need it; 8.5% of ZEC and 13.8% of LAM milestones would silently mis-resolve without it. |
| **Lexicon hover (main screen)** | UHB verses in rows / columns / book modes render each `\w` token in `HebrewLine` with a `SourceTooltipBody` hover; Shell pre-collects all UHB Strong's from useChapter + useBook and calls `useLexicon` once. |
| **Theme** | unfoldingWord palette (Inspire #31ADE3, Cultivate #70C9CC, Kindle #E59D33, Ocean #014263, Tech #231F20); pure-white surfaces with cool-neutral grey scale. ⌭ icons render Cultivate via `success.main`. |
| **CatalogPicker** | × clear mutes the next blur-driven close (~150 ms) and refocuses the input so a clear-then-typeahead works without re-opening the chip. Used by both support-ref (notes) and TW-article (words). |
| **Go-to-active** | Shell-level `scrollNonce` drives **both** scripture and resource columns: clicking the button recenters the scripture view on the active verse AND scrolls the resource column to the active note/word/verse-group. Bidirectional with timeline clicks (clicking a verse in pinned section snaps the resource column too). |

## Architecture summary

```
[Browser]
  React 18 + MUI v6 (Vite SPA)
  ├── App.tsx                                — URL hash → (book, chapter, verse); hoists useBook
  ├── components/Shell.tsx                   — 3-column shell, mode state, alignerTarget, shared scrollNonce,
  │   │                                        persistVerseEdit (smartEditVerse → dual-apply → outbox)
  │   ├── TopBar.tsx                         — book/chapter dropdowns, prev/next, hash routing
  │   ├── TimelineRail.tsx                   — verse tiles, "done" checkboxes
  │   ├── ScriptureColumn.tsx                — mode picker (rows/columns/book), version segments,
  │   │   │                                    go-to-active button, find toggle, lexiconMap fan-out
  │   │   ├── (rows)    inline render        — stacked card for active verse + compact baseline-aligned
  │   │   │                                    inactive rows; gutter has verse-num row + ULT/UST labels
  │   │   ├── (columns) DocColumn.tsx        — parallel doc-style version columns for the current chapter
  │   │   └── (book)    BookView.tsx         — whole-book CSS-grid scroll, IntersectionObserver lazy
  │   │                                        chapter loading, find-mark highlighting
  │   ├── FindReplaceOverlay.tsx             — sticky panel inside book mode; regex/case, prev/next/replace-all,
  │   │                                        load-full-book, Tab between fields, nav-only scroll signal
  │   ├── ResourceColumn.tsx                 — sections + pin toggles; data-note-id / data-word-id /
  │   │                                        data-verse-group attrs for scroll-to-active resolution
  │   │   ├── NoteCard.tsx                   — per-session versioning (snapshot/pending/undo), AI placeholder
  │   │   ├── WordsTable.tsx                 — drag-reorder twl rows
  │   │   └── QuestionsTable.tsx             — editable ref_raw + question + response
  │   ├── AlignmentDialog.tsx                — custom aligner; editable ULT/UST verse strip,
  │   │                                        clickable other-version chip, lexicon tooltips
  │   ├── HebrewLine.tsx                     — UHB \w-by-\w with hover tooltips (shared by rows/columns/book)
  │   ├── SourceTooltipBody.tsx              — shared lemma / POS / gloss / definition body
  │   └── CatalogPicker.tsx                  — typeahead picker for support refs + TW articles
  ├── hooks/useChapter.ts                    — chapter payload + applyLocalRow{Patch,…} + applyLocalVerse
  ├── hooks/useBook.ts                       — lazy chapter loader for book mode; hoisted in App so the
  │                                            cache survives Shell remounts on chapter nav
  ├── hooks/useCatalogs.ts                   — supportRefs + twLinks (single-module cache)
  ├── hooks/useLexicon.ts                    — Strong's → entry, module-level batched cache
  ├── sync/api.ts                            — fetch client with If-Match handling
  ├── sync/outbox.ts                         — IndexedDB write-ahead queue, drain on focus/online
  ├── lib/alignment.ts                       — parse/serialize \zaln-s tree with `textBefore` per group;
  │                                            clearGroup; moveSource; moveTargets; placeholder synthesis
  ├── lib/replace.ts                         — diffSingleChange + smartEditVerse + smartReplaceVerse +
  │                                            localizedRewriteVerse; tokenizePlainText helper
  ├── lib/highlight.ts                       — quote → aligned target tokens; renderHighlightedHTML
  └── theme.ts                               — unfoldingWord palette

[Cloudflare Workers (Hono on Wrangler v4)]
  api/src/index.ts                           — routing entry
  api/src/chapters.ts                        — GET /api/chapters/:book, /:book/:ch (orders tn/twl by sort_order NULLS LAST)
  api/src/rows.ts                            — POST/PATCH/DELETE /api/rows/:kind[/:id]; sort_order accepted in patch + create
  api/src/verses.ts                          — PATCH /api/verses/:book/:ch/:v/:bibleVersion (UHB/UGNT 403)
  api/src/catalogs.ts                        — GET /api/catalogs
  api/src/lexicon.ts                         — GET /api/lexicon/:strong, GET /api/lexicon?strongs=...
  api/src/chapterRoom.ts                     — Durable Object stub for presence (no UI yet)
  api/migrations/
    0001_init.sql                            — base schema
    0002_verse_status.sql                    — verse_statuses(book, ch, v, done)
    0003_tn_sort_order.sql                   — REAL sort_order on tn_rows
    0004_twl_sort_order.sql                  — REAL sort_order on twl_rows
    0005_lexicon.sql                         — lexicon_entries(strong PRIMARY KEY, resource, lemma, part_of_speech, gloss, definition)

[Storage]
  D1 (local SQLite at api/.wrangler/state/v3/d1) — ~5.5 MB locally with ZEC + lexicon
  R2 (BLOBS binding) — not used yet

[Scripts]
  scripts/import-book.mjs                    — pulls a book's ULT/UST/UHB + TSVs from docs/samples/ → SQL
  scripts/import-lexicon.mjs                 — downloads en_uhal + en_ugl zips, parses Strong's markdown → SQL
  scripts/refresh-verse.mjs                  — recover a single verse from docs/samples (use when a legacy
                                               alignment-serializer bug clumped punctuation at the verse end)
  scripts/out/, scripts/tmp/                 — gitignored (generated SQL + extracted archives)
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
- `node scripts/import-book.mjs <CODE>` then `(cd api && npx wrangler d1 execute bible_editor_dev --local --file=../scripts/out/import-<CODE>.sql)`
- `node scripts/import-lexicon.mjs` then `(cd api && npx wrangler d1 execute bible_editor_dev --local --file=../scripts/out/import-lexicon.sql)`
- `node scripts/refresh-verse.mjs <BOOK> <CH> <V> <VERSION>` then `(cd api && npx wrangler d1 execute bible_editor_dev --local --file=../scripts/out/refresh-<BOOK>-<CH>-<V>-<VERSION>.sql)`

## Quirks the next agent should remember

1. **Wrangler must be v4.** v3 has a hash-table bug that hangs on bulk SQL import.
2. **`wrangler d1 execute --local` is correct in v4** (`--remote` for prod).
3. **The aligner package is gone.** Production is `web/src/components/AlignmentDialog.tsx`, a custom aligner over the stored verse-object tree.
4. **`core-js` is dependency-tree polluted.** Don't try to alias around it.
5. **`contentEditable + dangerouslySetInnerHTML` pattern.** `ActiveLine`, `VerseSpan` (DocColumn), `VerseCell` (BookView), and `EditableStripCell` (aligner) all write DOM via `useEffect` + ref (not React children) so the cursor doesn't jump. `lastSetRef = null` means "first render — always paint" (otherwise plain-text mode never paints, columns appear empty — the bug fix in commit `a260921`).
6. **TSV `\n` literals.** Notes from DCS TSVs contain literal `\n` (two chars). `NoteCard.tsvToDisplay` shows real newlines; saves go back verbatim.
7. **Auth is cookie-based.** DCS OAuth and dev sign-in mint HttpOnly Access/Refresh cookies plus a non-HttpOnly CSRF cookie. Browser writes use cookies + `X-CSRF-Token`; `Authorization: Bearer` remains only as a temporary fallback for non-browser/cutover callers.
8. **Verse-done is global, not per-user.** Migrate to per-user when auth lands.
9. **Permission classifier denies long-running dev servers.** Wrangler dev as a background task is fine; vite needs the user.
10. **Commits use HEREDOC** + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. User isn't on this commit's git config; pass `-c user.email=ju-cldai724@abidinginhesed.com -c user.name=Benjamin` per commit. **The user has explicitly asked to stop making bookmark commits this session — just commit after each completed todo.**
11. **CRLF warnings on every commit** are expected (Windows checkout); they're not errors, ignore.
12. **sort_order math.** `pickSortOrder` chooses a midpoint between neighbors (REAL column, no rebalancing). Insertion at the head/tail jumps by 100. Tn and Twl share the helper via the generic `Sortable` type in `Shell.tsx`.
13. **RTL flex layout.** The aligner grid uses `direction: rtl` (not `flex-direction: row-reverse`) so the first card sits on the right. Card internals must override back to `direction: ltr` for GL chips. Same approach in `VerseStrip`'s source column.
14. **Strong's normalization.** ULT/UST source words carry forms like `b:H2320`, `d:H8066`, `H2148a` (prefix particle + classic + sense suffix). Both `useLexicon.normalizeStrong` and `api/src/lexicon.strongLookupKeys` extract the exact `[HG]\d+[a-z]?` token, strip leading zeros after the letter, and try an alpha-stripped fallback. UGL Strong's-Plus form (classic × 10) is normalized at import time by dividing — dirname is authoritative, the bullet inside each .md file is ignored for UGL.
15. **Source-position sort uses (text, occurrence) primarily** (NFC-normalized), with (strong, occurrence) as fallback. Multiple source words share a Strong's (e.g. `אֶל` and `אֵלָיו` are both H0413), so content-text is the more selective key. Both keys also fall back to `occurrence=1` when the milestone's occurrence overshoots what's available in UHB — a quirk of ULT/UST tagging where the same UHB token is referenced by two milestones with `x-occurrence="1/2"` + `"2/2"` even though UHB only has one match (Zec 2:8 `אָמַר֮`). UHB tokens have no explicit `occurrence` — we count running occurrences per content during the walk.
15a. **Hebrew NFC normalization is mandatory for any Hebrew↔Hebrew compare.** UHB stores DAGESH (CCC=21) BEFORE HIRIQ (CCC=18), the traditional Tanakh order; usfm-js / ULT-UST tooling often re-normalizes to NFC (HIRIQ before DAGESH). Strings render identically, fail strict byte equality. Shared `web/src/lib/hebrew.ts` exports `nfc(s)`; call it on both sides of every compare. Hits zero ISA/OBA milestones, ~9% of ZEC, ~14% of LAM — silently breaks ordering and creates phantom drop slots when missing. The upstream-pipeline fix is to have the AI aligner emit `x-content` byte-identical to the UHB `\w text`; the user has a handoff doc for that team.
16. **`scripts/out/` and `scripts/tmp/` are gitignored.** A predecessor commit accidentally checked in the entire extracted UHAL+UGL archive tree (~31 k files). The ignore + the un-pushed reset prevent recurrences. Don't `git add -A` blindly when a fresh script run is sitting in tmp.
17. **Patch accumulator (replaced by session model for notes).** `WordRow.queue` still merges field-level patches into one PATCH per 350 ms debounce window. `NoteCard` now uses a session model instead: snapshot on activation, accumulate to `pendingRef` without firing, flush on deactivation / unmount / manual save. `hasNetChanges` (local state vs snapshot) drives the save/undo buttons and **skips no-op saves** when the user typed then reverted to the snapshot values.
18. **smartEditVerse fan-out.** All three plain-text verse edit paths (DocColumn's VerseSpan, BookView's VerseCell, AlignmentDialog's EditableStripCell) flow through `Shell.persistVerseEdit` which runs `lib/replace.smartEditVerse(content, oldPlain, newPlain)`. It tries a word-count-preserve path first, then falls back to `localizedRewriteVerse` which keeps milestones outside the change verbatim and splits straddling milestones into before/after halves. Find/replace's `smartReplaceVerse` shares the same localized fallback.
19. **Alignment punctuation.** `parseAlignment` now walks zaln + word + text in document order, stamping accumulated text on each new group as `textBefore`. `serializeAlignment` emits each group's textBefore in place, pooling forward across empty groups. Anything we don't recognize (non-text, non-zaln) still rides along as `prefix` / `passthroughTail`.
20. **Book mode chapter cache lives in App.tsx**, not Shell. `App` mounts `useBook(book, true)` once per book; chapter navigation remounts Shell (key includes chapter+verse) but the bookHook stays alive so lazy-loaded chapters survive.
21. **CatalogPicker × suppression.** MUI's clear button briefly blurs the input. Without handling, this fires onClose(blur) → setOpen(false) → chip view, defeating "clear and keep typing". We mute the next close for ~150 ms via `justClearedRef` and refocus via `requestAnimationFrame`.

## What's deliberately deferred (don't touch unless asked)

- **Bearer fallback removal** once all clients are known to be on cookie sessions.
- **Production export monitoring** for the 06:00 UTC Workflow.
- **Per-user verse-status** (extension of current global flag once auth lands).
- **Full edit-history UI** (Phase 4; `edit_log` already captures every patch).
- **AI generation of notes** — placeholder sparkles button in `NoteCard.tsx`. Disabled; wire it up when a service is picked.
- **Compound-alignment "split source" gesture** — drag a source word OUT of a compound block. `clearGroup` is the current escape hatch.
- **`Hybrid Views.html`** — original design (5 options ranked). Reference only.

## Smoke-test path (for the user)

```sh
cd C:\Users\benja\Documents\GitHub\bible-editor
npm run dev
# open http://localhost:5173 — boots into ZEC 1:1
```

What should work as of `682491d5`:

**Resource column.**
- Notes / Words / Questions. Each section has a pin toggle; pinning shows the resource for the whole chapter with verse-group headers.
- Notes: per-session versioning. Save icon brightens when there are net changes vs the entry snapshot; clicking the note flushes once and exits the session. Undo restores to the entry snapshot and **greys the save** (since pending now matches snapshot). No version bump fires if you typed then reverted.
- Notes head: drag handle, 4-char ID chip, support-ref typeahead chip (empty by default for new notes — no inherited support_reference), ref_raw, version chip with `*` when dirty, undo/save icons, +new, delete. Body: Quote + Note fields. AutoAwesome (sparkles) icon below the NOTE label as an AI-generation placeholder (disabled).
- Questions: editable Ref / Question / Response columns (Ref handles multi-verse spans like `1:1-3`).
- Words: editable orig_words + TW-article picker. Click ★ chip to typeahead; × clears and keeps the picker open ready to type (same fix in support-ref).
- Click any note / word row → it becomes active. Resource column scrolls to the active selection on go-to-active / pin toggle / timeline click.

**Scripture column — three modes, all toggleable from the toolbar.**
- **Rows.** Active verse is a blue card with ULT / UST / UHB lines (each version has the ⌭ icon stacked below its label in the left gutter). Inactive verses sit in a compact 3-row grid: verse-number row (tiny, full-width), then ULT label + ULT text baseline-aligned, then UST label + UST text. Right-aligned gutter; explicit fontSize 14.5, lineHeight 1.45.
- **Columns.** Parallel doc-style version columns for the current chapter; clickable verse spans with ⌭ icons; UHB column renders per-word lexicon tooltips. "Go to active" recenters every column.
- **Book.** Whole-book CSS-grid across enabled versions; IntersectionObserver loads each chapter as you scroll near it. Ctrl/Cmd+F (or the "find" toolbar button) opens a sticky find/replace overlay. Active match scrolls into view only on user-initiated nav, not on every match-list reshape — typing in a cell while the overlay is open no longer pulls you down to the next hit. "load full book" pre-fetches all chapters so search covers the entire book.
- **Hebrew lexicon hover everywhere.** UHB \w tokens in all three modes hover-tooltip with lemma / POS / gloss / definition from UHAL/UGL.

**Alignment dialog (⌭).**
- Verse strip up top with ULT / UST / UHB. ULT and UST cells are contentEditable; edits round-trip through `smartEditVerse` so single-word changes don't destroy the whole verse's alignment. Source-language tokens carry the lexicon tooltip; the "other version" chip is clickable to swap which side is being aligned.
- Body: unaligned bag (multi-select drag, shift-range, × clears selection), alignment grid sorted by source-verse word index, RTL block layout, per-block × clears + ungroups, drag-merge source words between blocks. Placeholder blocks appear for UHB source words the target USFM hasn't referenced yet.
- Save serializes back to USFM verseObjects. `textBefore` on each group now preserves verse-internal punctuation across the round-trip.

**Find/replace.**
- Regex + case-sensitive toggles. Enter / Shift+Enter cycle matches; Tab moves between find and replace fields; Esc closes.
- replace honours alignment: word-count-match replaces preserve milestones; mismatches localize destruction to just the affected milestones (the rest of the verse stays aligned).
- "load full book" button while chapters are still unloaded; "loaded N / M" status in the toolbar.

**Theme.**
- unfoldingWord palette: Inspire (primary), Cultivate (secondary / success / ⌭ icons), Kindle (warning), Ocean (primary.dark), Tech body text. Pure-white surfaces with a cool-neutral grey scale.

## Commit message style

```
<one-line scope-noun: imperative>

Optional 3-7 line body explaining the why and any nuance. Bullet
lists for multi-item changes. Always keep the user-facing intent
visible.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Use HEREDOC: `git commit -m "$(cat <<'EOF'...EOF)"`.

User has asked to **stop the empty `bookmark:` commits** this session — just commit after each completed todo.

## Push + data backup posture

- **Fully pushed** as of this writing. `origin/main` = `682491d5`.
- **D1 data is local-only.** ~5.5 MB at `api/.wrangler/state/v3/d1/`, gitignored. If the workstation is reimaged, the ZEC import + lexicon import + every in-progress edit goes with it. No remote D1 has been provisioned. Suggest a manual SQLite copy when the user asks; don't act unilaterally.

## Known legacy data

- **ZEC 1:10 ULT** still has the pre-fix clumped-punctuation tail (the user observed `… earth , " { . " ` at the end of the verse). The serializer fix in `d434f206` is forward-only — re-saving the verse round-trips the existing bad shape. To recover:
  ```sh
  node scripts/refresh-verse.mjs ZEC 1 10 ULT
  (cd api && npx wrangler d1 execute bible_editor_dev --local --file=../scripts/out/refresh-ZEC-1-10-ULT.sql)
  ```
  The same script handles any other verses found in the same state — pass the (BOOK CH V VERSION) tuple. Output SQL is gitignored.

## Where the user is heading next

The user is taking a feature off to a separate session. Treat this handoff as a clean stopping point — no in-flight work to resume. Once you know what they want to build, re-anchor against [`docs/plan.md`](./plan.md) and start there.

If they ask about general work, the open queue is light:

- **Wire the AI sparkles** under the Note body. Pick the service / prompt path.
- **Compound source "split out" gesture** in the aligner (see Deferred).
- **Edit-history drawer** per row, backed by `edit_log` (already populated). See plan Phase 4.
- **Per-user verse-done flag** — depends on OAuth landing.
- **Production hardening** — remove the bearer fallback when safe, add export failure alerting, and document any Cloudflare dashboard rate limits once configured.

## When in doubt

- Read the plan: [`docs/plan.md`](./plan.md).
- Check user intent: [`docs/design/chats/chat1.md`](./design/chats/chat1.md).
- Skim the last ~10 commits before changing anything — they're tight and tell you what was just touched.
- Ask the user rather than guess. The user is involved and answers fast.
