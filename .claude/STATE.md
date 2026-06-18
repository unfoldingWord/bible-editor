# Loop state · bible-editor

> The agent forgets; this file does not. Read it at the start of a session, update it
> before you finish. It holds **where the work is** — what just happened, what's mid-flight,
> what's blocked on a human, and the durable lessons that aren't in the code.
>
> Pair it with the standing spec: [`CLAUDE.md`](../CLAUDE.md) (how to work here) and
> [`docs/plan.md`](../docs/plan.md) / [`docs/handoff.md`](../docs/handoff.md) (where the project is going).
> **State tells you where you are; the spec tells you where to go.**
>
> Many worktrees edit this file in parallel. Keep the dated sections (**Completed**,
> **Lessons learned**) append-only and newest-first, so a merge conflict resolves by
> keeping both sides. The canonical copy lives on `main` — rebase before relying on it.

## Last run

2026-06-18 · **editor-punctuation-placement** — Fixed reported prod bug: punctuation typed at
the END of a poetic line (em-dash after "city" on a `\q1` line) jumped to the START of the next
(`\q2`) line on save. Root cause in `reconcileMarkers` (`web/src/lib/replace.ts`): marker placement
split the inter-word punctuation gap with a fixed `CLOSING` regex that **deliberately excluded the
em-dash** ("leads as often as it trails"), so any line-ending dash/paren was always shoved past the
marker. Fix: capture each marker's `leadPunct` (the punctuation the translator typed immediately
before the marker token in `newPlain`) and split the gap there — honoring the *typed* position
instead of guessing. `CLOSING` kept only as fallback when the captured position can't be matched
against the tree gap. Strict generalization: Cases 21/22/23/24 still pass (their punctuation sits on
the side the heuristic guessed). Regression Case 22b added (mirrors the screenshots). Pure-punctuation
edits route relayoutUnchangedWords → reconcileMarkers, so reconcile is the placement authority; the
parallel `splitGapAtMarker`/`MARKER_CLOSING_RE` in `smartRebuildRange` (word-edit tier, works on
marker-stripped coords with no typed-position info) was left as-is. web suite + typecheck green.
Branch `claude/editor-punctuation-placement-qdhflx`.

2026-06-18 · **charming-gagarin** — Defense-in-depth guards on the DCS→D1 reimport so a
still-dirty master can never re-introduce the TN id/duplication defects (mint engine already
disabled by #183/#225; this is structural insurance). **Guard 1 (id):** `coerceRowId` (new pure
leaf `api/src/rowId.ts`, deterministic FNV-1a → valid `^[a-z][a-z0-9]{3}$`, no-op for valid ids)
applied in the shared `parseTsvRow`, so the apply by-id read, diff gate, and prune all agree on the
coerced id — the prune therefore never deletes an inserted-under-coerced-id row. Chose deterministic
over random `newRowId()`+map (user-confirmed): no map to thread across nightly Workflow steps,
idempotent across nights, even self-heals a bad id already in D1. **Guard 2 (content-dedup, TN
only):** new pure leaf `api/src/tnDedup.ts` (`tnContentKey` + `planTnContentDedup`) skips inserting a
row whose (chapter, verse, occurrence, support_reference, quote, note) already exists LIVE+PRISTINE
under a different id; occurrence is in the key (ISA 10:9 אִם occ 1/2 stay distinct); never dedups
against `updated_by`/`preserve`/`hint` rows (human work). Zero extra D1 reads (decision is pure off
the existing by-id map). Added `skipped_dup` counter. Centralized `ROW_ID_RE`/`isValidRowId`/`newRowId`
into `rowId.ts` (pipelineImport + rows.ts now import from there). Unit tests `rowId.test.mjs` (21
asserts) + `tnDedup.test.mjs` (16 asserts, incl. doubling/rename/order-independence/human-protection),
wired into `npm --workspace api test`. typecheck + full API suite green. **Prod read-only sanity:**
0 LIVE digit-first TN ids (the 141 `id GLOB '[0-9]*'` hits are all `deleted_at` TOMBSTONES from the
6-18 sweep — a future audit must filter `deleted_at IS NULL`); but found **1 live pristine
content-dup** still present (see Escalated). Branch `claude/charming-gagarin-4fbc55`. Not yet PR'd.

2026-06-18 · **determined-meitner** — TN double-space-after-punctuation churn. bp-assistant emits
notes with `.  ` / `,  ` double spaces; maintainers normalize to single-space on en_tn master, so D1
diverges and every nightly export pushes a whitespace-only change to the `-be-` branch — which on
2026-06-18 produced a real, committed-unresolved merge conflict in `tn_ISA.tsv` (vibrant-raman cleanup).
Fix: added `normalizeNoteWhitespace` to `importParsers.ts` (collapses interior 2+ ASCII-space runs to
one, per logical line split on the literal `\n` escape; preserves leading indentation, trailing space,
and markdown table rows `|`) and wired it into the AI ingest chokepoint `pipelineImport.tnPayload`
(covers applyTnInsert + hint-expansion + the edit_log audit). Reimport-from-master + editor PATCH paths
left UNTOUCHED (master is the normalized source; editor input is literal). Also `findSuspiciousDoubleSpaces`
flags double spaces NOT after `.?!` (may mask a dropped word — ISA "**understanding**,  could" was missing
"you") for human review without auto-editing content. One-time cleanup script `scripts/normalize-tn-whitespace.mjs`
(dedup-tn.mjs pattern; PRISTINE `updated_by IS NULL` rows only; SQL guarded on unchanged-note + updated_by
IS NULL so a row edited between dump/apply is skipped). 38 unit assertions + full api+web typecheck green.
PR #229. **Prod cleanup APPLIED 2026-06-18: 20 rows healed (ISA 17, HOS 2, LAM 1), version-bumped + 20
`normalize_whitespace` edit_log rows; post-apply dry-run = 0 remaining candidates (D1 converged to
single-space).** Per user choice, did NOT manually re-export — the 06:00 UTC nightly cron will re-export
ISA/HOS/LAM and (since D1 now matches master) the `-be-` branches stop diffing on whitespace. 16 notes
flagged suspicious (possible dropped word, e.g. ISA "**understanding**,  could" missing "you") handed off
for separate human content review — whitespace was still collapsed. Branch `claude/determined-meitner-67e5bf`.

2026-06-17 · **epic-yalow** — Edge quotes on HOS 9:17 UST unaligned the WHOLE verse (13→0 ms).
The verse is dense with INTERIOR `\q2`/`\q2`/`\q1` poetry markers, and `relayoutUnchangedWords`
(the #214/#215 whole-verse punctuation tier) still BAILED on any interior marker → dropped to
`localizedRewrite` → flatten. Fix: removed the interior-marker bail (kept `\qs` wrapper +
split-possessive guards), added `hasInteriorInflowMarker()`, and FORCE Step 2 `reconcileMarkers`
when a relayout crossed an interior marker (`relaidNeedsMarkerReconcile`) — edge quotes shift no
word count so `markersChanged` was false and Step 2 was being skipped. The relayout now only needs
the marker-STRIPPED text correct (self-checked); reconcile re-places markers by word-anchor +
closing-punct rule (opening `“`/`‘` correctly stay AFTER the marker). Verified on the REAL verse
(DCS master `28-HOS.usfm` via usfm-js): 13→13 ms, 3 markers + both edge quotes intact. replace.test
Cases 60 (updated) + 61 (new); 271 assertions + full typecheck green. Shipped as PR #226.
Prod HOS/9/17/UST checked (v6): NOT flattened — the editor manually re-aligned after the flattening
(10 ms, all 31 words covered, 0 unaligned), so NO heal-from-master (would clobber her work). Two
cosmetic marker deltas vs master remain (missing `\q2` before "The God…"; stray trailing `\q1`) —
editor will fix the line breaks in-app; zero alignment impact. Branch `claude/epic-yalow-f452cc`.

2026-06-17 · **goofy-ptolemy** — Root-cause fix: Shell no longer remounts on chapter nav.
App.tsx keys Shell on `book` only (was `book-chapter-verse`); a new Shell effect keyed on
`[chapter, initialVerse]` (skips initial mount) resets the per-chapter transient state the
remount used to clear (activeVerse/Note/Word, aligner + dual panels, their dirty/pending gates,
panelMode). useChapter keeps prior `data` during the fetch, so cross-chapter nav now has no
loading flash and find + book view survive. Removed the now-redundant `findSession.ts` singleton
(added in #220/#221) and reverted its seeds in FindReplaceOverlay/ScriptureColumn; KEPT the
`activeChapter` cross-chapter auto-jump suppression. Verified live (Playwright, all 3 modes):
full ZEC "year" walk crosses ch1→7 with find box persisting + book view intact, aligner closes
cleanly on nav with no stuck gate, back/forward + deep-link land correctly. typecheck clean.
Not yet PR'd.

## In progress

- **trusting-mclean** (2026-06-18) — Fix AI "-e"/orphan-`\zaln-e` corruption (MIC 6:10 UST; deferred
  workstream from `project_ai_dash_e_zaln_corruption_mic610`). Confirmed via parsing the REAL en_ust master
  verse that usfm-js produces two junk shapes — a node whose own `tag` IS the end-marker
  (`{tag:"zaln-e\\*", content:"-e "}`) and a text node of standalone `-e` tokens that also carries the real
  `?` (orphan `\zaln-e\*` markers ALONE are silently swallowed; `-e` is literal AI text). Shipped
  `stripOrphanAlignmentMarkers` (`api/src/importParsers.ts`): drops orphan-tag nodes + strips standalone
  `-e` tokens in place (token boundaries keep "re-entry" safe; touches only bare text + orphan-tag nodes,
  never `\w` words → a broken clause just falls through as unaligned `\w`). Identity no-op on clean verses.
  Wired into `extractVersesForRange` (bootstrap/reimport/AI raw-USFM) + the `pipelineImport` payload path,
  mirroring `healReplacementChars`. Regression cases + full api suite + both typechecks green; verified on
  the real master verse (0 junk, words preserved, plain_text clean). **Prod scan: exactly 1 affected row —
  MIC 6:10 UST v12.** Editor rewrote the verse + deleted the visible `-e`, but 1 residual orphan node
  survived (invisible in plain_text; re-exports `\zaln-e\* -e` to DCS on the nightly). **Heal SQL ready at
  `scripts/out/heal-mic610.sql`** (version-guarded v12→v13, plain_text byte-identical, audited) but the
  classifier BLOCKED the prod write — lead only asked to *check* prod. **PENDING lead OK to apply.** DCS
  master 33-MIC.usfm still fully corrupt; the nightly D1→master export heals it once D1 is clean. Branch
  `claude/trusting-mclean-8e3ba4`, commit 28854953. Not yet PR'd.
- **vibrant-raman** (2026-06-18) — Heal AI-TN id/dup rot on en_tn master. tn_ISA.tsv had 3 unresolved
  git conflict markers (Richard Mahn's local `git merge origin/master` into the ISA `-be-` branch, then
  PR-merged to master) + 94 dup-note rows; ZEC 34 dups, NUM 1 dup, HOS 6 unique digit-first ids; ECC
  already clean. Root cause = the AI-TN duplication round-trip ([[reimport re-inflates D1 from master]]):
  validate-be `[5. ID Check]` flagged 132 digit-first ids (ISA 94/ZEC 28/HOS 6/ECC 3/NUM 1); proved the
  newRowId fix is NOT regressed — D1's 94 ISA digit-first ids are an EXACT mirror of master's, so all
  perpetuated from master by the nightly reimport, none freshly minted. **en_tn PR #7164** opened
  (branch `bible-editor-heal-tn-ids-dups-20260618`, mergeable, +6/−144, 0 markers/0 digit-first/0 dups
  in all 4 files). **DONE 2026-06-18**: PR #7164 MERGED (merge commit `8046caaab7`); D1 reconciled
  (`scripts/out/heal/d1_*.sql`: 94+34+1 soft-deletes + 6 HOS renames via `heal-tn.mjs`, gitignored).
  Verified master AND D1: **0 conflict markers, 0 digit-first ids, 0 pristine-AI dups** across all 5 books.
  LESSON: dedup key MUST include `occurrence` (ISA 10:9 has 2 legit notes for אִם occ 1+2) and MUST exclude
  editor-touched rows — 6 HOS rows that looked like dups were human-authored (user 35, `source=None`,
  one `preserve`d, one `hint`/`unhint`) and were correctly LEFT untouched. Two follow-ups spawned as task
  chips: (1) normalize double-space in AI notes (the whitespace divergence that caused the ISA conflict
  markers); (2) bookReimport content-dedup + digit-first guard (defense-in-depth; PR #183/#225 already
  disabled the mint engine, so cleanup alone stopped the bleeding).
- **determined-meitner** — TN double-space normalizer (ingest fix + cleanup script). Code + tests done,
  branch `claude/determined-meitner-67e5bf`, ready for PR. Prod cleanup SQL generated (20 rows) but NOT
  applied; awaiting human review of the 16 suspicious notes + go-ahead to apply + re-export ISA/HOS/LAM.
- **epic-yalow** — HOS 9:17 interior-marker edge-quote unalign fix → PR #226. Prod data checked:
  fully aligned (editor recovered it), no heal needed; minor markers left for in-app fix.
- **goofy-ptolemy** — Shell-remount root-cause fix (see Last run). Branch
  `claude/goofy-ptolemy-e9369f`. Ready for PR.
- **trusting-galileo** (PR #220) — Find in book mode: two fixes for cross-chapter notes remounting Shell
  (Shell is keyed on book/chapter/verse in App.tsx, and the resource column is bound to one chapter via
  useChapter, so a cross-chapter note jump goes through the URL and remounts). (1) Auto-jump-to-first-match
  on typing no longer navigates to a cross-chapter note (the chapter-0 book-intro note sorts first + matches
  common words → was yanking to ZEC/0 on the first keystroke). (2) Explicit prev/next walking *does* cross
  chapters — so the find session (open flag, query, activeIdx) now lives in a module singleton
  `findSession.ts` and is restored after the remount (Shell's existing pendingNoteJump re-activates the note),
  so the find box no longer vanishes mid-walk and next/prev continues seamlessly. Cleared on explicit close.
  `FindReplaceOverlay.tsx` + `ScriptureColumn.tsx` + `findSession.ts`. Verified live (Playwright, full ZEC walk).
- _(none currently tracked here — add the branch + a one-line status when you pick up work)_
- Follow-up watch: edge-punctuation whole-verse unalign fix (PR #214, merged) is **code branch-only**;
  prod ZEC 7:14 ULT was healed to v5 by data fix but the engine change is **not yet deployed**.

## Completed (recently merged → main, newest first)

- **charming-bardeen** — Heal AI-mangled `U+FFFD` in alignment source attrs (x-content/x-lemma/x-morph).
  HOS 8:4 UST "gold" showed `וּזְה❖❖בָם` — real byte corruption (a multi-byte Hebrew mark mangled to
  replacement chars by the AI aligner), not display. Corpus-wide: **69 prod rows** (45 UST + 24 ULT)
  across the AI-worked books (ECC, HOS, ISA, JER, LAM, MIC, NUM, PSA, ZEC); 68 pristine, so the nightly
  reimport of the still-corrupt upstream master would re-clobber a data-only fix. Fix = shared
  `healReplacementChars` (importParsers.ts) reconstructing each corrupt attr from the parallel UHB/UGNT
  word (match by Strong's + surviving-char subsequence; ambiguous → left as-is), wired into the reimport
  (`bookReimport.applyVerseRows`) and AI-apply (`pipelineImport`) paths, both gated on a `.includes("�")`.
  Structure-preserving — only the attribute string changes, so nothing unaligns (proven on all 69 real
  rows: 0 structural/plain_text deltas). **Prod data already healed** via `scripts/scan-replacement-chars.mjs`
  (version-bumped + edit_log `heal-replacement-chars`); 0 `U+FFFD` remain corpus-wide.
- #214 — Fix whole-verse unalign when adding quotes at a verse's edges (`7acb5266`)
- #213 — Spacing between undo and save buttons + document PR merge-check workflow in CLAUDE.md
- #212 — Move save button to verse level; add column labels above columns in book view
- #211 — Detect typed/AI USFM markers so `\q2` isn't shown as alignable text
- #210 — Version indicator in topbar ("App update available" chip)
- #209 — strange-hopper: keep alignment intact across whole-verse text edits; don't lift `\qs` wrapper text

## Escalated / blocked on a human (not a code change Claude can land alone)

- **Prod `DEU 27:22` TN content-dup** — 2 live PRISTINE notes, same content (occ 1, quote `שֹׁכֵב֙ עִם`,
  note "See how you translated 'lies with'…") under ids `y3oq` + `oi0y` (both valid ids — a pure
  doubling, not a digit-first id). The new reimport Guard 2 PREVENTS new doubles but does NOT remediate
  this existing pair (it's insert-time only). Remediate by soft-deleting one copy (`scripts/dedup-tn.mjs`
  or the prod verse-repair pattern: version+1 + edit_log). Found 2026-06-18 via a corpus-wide live
  pristine content-key scan (only 1 such group corpus-wide). (memory: tn-ai-duplication-roundtrip)
- **en_ust master `PSA 24:6` UST** — unclosed `\qs` Selah still malformed on master; D1 already healed (v2).
  Needs the `-be-` export branch merged to land the fix. (memory: selah-qs-malformation-psa246)
- **Prod `MIC 5:5`** — bracket/period-marker engine bugs fixed in code, but the already-stored verse
  still needs re-alignment / re-import. (memory: mic-bracket-and-period-marker-bugs)
- **AI TN doubling, master `ISA 10:29`** — remediate doubled notes via `scripts/dedup-tn.mjs`;
  D1 copy `ISA 29:30` also affected. Root fix shipped; existing rows still need the cleanup pass.
  (memory: tn-ai-duplication-roundtrip)
- **Dangling `-be-` export refs** — `DCS_SERVICE_TOKEN` can't delete branches; drifted branches must be
  cleared by hand with a maintainer PAT. (memory: export-service-token-no-delete, export-branch-no-rebase-drift)

## Lessons learned (write durable, cross-session facts here — not in chat)

For the full corpus, see the memory index at
`C:\Users\benja\.claude\projects\C--Users-benja-Documents-GitHub-bible-editor\memory\MEMORY.md`.
Highlights that bite repeatedly:

- **Fresh worktree:** run `scripts/worktree-init.ps1` to junction `node_modules` from main —
  never reflexively `npm install` on a branch (it leaks deps into main). Only `npm install` in MAIN.
- **Don't kill shared dev servers.** Multiple worktrees share Chrome MCP + dev ports (5173/5174/8787).
  Pick a free port or ask; never `taskkill` a port owner. `5173` is svchost-reserved on this box — relocate vite.
- **Migrations collide across parallel worktrees.** Check `wrangler d1 migrations list --remote` after any
  schema PR; a collided migration number left prod unmigrated → list-route 500s once already.
- **PR already merged?** Before pushing, run `gh pr view --json state,mergedAt`. If merged, rebase onto main,
  branch fresh, open a new PR — do not push to the merged branch. This happens regularly.
- **Hebrew compares must go through `nfc()`** (`web/src/lib/hebrew.ts`) — UHB stores combining marks in legacy
  order; milestones come out NFC. Skipping this silently breaks alignment matching.
- **`usfm-js` parks leading punctuation/markers on the node's `text`** — markers can carry text; opening
  quotes after a marker live on the marker node, not as a sibling.
- **Export USFM puts punctuation outside `\w` (`\w earth\w*.`) on purpose** — correct uW form, not churn; don't "fix" it.

## Stop conditions / goals

- No standing automated loop is wired to this file yet. When one is, record its goal here, e.g.:
  - `/goal "npm run typecheck && npm run build clean"` — met on `<commit>` at `<time>`.
