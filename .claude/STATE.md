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

2026-06-25 · **great-shamir (cont.)** — **ALL 4 TWL phases shipped → [PR #267](https://github.com/deferredreward/bible-editor/pull/267)**
(branch `claude/great-shamir-8b15f8`, NOT merged/deployed). **Phase 1:** migration `0032_tw_articles` +
`scripts/import-tw.mjs` (one en_tw master.zip → 953 articles; mirrors import-lexicon, no zip dep) + `/api/catalogs`
canonical list. **Phase 2:** ported matcher `api/src/twlMatcher.ts` (buildTermTrie/scanVerseMatches + term-map
extraction; +twlMatcher.test.mjs 15 asserts), route `GET /api/twl-suggestions/:book/:ch/:v` (api/src/twlSuggest.ts),
client resolver `web/src/lib/twlResolve.ts` (English span→{orig_words,occurrence,confident}; +test 8 asserts),
`TwlSuggestions.tsx` pick-to-add UI under the active-verse Words list. **Browser-verified ZEC 1:3:** suggestion
"Yahweh of Armies"→kt/yahwehofhosts (distinct from linked kt/yahweh), Add created row orig_words "יְהוָה צְבָאוֹת"
occ1 + keyterm tag confidently. **Codex review (manual + PR-open hook) → 3 fixes committed (662170ab):**
(a) existing-link exclusion moved CLIENT-side keyed on resolved (tw_link,orig_words,occurrence) — server can't map
OL↔GL occurrence so a server count mis-identified/duplicated; route now returns all matches + Shell
`isTwlSuggestionExcluded` filters; (b) disambiguation Tags now follow the CHOSEN article's category; (c) low-confidence
picker pre-seed reads resolved orig_words directly, not the stale (pre-insert) data snapshot. typecheck + api/web tests
+ build all green. **DEPLOY NOTE after merge:** apply migration 0032 to prod + run import-tw.mjs → load import-tw.sql
to prod D1 (until seeded, catalog falls back to usage-derived links and suggestions are empty). Memory:
[[project_twl_generation_into_app]].

2026-06-25 · **great-shamir** — **Bringing Rich's TWL generation into the app (Beth/Rich Zulip ask).** Deep
feasibility + Codex review + approved plan (`C:\Users\benja\.claude\plans\immutable-snuggling-snowflake.md`,
full 4-phase build, port Rich's matcher core). **Phases 0a + 0b SHIPPED IN-BRANCH + browser-verified** (own
wrangler dev :8795 against worktree bundle, junctioned to main's seeded local D1, ZEC). **0a:** WordsTable now
shows an **editable Occurrence** field + a **read-only English (ULT) gloss** under each Hebrew quote (reuses
`extractTargetSelectionText` in highlight.ts, OL-anchored via UHB; threaded `onWordGloss` Shell→ResourceColumn→
WordsTable). Verified live: ZEC 1:3 shows occ=2 for the 2nd יְהוָה, gloss שׁ֣וּבוּ→"Return", יְהוָה→"Yahweh".
**0b:** generalized Shell's quote-build session from note-only (`quoteBuildNoteId`) to a target
`{kind:"tn"|"twl", id}` so the existing `QuoteBuilderPopper` mounts on **Words** rows too (build button per
row; anchors via `[data-word-id]`; commit writes `{orig_words, occurrence}` via `enqueueRow("twl")`; WordRow
re-seeds from the optimistic patch, so no applied-nonce needed). Verified live: picker opened on שׁ֣וּבוּ row,
pre-seeded from existing quote, added אֵלַ֔⁠י → "USE SELECTION" → server v2→v3 orig_words="שׁ֣וּבוּ אֵלַ֔⁠י"
tw_link preserved (reverted the seed row after). typecheck + build + console all clean. **NOT committed/PR'd
yet** (no commit-without-ask). **Phases 1 + 2 REMAIN (the big build, see In progress).** Key feasibility
finding: the app already owns occurrence round-trip + the English→OL quote+occurrence builder; node-twl-generator
is English-first (match ULT→TW headwords; OL occurrence comes from alignment the app already has). Memory:
[[project_twl_generation_into_app]].

2026-06-24 · **reverent-nightingale** — Closed the TWO latent nightly-sync code gaps behind the HAB tn
incident (truncated master fetch soft-deleted 559 pristine tn rows; export guards caught it, manual repair
fixed the data). **Not yet committed/PR'd.** API typecheck + full api test suite green.
**(1) Truncated-fetch completeness gate** — new pure module `api/src/shrinkGuard.ts`
(`isCatastrophicTsvShrink`, MIN_LIVE=20, RATIO=0.5: bail when a ≥20-row book's incoming TSV parses to <50%
of live D1 rows). `tsvFetchLooksTruncated` (bookReimport.ts) wraps it with the row counts and is wired into
**both** `planAndStageBookResources` (nightly — returns the resource with `masterSha:null` so NO watermark
is stamped, which kills the SHA-poison "second trap") and `runReimport` (user path — nulls the raw → no
apply/prune; shows as dcs_404). Verses exempt (never row-pruned). `fetchText` (dcsSources.ts) now warns on a
missing Content-Length (transport layer can't verify completeness without it; the row-count gate is the real
backstop). **(2) Tombstone resurrection** — `applyTsvRows` revives a pristine tombstone master still carries
(new `cur.deleted_at != null` branch, runs BEFORE the no-op check) iff `isPristineTombstone` (column shape)
AND `lastTsvDeleteWasReimport` (edit_log latest delete `source='dcs_reimport'`). The edit_log check is
**mandatory**: nightly trash-finalize (index.ts:244) does `deleted_at=trashed_at, trashed_at=NULL` leaving
`updated_by` NULL, so a human-trashed-then-promoted note is column-identical to a reimport prune — only
`source` ('nightly_finalize' vs 'dcs_reimport') separates them. Resurrect reuses `buildTsvUpdateStmt(...,
resurrect=true)` (flips guard to `deleted_at IS NOT NULL`, prepends `deleted_at=NULL` to SET — no param-pos
shift), audited action='restore', new `resurrected` ReimportCounts field. Also converted the two
`BookNotImportedError`/`ImportInProgressError` parameter-property constructors to explicit field assignment
so node `--experimental-strip-types` can load the module for tests. **Tests:** `shrinkGuard.test.mjs`
(14 asserts, incl. the HAB 252→1 case + 50% boundary + small-book exemption) and `dcsSources.test.mjs`
(fetchText with a mocked global fetch: declared-length short-read retry, both-truncated→null, missing-CL
still returns, gzip-longer accepted) — both registered in `api` npm test. **Note:** the already-poisoned prod
HAB watermark from the incident still needs the manual repair / an advancing master SHA to trigger the new
self-heal; the code prevents recurrence and auto-heals on the next genuine fetch. Branch
`claude/reverent-nightingale-4bc705`.

2026-06-24 · **objective-kilby** — Fixed "Find in book mode blanks the page / bumps me out." Root cause
(reproduced live, ZEC seeded): Find's results sort the **book-intro note at chapter 0** first; pressing
Enter/Next navigates there (`#/ZEC/0`). Chapter 0 (front matter) has a note but **no scripture verses**, so
`availableVersions = Object.keys(data.verses)` for the active chapter was `[]` → `displayedVersions = []` →
`BookView` got zero columns and every chapter's `verseNums` was empty: blank scripture column, reading
position lost. **Fix (Shell.tsx):** in book mode `availableVersions` now unions versions across all loaded
book chapters, so a notes-only front-matter active chapter can't collapse the whole book view. **Also added
`AppErrorBoundary` (main.tsx):** the app had NO error boundary anywhere, so any uncaught render error blanked
everything — notably stale `React.lazy` chunks (BookView / FindReplaceOverlay) after a deploy, which Suspense
does NOT catch. Boundary auto-reloads once on a chunk-load error (15s guard against loops; matches both
"Failed to fetch dynamically imported module" AND the Cloudflare-[assets] SPA-fallback MIME error "Failed to
load module script…"), else shows a recoverable "Reload" screen. All paths browser-verified; typecheck clean.
PR opened off `claude/objective-kilby-fa7b66`. Not yet deployed.

2026-06-24 · **inspiring-faraday (follow-ups)** — Two scoped prod ops after the main migration.
**(1) Isa 38:9-20 swap:** the user regenerated the Hezekiah-psalm AI notes on en_tn master (Hebrew-aligned,
new ids ywad/rnsj/…). `scripts/import-isa-3820.mjs` (forced upsert+prune by DCS id, SCOPED to 38:9-20,
handles composite-PK `(id,book)` collisions, safety-reports preserve/hint) → pruned 27 old, inserted 57 new
(updated_by=NULL = clean master-backed, source='isa_3820_swap'); 0 protected, 0 collisions. Applied via 3
segments. **(2) Chapter intros — provenance-gated:** checked first per the user — **Isa 36:intro (arr9 +
nuia) + 37:intro (vy96) are HUMAN-EDITED (updated_by=31, edit_log update/source=null) → NOT touched.**
38:intro (cgq6) + 39:intro (lz5x) pristine. Adapted the 2Ki 20 intro (figs/illness) onto **Isa 38 intro
(cgq6)**, minimal pass, flagged review_kind='adapted-intro' (`scripts/build-intro-sql.mjs`). Isa 39 intro
left (2Ki 20 intro has no envoy content). **2Ki 18/19 intro material (incl. the quotation-levels discussion
the migrated notes reference) NOT folded into the human-edited Isa 36/37 intros — left for the user.**
Final prod: ISA 36-39 = 328 live, 43 flagged. NB classifier (shell auto-approval) had a multi-hour transient
outage mid-task; both scripts were prepped offline and run once it cleared.

2026-06-23 (late) · **inspiring-faraday** — **SHIPPED + LOADED TO PROD.** PR #261 merged (Codex-reviewed:
2 blocking — no-op review-clear now excludes reorder-only + version/deleted_at-guarded; load preflight done).
Migration 0031 applied to prod; worker deployed (version 40695761). **Deterministic load applied to prod D1**
(snapshot saved scripts/out/kings-isa/snapshot-ISA-36-39.json; 5664 existing ISA ids excluded → 0 id
collisions; 0 preserve/hint rows in target verses): soft-deleted 207 live notes in 65 target verses, inserted
236 adapted notes (source='parallel_migration'). **Verified prod: 298 live ISA 36-39 notes, 156 flagged (in
cleanup chip), 37:1-9=23 untouched, 38:9-20=27 untouched.** **AI ENHANCEMENT LOOP COMPLETE (overnight):**
Sonnet via Agent SDK adapted all 156 flagged notes in 15 verse-batches (build-ai-batches.mjs → 15
subagents → validate-ai.mjs). Re-anchored **139 quotes to EXACT Isaiah UHB spans (0 hallucinated** — every
AI quote hard-validated as a real Isaiah substring; invalid→fallback+keep-flag), reworded dropped
cross-refs to prose, flagged 4 as likely-inapplicable. Applied to prod (update-ai-ISA.sql, 3 segments;
seg002 needed a retry on the flaky link — "Not currently importing anything" is a transient D1
import-session error, re-runs clean). **FINAL prod state: 298 live, 44 flagged** (16 reorder-zone + 16
med-confidence + 8 quote-anchor + 4 delete-candidates), down from 156. Morning worklist:
scripts/out/kings-isa/MORNING-WORKLIST.md. Rollback artifacts: snapshot-ISA-36-39.json (pre-migration) +
adapt-batch.json (deterministic baseline). Tooling committed locally (512d13d1) on the merged branch —
needs a fresh follow-up PR (build-ai-batches/validate-ai/split-sql.mjs). **Lesson:** coerceRowId mints from
a geometric hash progression (mod 31) → only ~700 distinct ids, unusable for bulk minting; mint from
independent hash bit-slices instead.

2026-06-23 · **inspiring-faraday** — Started the 2 Kings 18-20 → Isaiah 36-39 TN adaptation (see **In
progress** for full detail). Track A (cleanup-chip review-flag feature: migration 0031 + lint + rows PATCH
clear) is code-complete, API-typecheck-clean, 17 lint tests green, 0031 applied to local dev. Track B spine
(verse map + validation) done: 236 of 305 notes migrate across 65 ISA verses. Remaining: the adaptation
engine + AI pass + dry-run + prod deploy/load. Not committed/deployed yet.

2026-06-22 · **relaxed-haslett** — Fixed the in-app **book-lint "issues to clean up" chip going stale**
(proofreader cleaned ISA validation errors but the topbar count didn't go away until reload). Root cause:
`useBookLint` (web/src/hooks/useBookLint.ts) fetches `GET /api/books/:book/lint` **once per book change** and
exposes `refetch()` — but **nothing ever called it** (the chip was frozen for the whole session in a book; a
full reload was the only refresh). Validation logic + endpoint were correct (reads live D1, filters
`deleted_at`/`trashed_at`; `bracketProblems` is a standard balanced-matcher) — purely a UI-refresh gap.
**Fix (PR #255, MERGED + DEPLOYED to prod, frontend-only):** `Shell.tsx` subscribes to `onOutboxResult` and,
on a TN-row or verse write `ok` for the current book (the only edits lint covers — TN flag checks + ULT/UST
footnote integrity), debounces 1s and calls `bookLint.refetch()` via a shared `scheduleLintRefetch`. **Codex
review caught a reachable gap** that's now fixed: TN **trash/restore** are direct API calls
(`api.trashNote`/`restoreNote`), NOT outbox ops, so the listener never fired for them — yet the lint endpoint
filters `trashed_at IS NULL`, so trashing a flagged note must drop the count / restore re-adds it; both handlers
now call `scheduleLintRefetch()` on success. (Also nulled the debounce timer ref in effect cleanup — Codex
tidiness note.) **Verified end-to-end LIVE** (own single-server wrangler on :8795 against the worktree bundle,
seeded ZEC): injected an unbalanced `[` into ZEC 1:3 note `hm40` via API → chip showed "1"; fixed it in the UI +
Save → network trace `PATCH /api/rows/tn/hm40 [200]` → **app's own `GET /api/books/ZEC/lint [200]` ~1s later** →
chip cleared, server flagCount 1→0. typecheck + build green. **Deployed `wrangler deploy --env production`**
(version `a3421292`, prod `version.json` commit `57022238`); first attempt's ExportWorkflow-trigger registration
hit a transient CF Workflows API error — worker/SPA/crons deployed fine, and an idempotent re-deploy registered
`workflow: bible-editor-export` cleanly. Branch `claude/relaxed-haslett-09eb6f`.

2026-06-22 · **lucid-lewin** — Diagnosed + fixed AI pipeline jobs stuck on **"running"**. Coworker
reported `notes ISA 41` (justplainjane47) wedged on running even after a Zulip msg said it `failed: EACCES …
/app/logs/notes.log`. **Task 1 (clear if running): nothing to clear** — prod D1 had two ISA 41 notes rows,
both terminal: justplainjane47's `be42c513…` already auto-`failed` via the 100-poll backstop (`error_kind=
interrupted`, attempt_count 101, ~26h late), and stephenwunrow's re-run `8d2d2a68…` (today) `done` (door43
PR #7185). Zero non-terminal jobs anywhere. **Task 2 (get updated info sooner): root cause found** — the bot
returns `interrupted:true` with a **frozen** `state:"running"` on every poll; `pollPipelineJob` read
`data.state` but **ignored `data.interrupted`**, so the job held the bot slot + chapter lock until the blunt
`MAX_POLL_ATTEMPTS` (~8h) backstop. Local `updated_at` refreshes each poll so the 48h time guard never fires
for this mode. **Fix (PR #254, this branch):** honor `data.interrupted` — when true AND state non-terminal,
store `failed`/`error_kind=interrupted`, rewrite the GET-by-id response so the tab stops polling; existing
terminal-transition `dispatchNext` frees the slot. Signal verified clean: stuck job was the ONLY prod row ever
carrying `interrupted:true`; healthy/done carry `interrupted:false`. API `tsc` clean. **NOT yet deployed to
prod** (awaiting OK). **Open, bp-assistant side (not this repo):** the bot's silent admin-log EACCES means
failures don't reach `uw-bt-bot.fly.dev/admin` — flag to that team. (memory: project_pipeline_interrupted_flag_gap)

2026-06-20 · **suspicious-poitras** — Cleared the nightly export's **align-shrink block on JER UST** (the
`export_align_shrink:JER:ust` "BLOCKED … lost alignment on \"Jeremiah\"" alert). This was a **prod DATA
repair, not a code change** — the export-side `usfmAlignmentShrinkRefused` guard (`exportWorkflow.ts`
`checkUsfmAlignmentShrink`) is LIVE and did its job: it caught bad D1 data and refused to ship it. Root cause:
**JER 30:1 UST** — a translator wrapped `another`→`{another}` (UST implied-word braces); that edit
**collaterally de-aligned `Jeremiah`** at the far end of the verse (it fell out of `\zaln-s H3414`
יִרְמְיָ֔הוּ and went bare) — the 1CH 4:21 / NUM 24 signature, landed in D1 before/around the engine fixes.
Scanned ALL 1361 JER UST verses vs master: **exactly 1 offender**. Heal source = **master itself** (the
guard kept master clean), unlike `heal-align-1ch-num.mjs` where master was the damaged side and a pre-export
commit was the clean baseline. Heal = `smartEditVerse(masterAlignedVerse, masterEditable, d1Editable)` →
re-applies the `{another}` edit onto master's fully-aligned tree through the CURRENT engine: 8 aligned / 0
bare, plain text byte-identical to D1, structurally == master except the braces, post-heal guard delta 0
`lost`. **Applied to prod D1** (`scripts/out/heal-jer30.sql`, gitignored): version-conditional UPDATE
(`AND version=4`) v4→v5, `updated_by=2`, + guarded `edit_log` audit (`heal-export-align-loss`/`data_repair`).
**Re-exported** targeted (`wrangler workflows trigger bible-editor-export '{"book":"JER","resource":"ust"}'`,
instance `33a4ff9a…`): `dcsChanged:true`, `dcsSkippedReason:null` (gate passed), committed to branch
`JER-be-Grant_Ailie` (`febe345e`), **PR #4122** created on en_ust; verified the committed branch carries
`Jeremiah` re-aligned + `{another}` preserved. Safe against the pre-export DCS→D1 sync because reimport's
verse UPDATE is guarded on `AND updated_by IS NULL` (`bookReimport.ts`) and the heal set `updated_by=2`. The
banner alert (id 9) was already dismissed. PR #4122 still needs MERGE to land on master (manual export left
`validateAndMerge=false`) — the 06:00 UTC nightly validate-and-merge will pick it up, or merge by hand.
(memory: project_export_align_damage_1ch_num — guard now confirmed LIVE + firing in prod)

2026-06-20 · **suspicious-poitras (follow-up: code hardening)** — After healing the data, traced HOW JER 30:1
got de-aligned: the edit_log shows the de-align landed at v2→v3, an **editor save that did NOT change the
verse text** (v2 plain == v3 plain == `…another…Jeremiah…`), so it was NOT a text edit — `smartEditVerse`
replays of every transition on the CURRENT engine preserve alignment (0 collateral loss). It was an
**alignment-panel save** (`alignment_edit` intent), which `guardBlocksSave` exempts by design (re-aligning
legitimately removes/repoints sources). So the text engine has no bug to fix; the gap was that an accidental
unlink in the aligner saves **silently** and only surfaces when the export shrink-guard blocks it. **Fix
(preventive UI):** the aligner panel now WARNS (confirm dialog) before a save that would leave a
previously-aligned word bare. New pure `lostAlignedWords(before, after)` in `web/src/lib/alignmentDelta.ts`
(filters `reason==="lost"`, ignores `changed_source`); `AlignmentPanel.handleSave` defers the WHOLE commit
(onSave + optimistic `setInitial`) behind a new optional `onConfirmUnalign(lostWords, commit)` prop so
**Cancel keeps the panel dirty** (no save, re-editable) and **Save anyway** commits. Threaded through
`ResourceColumn` (`AlignmentTabProps`) + `SideBySideAligner` (`PanelSlot`) so it covers BOTH the single panel
and the dual aligner; Shell holds the `pendingAlignmentLoss` confirm (mirrors `pendingNav`/`pendingDualAction`).
Regression: `alignmentDelta.test.mjs` (lostAlignedWords: flags an unalign, 0 on no-op, 0 on re-point).
typecheck + full web suite + build green. **Browser-verified** (own isolated Playwright Chromium on :8799 against
the worktree bundle): Clear→Save shows the dialog naming the words ("…block the nightly export…"), Cancel keeps
dirty + fires 0 PATCHes, Save anyway PATCHes 200. Restored the test's local-DB mutation (ZEC 1:3 ULT) from the
seed. Branch `claude/suspicious-poitras-2a402b`, folded into PR #250.
**Codex review (`codex exec "review pr 250"`) caught a real high-sev interaction bug, now fixed:** the
deferred-commit broke the existing nav/close dirty gates — `resolvePendingNav`/`resolveDualAction` called
`panelRef.save()` then **immediately** ran the navigation, so with the unalign confirm open the nav fired
anyway (Cancel couldn't "keep editing"; in the dual aligner a second confirm could clobber the first pending
commit). Fix: `AlignmentPanelHandle.save(afterCommit?)` now returns committed-sync vs deferred and runs
`afterCommit` only once the save actually lands (never on cancel); the gates pass `nav.run` as `afterCommit`
(single panel) and **chain** the two dual panels so at most one confirm is open at a time; the confirm's
"Save anyway" clears state BEFORE running commit so a chained confirm isn't clobbered. Browser-verified the
gate path: Clear→switch tab→"Save"→unalign confirm→Cancel keeps the panel + fires 0 PATCHes; "Save anyway"
PATCHes 200. typecheck + web suite + build green.
2026-06-20 · **epic-bassi** — **DCS export validation: prevent · auto-fix · flag.** The open
nightly `-be-` PRs were all `mergeable:true` but blocked by ONE failing `validate-be` check.
Two root facts: (1) DCS validates the **whole repo** on a `-be-` branch (no `--book`), so a clean
book's PR fails on *other* books' pre-existing master cruft; (2) `merge-be-prs.yaml` skips any PR
whose status isn't `success`. Both confirmed against live door43. Plan + categorization of all 8
USFM + 15 TN checks → `docs/export-validation-cleanup.md`. **Shipped (branch
`claude/epic-bassi-b25819`, code NOT yet committed/deployed at time of writing — see below):**
- **Lever 0 (for Rich):** `docs/dcs-workflows/` — ready-to-paste `validate-be-branch.yaml` for all
  5 repos that scopes validation to the PR's book (`--book` from the branch name; validators
  already support it). Greens a book whose own render is clean. **Rich must apply these** (still
  `whole-repo` on master as of this run — verified).
- **Lever 1 (source prevention):** `api/src/usfmFormat.ts` — line-reflow ported+extended from DCS's
  `fix_usfm_formatting.py` (blank lines, own-line markers, `\b`/`\ts\*`/`\p` order, lift markers off
  the `\v` line, split mid-line `\v`, repair malformed `\ts*`→`\ts\*`), run in `buildUsfm`.
  `api/src/tsvFormat.ts` — trailing-`\n` trim, straight→curly quotes, Alternate-translation label
  spelling/case/spacing, DCS reference-order sort, wired into `buildTn/Tq/TwlTsv`. **Inert markers
  only — alignment counts identical, idempotent.** Verified with the REAL DCS validators: every
  open-PR USFM book + the master-cruft books (NUM/EZK/ZEC/MIC) → **0 Check-8 errors**; tn HOS/NUM →
  0; tn ISA → only the 7 genuine human-decision items. 33 unit tests (`usfmFormat.test.mjs` +
  `tsvFormat.test.mjs`).
- **Lever 2 (escalate):** `api/src/lint.ts` (TS port of the judgement-call checks) + a best-effort
  `escalateIntegrityIssues` post-export step in `exportWorkflow.ts` → admin banner for `\f/\f*`
  footnote imbalance (the un-auto-fixable integrity class). 14 unit tests (`lint.test.mjs`).
- **Lever 3 (flag for user):** `GET /api/books/:book/lint` (`bookImport.ts`) returns the per-book
  human-decision issues (brackets, labels, bad ref/rc://) with ref + rowId for jump-to. Verified it
  finds EXACTLY the 7 real ISA flag items. **Frontend (in-app per-book indicator + dropdown + jump)
  built by a sub-agent — integrate/verify before relying on it.**
- **True export DONE:** re-rendered all 11 open-PR books from **prod D1** with the new code and
  committed the clean renders onto the existing `-be-` branches via `scripts/reexport-be-prs.mjs`
  (`--commit`; reuses `commitToDcs` + the export shrink/alignment guards; dry-run validated each
  per-book first). Live branch files now validate **0 per-book**. Commits: 1CH/ISA/JER/MIC ult,
  1CH/HOS/ISA/MIC ust, ISA/HOS tn; MIC tn already clean.
- **⚠ ESCALATED (blocks persistence):** the checks stay **red** until Rich applies Lever 0
  (whole-repo gate). AND the **deployed prod worker still runs the OLD export code** — the **06:00
  UTC nightly will re-render these books WITHOUT the normalizer and re-dirty the `-be-` branches**,
  undoing the manual export. **Must deploy this branch (or merge its PR) before the next nightly.**
  After Lever 0 lands, the red checks need one re-trigger (a fresh push / re-run) to flip green.
  ISA tn has 7 residual flag items (5 unmatched `[ ]`, 2 labels missing end-punctuation) for human
  fix via the Lever-3 flag. (memory: project_dcs_be_validation_whole_repo)

2026-06-20 · **sharp-jackson** — Root-caused + fixed Perry's **MIC 7:9 UST** "BE moves a word from the
beginning of a line to the end of the previous line after save … no space between the word and the \q
marker." **Confirmed real** (fetched his exact saved verse from the `MIC-be-pjoakes` export branch — not a
prod query — and reproduced offline). Root cause: `stripMarkerTokens` (web/src/lib/replace.ts) replaced a
marker token + its trailing space with `""`, so a WORD directly before a marker with no space (`from\q2
Yahweh` — the textContent shape when a word milestone abuts the marker node, e.g. after dragging a poetic
line break) FUSED into `fromYahweh`. That undercounts words → every later marker's word-anchor lands a word
early (word jumps the line break) AND smartEditVerse's stripped diff drops to the non-preserving
localizedRewrite (alignment loss). Fix: bridge with a single space ONLY when a word char flanks BOTH sides
(punctuation-adjacent `says,\q2` stays `""` → zero churn; a blanket `" "` regressed Case 57 by churning
marker-adjacent spacing into the tree). Regression: **replace.test Case 67** (no-space edit must equal
with-space edit; fails on `preservedAlignment` without the fix). **Defense-in-depth** (the "auto-space after
markers" the user asked for): `sanitizeMarkerSpacing` (api/src/importParsers.ts, wired into
`extractVersesForRange` = the bootstrap/reimport/AI chokepoint) inserts a space after a NUMBERED marker
(`\q1`–`\q4`/`\qm1`–`\qm3`/`\pi1`–`\pi3`) glued to a letter, because usfm-js otherwise reads `\q2because` as a
garbage tag `{tag:"q2because"}`, swallowing the word + line break (proven in usfm-js, but NOT found in real
data; scoped to numbered markers so it can't split valid `\qa`/`\qm`/`\pi`). usfm-js's toUSFM already
auto-spaces on export, so export was never the vector. Web + api suites + typecheck all green. **Verified
end-to-end LIVE** (Chrome MCP, worktree dev vite:5174/wrangler:8787, ZEC 9:9 UST — 5 `\q1`, 25/40 aligned):
real save pipeline (contenteditable `because\q1 your` → smartEditVerse → outbox → PATCH → D1 → re-fetch) kept
all 5 markers + 25/40 alignment, no word jumped; restored the local dev verse after. Client engine + import
sanitizer; no API contract/migration change. Branch `claude/sharp-jackson-f10edf`, **PR #251**
(https://github.com/deferredreward/bible-editor/pull/251), rebased onto main. (memory:
project_stripmarkertokens_nospace_marker_fusion)

2026-06-19 · **sweet-moore** — Fixed Perry's **JER 29:31 UST** alignment-save block (PR #248). Repro'd on
`main` (NOT an outdated app): inserting "Because" mid-verse + changing the verse-final `.`→`,` flattened
37→17 aligned and the #233 guard discarded the draft. Root cause = a gap in the #235 reassembly engine:
`countChangeRegions` counts only WORD-token regions, so a word insert + a SEPARATED punctuation-only change
is ONE region → reassembly bailed to the legacy single-range diff, whose common suffix is killed by the
trailing-punct change, ballooning the range to the verse end → `localizedRewriteVerse` flattened every
milestone in between. Fix: `reassembleAlignment` GATE 2 now ALSO fires when the single-range char diff would
flatten an aligned SURVIVOR (`diffRangeCoversAlignedSurvivor` — computes the exact span localizedRewrite
would rewrite, checks if a surviving aligned word sits fully inside). Single contiguous edits still defer
(survivors stay in the common prefix/suffix), so in-word-split Cases 25/26/27/50 are unaffected. JER 29:31
→ 37/37 (only the new "Because" bare). Regression: replace.test Case 66 (real `en_ust` JER 29:31 fixture,
12 asserts). Full web suite (331 replace + 5 suites) + typecheck green. **Verified end-to-end through the
running worker**: a multi-region edit on ZEC 1:3 UST now PATCHes 200 (server guard accepts), only the
inserted word unaligns. Client-only engine change; no API/migration. Branch `claude/sweet-moore-86a875`,
**PR #248** open (rebased onto main). NB: this verse can't be browser-tested locally (JER not in the ZEC
seed) — the running-worker PATCH on ZEC is the integration proof. (memory: project_reassembly_separated_punct_gate_gap)

2026-06-19 · **great-jemison** — Built **ULT/UST verse version history** (mirrors note history). There was
no pre-existing admin versioning to "open up" — verses were audited to `edit_log` but had no endpoint/UI.
**(A)** New `GET /api/verses/:book/:ch/:v/:bv/history` (`requireEditor`, same gate as notes) backed by a
pure `api/src/verseHistory.ts` (`buildVerseHistory`, 19-assert test) — verse `edit_log` payloads are FULL
snapshots (no replay); anchors "current" with the live row content; an entry is `restorable` only if its
payload carries `content`. New lean `VerseHistoryDialog.tsx` (single-field text snapshot/diff) + a `v{N}`
**history chip** on the editable ULT/UST line in `ActiveLine` (ScriptureColumn) — **rows-mode only by
construction** (ActiveLine is used only in stacked mode; columns→DocColumn, book→BookView). Restore re-saves
the exact stored tree (alignment included) via the existing `enqueueVerseSafely` pipe with **`alignment_edit`**
intent (only intent that bypasses `guardBlocksSave`); version climbs normally, no `restored_from_version`
bookkeeping / no migration. Extracted the LCS word-diff into shared `web/src/lib/wordDiff.ts` (+test), reused
by both dialogs. **(B)** Per user ("the AI version is basically v1"): enriched AI-apply (`pipelineImport.ts`)
+ re-import (`bookReimport.ts`) `edit_log` payloads from `{plain_text}`→`{plain_text, content}` so the AI
base becomes restorable, and added a **guarded pre-AI baseline** insert at the AI transition (captures the
outgoing bootstrap content at `existing.version` iff that version was never logged) so "v0" is restorable too.
Caveat: only helps verses AI'd/re-imported AFTER this ships (already-overwritten pre-AI content is gone). **(C)**
Per user, also added the same history dialog to the **alignment panel** (history button in `ActionBar`, threaded
`onRestoreVersion` through AlignmentTabProps→ResourceColumn→AlignmentPanel→Shell.restoreVerse). Verified live
(Chrome MCP, local ZEC against worktree bundle on :8799): chip on ULT+UST, dialog list/snapshot/diff, restore
v8→v9 kept the alignment tree (17 zaln / 29 words, not flattened), chip updated optimistically, aligner-panel
history works, **no scripture chip in columns/book modes or on the UHB line**. typecheck + api+web tests + build
all green. **PR #245** (https://github.com/deferredreward/bible-editor/pull/245), rebased onto main. Review
follow-up landed: the batched reimport audit inserts (`bookReimport.ts`) were unconditional — with #245
logging full content, a phantom row from a missed write (UPDATE guarded on `updated_by IS NULL` losing a
race, or `ON CONFLICT DO NOTHING`) would become a **restorable** stale-DCS version, so both now guard with
`WHERE changes() > 0` (mirrors verses.ts). AI-apply left as-is (lock-protected + baseline insert sits between
its UPDATE and audit row, so a `changes()` guard there would read the wrong statement).

2026-06-19 · **relaxed-hoover** — HOS TN data cleanup in prod D1 (PR #7171 "HOS tn → master" was
`mergeable:false`). Diagnosed the blocked merge: it's NOT just duplicates — it's a 13-hunk 3-way
conflict from master being edited **out-of-band** (commit `8046caaab73e` "Heal AI-TN id/dup rot"
re-minted ids `4znz→za3b` etc.; #7167 "Adding Beth edits" + bp-assistant "TN: HOS 8/9/10" direct
commits) while the nightly export branch was never rebased. Three classes: (a) dup+id-rename
conflicts (5:13/7:1/7:4), (b) genuine parallel human edits on the same notes (front:intro, 7:10,
8:4–8:10, ch9 "Hosea" vs "the speaker/Yahweh"), (c) HOS 10 wholesale — master has the finished
Hebrew-aligned set, D1 still held the **old legacy English-quote notes** interleaved.
**Executed (prod D1, soft-delete + edit_log audit, `scripts/out/cleanup-hos-tn.sql`):** (1) deduped
6 redundant note copies — each pair = human row (`updated_by=35`) + untouched re-import (`by=null`,
v1); kept the occ=1 survivor, deleted idxe/c36i/bu7i/ywnu/wjmm/uguy. (2) Deleted 32 HOS 10 legacy
English-quote notes; **excluded `zgru` (10:5 "Beth Aven", tag=`keep`)** since master keeps the
equivalent. Verified: 0 dups remain, only `zgru` English-quote left in HOS 10. (3) Then deleted the 6 HOS 10
`# General Information:` empty-quote legacy notes (vux7/rxam/n8ww/hb3n/rn4r/rv3v,
`scripts/out/cleanup-hos10-geninfo.sql`) — user confirmed. HOS 10 now has only Hebrew-quote notes +
the new intro `nux1` + keep-tagged `zgru`. Editor ruled **"B (Bible Editor/D1) wins everywhere"** for the
ch8/ch9 wording. Resolved by building D1's authoritative HOS render (theirs.tsv-minus-44-deleted-rows,
validated byte-equal to current D1; the "15 diffs" were a ref-label artifact `10:0` vs `10:intro`),
saved `scripts/out/tn_HOS.reconciled.tsv`. **Did NOT use the export pipeline** — its pre-export
DCS→D1 sync would pull master's old ch8-9 wording back into D1 and clobber the editor's work. Instead
committed the reconciled file to a fresh branch off current master → **PR #7175**
(https://git.door43.org/unfoldingWord/en_tn/pulls/7175), mergeable, 1 file +38/-39. Verified safe: 0
master-only aligned HOS10 notes (nothing dropped); HOS10 converges to master (only `10:5` ete5→zgru
"Beth Aven" id swap + intro wording remain). **Handed to user:** they review the DCS validator on
#7175, then merge it and close/delete last night's #7171 + branch `HOS-be-deferredreward-bethoakes`
(I did NOT merge/delete per their instruction). Cleanup SQL: `scripts/out/cleanup-hos-tn.sql` +
`cleanup-hos10-geninfo.sql`. Editor-facing diff doc: `docs/hos-tn-divergence-for-editors.md`.

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

- **great-shamir** (2026-06-25) — **TWL generation into the app — ALL 4 PHASES DONE, [PR #267](https://github.com/deferredreward/bible-editor/pull/267) open.**
  Plan `C:\Users\benja\.claude\plans\immutable-snuggling-snowflake.md`. Commits: 38f36748 (0a/0b), bec5cf1d (1),
  3fbbffe0 (2), 662170ab (Codex fixes). Browser-verified; typecheck/api+web tests/build green; 2 Codex passes
  cleared. **AWAITING:** human review → merge → **prod deploy steps** (migration 0032 + import-tw.mjs → load
  import-tw.sql to prod D1; until seeded, suggestions are empty + catalog falls back to usage-derived links). Full
  detail in Last run + memory [[project_twl_generation_into_app]]. Dev env left set up: junctioned
  `api/.wrangler`→main, `.dev.vars` copied (both gitignored).

- **inspiring-faraday** (2026-06-23) — **Adapt 2 Kings 18-20 TN → Isaiah 36-39** (parallel-passage note
  migration; plan at `C:\Users\benja\.claude\plans\quirky-finding-meerkat.md`, approved; reviewed twice by
  `codex exec`). **Track A SHIPPED IN-BRANCH + verified locally:** new cleanup-chip "review flag" feature —
  migration `0031_tn_review_flag.sql` adds `review_kind`/`review_reason` to `tn_rows` (INTERNAL — `buildTnTsv`
  emits an explicit 7-col list so they never export; do NOT reuse `tags`, it's the exported Tags col, 652 ISA
  rows populated); `lintTnRows` (lint.ts) emits a `flag` issue (`check:"Adapted note — verify"`, ref =
  chapter:verse, message = review_reason) so flagged notes show in the existing "issues to clean up" chip;
  `rows.ts` PATCH clears `review_*` on save (incl. the no-op early-return = "verified, unchanged" still clears).
  Stored in edit_log was REJECTED by codex (AI-sweep tombstones it, 180-day retention drops it, no-op save
  won't clear, malformed JSON breaks /lint). API typecheck clean; 17 lint tests pass; 0031 applied to LOCAL
  dev D1 (columns confirmed). NOT yet committed/deployed (no PR per standing rule). **Track B spine DONE+validated:**
  `scripts/build-kings-isa-versemap.mjs` → `scripts/kings-isa-versemap.json`. Of 305 2KI notes: **236 migrate**
  (215 clean + 3 split @19:15 + 18 reorder), 43 drop (no parallel: 18:1-12, 18:14-16 tribute, 20:20-21), 23 skip
  (target Isa 37:1-9 already human-done — user said NEVER touch). Migrated land in 65 ISA verses (36:84/37:101/
  38:34/39:24). Hard zone = 2Ki 20:4-11 → Isa 38:4-8,21-22 (reorder/reword — every note auto-flagged).
  **NEXT (Track B remainder, gated on a dry-run review):** `scripts/migrate-parallel-notes.mjs` — token-span
  quote re-anchor (NFC/maqqef/`&`, exact-only, else flag); AI prose-adaptation pass via **Agent SDK subagents,
  Sonnet 4.6** (cross-ref remap in-range / flag out-of-range, gloss align), validated; emit review doc + flags +
  snapshot + load SQL; **dry-run for user**, then deploy Track A + apply 0031 to prod + load (insert
  `source='parallel_migration'`, NOT ai_pipeline, so a later AI run won't sweep unreviewed flags; delete side
  reuses `deleteUnkeptTns` predicate scoped to mapped verses, hard-excl 37:1-9 + 38:9-20). Branch
  `claude/inspiring-faraday-15ddeb`.

- **note-find-highlight** (2026-06-19, PR #246, based on #244 branch) — Highlight the active find match
  INSIDE a TN note (user follow-up to #244: matched word wasn't visible in the note column). Notes are an
  editable `<textarea>` (no inline `<mark>`). First cut = transparent highlight layer behind the textarea →
  misaligned vs MUI's box model + looked "pasted on top" (user rejected). Reworked per user suggestion
  ("change the display type until clicked in"): the active-match note renders a **read-view div** with the
  active occurrence in a real inline `<mark>` (orange `#fb923c`, pixel-accurate, scrolls naturally); clicking
  swaps to the editable textarea (focused), next/prev find nav reverts to read-view. Scope = "show where you
  are" (active occurrence only), NOT "show all" (only one note visible at a time). Query + active
  `{noteId, occurrence}` lifted overlay→ScriptureColumn→Shell→ResourceColumn, passed ONLY to the active note
  (no per-keystroke re-render of all cards). `NoteMatch` gained per-note `occurrence` index. Save semantics
  unchanged. Files: FindReplaceOverlay/ScriptureColumn/Shell/ResourceColumn/NoteCard. typecheck+build green;
  verified live in Chrome (aligned highlight, next/prev moves it, click→editable textarea). Retarget PR to
  main once #244 merges.

- **focused-albattani** (2026-06-19) — Find/replace now works on TN note bodies, not just ULT/UST.
  The TN scope was already searchable; this adds **replace** for it. Design (user-directed): replace
  acts on exactly **one** scope — with both Bible + TN checked, replace/replace-all/the replace input
  disable and show "select a single scope to replace" (find still spans both). TN replace rewrites the
  **note body only** — `id` (PK) and `support_reference` (rc:// link) are never touched; a note that
  matched only via id/SR is skipped + counted. Safeties: reject tab/newline in the replacement (TSV
  column/row separators; notes store line breaks as the literal `\n` escape), skip any replace that would
  blank a note, replace-all behind a confirm dialog with a pre-counted blast radius, reuse outbox
  `enqueueRow` (If-Match on row.version → 409 merge handling). UI prominence reordered per request:
  find/next (filled-primary ▲▼) > replace (outlined) > replace-all (quiet underlined warning text).
  **Per-instance (not per-note):** note BODY matches are emitted ONE PER OCCURRENCE (NoteMatch carries
  start/end), so the "X/Y" count = occurrences and single `replace` rewrites just the active instance
  (verified: "return"×4 in one note → 1/4 count; one replace → 1/3, server 4→3 "return"; replace-all →
  0, summary "replaced 3 matches"). support_reference/id stay search-only single fallbacks (emitted only
  when the body doesn't match). Confirm dialog reads "Replace N matches across M notes".
  Key gotcha (see memory): `ScriptureColumn` is memoized and ignores note edits, so in stacked/columns
  mode a note replace doesn't re-render the overlay and `searchNotes()` reads an effect-lagged ref — the
  result list would go stale. Fixed with a short-lived in-overlay `noteOverrides` map so noteMatches
  recompute immediately (book mode already refreshes via the `bookChapters` ref change). Files:
  `FindReplaceOverlay.tsx` (core), `ScriptureColumn.tsx` + `Shell.tsx` (thread `onReplaceNote`). typecheck +
  web tests + build green; verified live in Chrome (single replace persisted v4→v5 with id/SR intact;
  both-scopes gating; confirm dialog "Replace 7 notes"; replace-all → 7 rewritten server-side, no
  double-write of the already-replaced note; tab block disables replace). Branch
  `claude/focused-albattani-c5bb6f`. Not yet PR'd.

- **great-jemison** (2026-06-19) — ULT/UST verse version history + alignment-panel history + AI/import
  content logging (see Last run). **PR #245 open**, rebased onto main, review follow-up pushed (conditional
  reimport audit). typecheck/tests/build green + live-verified. Awaiting review/merge.
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
