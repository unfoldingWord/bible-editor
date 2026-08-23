# Sync attribution handoff (#540, #537)

Written 2026-08-19, after PRs #542 and #543. Read this before picking up any
remaining item of #540 or #537 — several of those issues' stated premises turned
out to be wrong when measured, and the remaining plan is built on the
measurements, not on the issue text.

Line numbers drift; symbol names are the stable references. Everything below was
measured against production D1 or the live Door43 API on 2026-08-19 unless it
says otherwise.

---

## 1. What landed, and what it did not

| PR | Issue | What it actually changed |
|---|---|---|
| #542 | #537 (part) | The nightly banner now NAMES the verses the merge could not adjudicate, and claims only what `base === null` measures. **No merge behavior changed.** |
| #543 | #540 item 3 | A tn/tq/twl reference difference is attributed from an ancestor instead of blamed on Door43. Only the **pure app-side move** changes behavior (no flag, no hold); every other shape still holds exactly as before. |
| #548 | #540 items 1 + 2 | **This PR.** The merge now asks WHO moved master — a commit-lineage walk per (book, resource) per run — and resolves a both-changed conflict **D1-wins plus a review flag** (`keep_ai_master`) when no human commit is behind master's side. Master-wins is untouched for a maintainer edit, for an incomplete walk, and for a run that never looked. |

The engine that was sitting unconsumed on `feat/master-commit-lineage`
(`api/src/masterLineage.ts` + `listMasterCommitsSince` in `api/src/dcsSources.ts`)
is folded into this PR and has a consumer now; that branch is finished work, not
pending work.

Filed while doing this work: **#544** (keep_no_base invisible to editors, and
entirely invisible for tn/tq/twl), **#545** (cross-book ancestor pollution on the
*content* fold), **#546** (audit rows recording writes that never happened),
**#547** (three attribution limits needing a design decision).

---

## 2. Measurements that changed the plan

Do not re-derive these from the issue text — the issue text is where several of
them were wrong.

### #537's stated mechanism does not exist

```
edit_log: 359,233 rows | oldest 2026-05-18 | newest 2026-08-19  → 93 days
```

The 180-day sweep in `index.ts` **has never deleted a row.** "Their edit history
has aged out" explained none of the 190 verses then in that state.

### 186 of those 190 verses already have a recoverable ancestor

`api/src/pipelineImport.ts` writes an `action='baseline'` edit_log row holding the
**pre-AI content**, with `created_at` deliberately back-dated to that content's own
timestamp. The verse merge never sees it, for two independent reasons:

1. the ancestor sub-select in `applyVerseRows` filters `action IN ('create','update')`;
2. the boundary is `id <= master_confirmed_edit_id`, and a back-dated row's **id is
   not chronological with its content** — all 186 fail the id test, all 186 pass
   the `created_at` test.

Corpus inventory (verses with edits + a watermark + no recoverable ancestor):

| book | res | count | has a `baseline` row | baseline `created_at` < watermark |
|---|---|---|---|---|
| EZK | ust | 59 | 59 | 59 |
| EZK | ult | 57 | 57 | 57 |
| JER | ult | 36 | 36 | 36 |
| JER | ust | 34 | 34 | 34 |
| ECC | ult | 3 | 0 | 0 |
| ZEC | ult | 1 | 0 | 0 |
| | **190** | **186** | **186** |

ECC×3 and ZEC×1 have no ancestor at all and stay `keep_no_base`, correctly.

### Door43's commits API ignores `limit`

Measured on git.door43.org: `?limit=2` on a 15-commit file returns all 15;
`?limit=100` on a 143-commit file returns 50. **Page size is fixed at 50**, `page`
works, and the response carries `X-PageCount`, `X-Total`, `X-HasMore`. Any
end-of-history test based on "the page came back shorter than I asked for" is
reading a number the server discarded. `fileCommitSha` has passed `limit=1`
forever and never noticed, because it reads `commits[0]`.

### The three commit producers are distinguishable, with two traps

| kind | signal |
|---|---|
| ours | subject starts `bible-editor: {BOOK} {res} → master (#N)` **or** `bible-editor export: … → {BRANCH} (export-…)` — the `-be-` branch commit also appears in master's file history once merged |
| ai | author email `bot@unfoldingword.org`, and/or `@api.bp-assistant` in the subject |
| human | everything else |

Traps, both real commits on master:

- `Revert "bible-editor: EZK ult → master (#6711)" (#6716)` — a **human** decision.
  A substring test for the prefix files it as ours and drops it from the lineage.
  The prefix must be anchored at the start of the subject.
- `ULT: EZK 38 [pjoakes]` — bot author, plain username in the bracket. The bot
  pushes on a human's behalf; the content is still machine-written, so the
  **author** decides, not the bracket.
- `login` is null on plenty of commits, human ones included. Never key on it.

### Fleet state for the remaining items

```
book_resource_syncs: 185 pairs
  own_publish_declines > 0 ......... 51   (worst: 5 consecutive)
  master_confirmed_at IS NULL ....... 0
  master_confirmed_edit_id IS NULL .. 0
  pushed_edit_id > master_confirmed_edit_id .. 16
edit_log rows with book IS NULL (tn/tq/twl) .. 7,689
live rows carrying restored_from_version ..... 17  (tn 7, tq 10, twl 0)
edit_log entries carrying restored_from_version .. 52
```

Two of those deserve attention before the work starts:

- **#450's premise no longer holds.** It says 51 book/resource pairs have a NULL
  `master_confirmed_at` and therefore a disabled merge. That count is now **0**.
  Re-measure before working it; the issue may be closeable.
- **16 pairs have a watermark behind their own last push.** That is the
  own-publish signature item 4 targets, and it is a sharper metric than the
  decline counter because it does not reset.

---

## 3. The work, in dependency order

### A. #540 items 1 + 2 — make the merge ask who moved master  ← the keystone — **LANDED IN THIS PR**

Everything else in #540 depended on this, and so does #537's real fix. What
shipped, since the shape below is what B, C and D build on:

**Item 1, the wiring.** `loadMasterLineage` (`api/src/bookReimport.ts`) walks the
file's master commits, classifies each, and compacts the result to a
`MasterLineageSummary` that rides on `MergeCutoff` into both merge call sites —
so no call site can receive an ancestor without the attribution that belongs with
it. It is fetched in `planAndStageBookResources` on the nightly path (the only
place there that talks to DCS per pair, and it already holds master's sha) and in
`runReimport`'s own-publish loop on the user path. Cost: one walk per
(book, resource) per run, only when master's sha moved AND own-publish
recognition declined — a quiet or self-published resource costs nothing. It rides
the plan's `step.do` result into every chunk step rather than being re-fetched
per chunk.

**Item 2, the policy.** Benjamin's ruling: *AI-pipeline-authored master content
must never beat a later human app edit.* Both merges gained a `keep_ai_master`
outcome: when the lineage holds no human commit, a both-changed conflict resolves
D1-wins plus a review flag instead of master-wins. Master-wins stays for a
genuine maintainer edit. This closes the AMO 4:2 shape — Beth's hand fix reverted
to the text of her own AI run.

Three properties to preserve when touching this:

- **Always `masterMayHoldHumanEdit(lineage)`, never `lineage.hasHumanCommit`.**
  An **incomplete** walk (fetch failed, page cap, sha not in history) is *not*
  "no human found", and reading the boolean alone says exactly that. The helper
  answers `true` for null, for `undefined`, and for incomplete.
- **The flip rides on an explicit `false` and nothing else.** Omitted, `true`,
  and `undefined` all keep master-wins, so a caller that forgets to thread the
  lineage degrades to today's behavior rather than to an overwrite.
- **`keep_ai_master` must never hold the watermark, and must never join
  `merge_refused`.** The export is how the protected human edit reaches Door43;
  withholding it would strand the edit, which is the livelock #543 killed on the
  TSV side, and `merge_refused` freezes a resource's export at five.

*Verified:* pure decisions in the three unit suites; both callers end-to-end
against real SQLite with the production migrations (`reimportJourney`,
`applyVerseRows`); the four SQL action lists in `verseMergeConflicts`. Every guard
ablated and the failures counted. Live Door43 walk: `en_ult/26-EZK.usfm` six
commits back is 3 ours + 3 ai + 0 human (the policy fires there), `en_tq/tq_AMO.tsv`
finds a real human commit and protects master, and an unknown sha comes back
`incomplete` / `source_sha_not_in_history`.

*Not done here:* the classification is threaded through the run and logged, but
not persisted to a table. #540 item 1 asked for persistence so a later forensic
question can be answered without re-walking; the alerts this run raises can cite
it because it is in scope for the run that raises them. Worth a follow-up if
after-the-fact attribution is ever needed.

### B. #537 — recover the 186 ancestors — **LANDED** (#574, #583)

Both changes went into `applyVerseRows`'s `mergeCols` sub-select
(`api/src/bookReimport.ts`, `base_payload` ~lines 3217–3228):

1. `action = 'baseline'` is now included alongside `create`/`update`.
2. Baseline rows are bounded on `created_at < master_confirmed_at` specifically
   (never the id boundary, which is not chronological with a back-dated row's
   content) — the combined candidate set orders by `created_at DESC, id DESC`
   so a baseline row can compete honestly against ordinary `create`/`update`
   rows for "most recent ancestor at/before the watermark". The companion
   `human_edit_after_export` probe (~lines 3229–3248) explicitly excludes
   `action = 'baseline'`, so a recovered ancestor's own row can't false-positive
   as a post-export human edit.

This was sequenced after A specifically because recovering these ancestors makes
the merge start *adopting master* on verses where it previously kept D1, and all
186 are in JER/EZK — exactly where bp-assistant pushes land. Item 2's
`keep_ai_master` guard was required to be in place first, and it is: the live
walk on `en_ult/26-EZK.usfm` shows six commits back is 3 ours + 3 ai + 0 human,
so a both-changed conflict in EZK resolves D1-wins, not an AI-authored overwrite.

The retention-sweep half (keeping a book's recovered ancestor row alive past the
180-day `edit_log` sweep) landed separately in #574 — see
`api/src/editLogSweep.ts`'s header and `editLogSweep.test.mjs`.

*Verified:* `api/src/applyVerseRows.test.mjs` (~lines 334–446) — positive
baseline-recovery case, plus a companion case proving a genuine human edit after
export still blocks clean-adopt even with a recovered baseline ancestor.
Corpus inventory measured 2026-08-19: 186 of the 190 then-unadjudicable verses
(EZK ust 59, EZK ult 57, JER ult 36, JER ust 34) had a `baseline` row earlier
than their book's watermark and became adjudicable; ECC×3 and ZEC×1 have no
ancestor at all and correctly stay `keep_no_base`.

**Not done here** — still open, tracked in #573: `human_edit_after_export` and
`latest_source` (`api/src/bookReimport.ts`) each read edit_log rows the #574
sweep shield does not exempt, so a book whose watermark boundary stalls past
180 days can still lose those signals to the sweep even though the ancestor
itself is now safe. Also open: whether `restore`, `restore_master_verse` and the
`normalize-*` / `heal-*` actions should count as ancestors; prod holds 238
`restore_master_verse`, 115 `normalize-source-occurrences`, 94
`normalize-align-order`, 69 `heal-replacement-chars`, 12
`heal-export-align-loss`, 11 `restore`, 4 `remove-doubled-q1`. Each needs its
payload shape checked before inclusion — the sub-select takes the **newest** row
and reads its payload as "the content D1 held then", so an action whose payload
is not a full post-state snapshot must not be included.

### C. #540 item 4 — own-publish resilience

`api/src/ownPublish.ts` recognizes "master moved because our own export merged"
by whole-file blob equality against the bytes we last pushed. That fails whenever
an evening AI push lands after our merge — the file no longer equals our render,
recognition declines, the watermark freezes, and every later merge reads a stale
ancestor. Measured: **51 of 185** pairs have declined at least once; **16** carry a
watermark behind their own last push.

Direction: combine with the lineage from A. If every commit since `pushed_read_at`
classifies as ours-or-AI-mirrored, advance `master_confirmed`. Alternatively
recognize per row rather than per file. Note `ownPublish.ts`'s header argues
against trusting commit metadata — that argument was written before a verified
classifier existed, and item 1's classifier is fail-safe toward `human`, so
recognition can only ever *decline* more often than bytes alone, never less.
Preserve that property.

### D. #540 item 5 — alerts state only measured causes

Mostly a sweep once A exists: `"A Door43 edit…"` / `"A Door43 editor moved…"` may
only be emitted when the lineage actually **found a human commit**. Sites:
`buildMergeConflictGuidance` (`api/src/verseMergeEditorAlerts.ts`), the per-row
reasons in `applyTsvRows` (`flagRefMoved` — #543 already split these by measured
cause; they will want the lineage evidence added), the `lint.ts` fallback strings,
and `raiseOwnPublishInertAlert`, which currently names two causes it did not
measure and says so.

### E. #540 item 6 / #539 items 3–4 — restore-marker lifecycle

Independent of everything above; can be done at any time by anyone.

- `buildTsvEditedWriteStmt`'s `TSV_MERGE_WRITE_COLS` omits `restored_from_version`,
  so a sync-side adoption never clears the marker the way a human PATCH does
  (`api/src/rows.ts` clears it on any normal PATCH). Clear it only when the write
  actually changes content — a flag-only write leaves the row's content alone, so
  the marker is still true.
- `web/src/components/RowHistoryDialog.tsx` filters out **every** entry with
  `restored_from_version` set, in two places (the default-selection filter and
  `ordered`). That is what hid Beth's v7. **52** edit_log entries are currently
  invisible this way.
- The `(restored)` chip should show only while the version actually matches.

Mind #539's constraint throughout: a flag write bumps the row version, so set it
once and guard on the existing value.

---

## 4. Traps this work hit

Read these before writing code in this area.

**A two-way compare cannot say who moved.** It is the root of both #540 and the
1CH incident. Any new comparison must reach for an ancestor or a lineage signal,
never a preference.

**There are TWO watermarks and they are not interchangeable.** `source_sha`
advances at the end of any successful reimport (`recordResourceSync`);
`master_confirmed_at` advances only on a positive measurement that master holds
our render (`markOwnPublishConverged`, or `exportWorkflow`'s `confirmMaster`
gate). So `source_sha` is routinely NEWER than the merge's content ancestor. Any
question of the form "what happened to master since the ancestor" must be bounded
by `master_confirmed_at` — a human commit in the gap, reported as "no human
found", is the one answer that unblocks an overwrite. This is the defect the
first version of the lineage wiring shipped with; both cold reviews found it
independently. Same asymmetry as the fold rule below: reading too FAR back is
harmless (an extra commit can only add a protective `human`), stopping too early
is the failure.

**A new outcome needs a new `review_kind`, not just new prose.** The cleanup chip
titles itself from that column, and it was hardcoded per kind — so a row whose
edit was KEPT displayed "Merged Door43 edit", the reverse of what happened, above
a message saying the opposite. The chip also clamps the message to two lines, so
whatever a message leads with is, for many readers, the whole message: lead with
the outcome and the remedy, not the evidence.

**Absent and wrong are not the same failure.** In every fold here, a *missing*
component withholds (safe) while a *present but wrong* one can unblock an
overwrite (unsafe). `Number(null)`, `Number("")`, `Number(false)` and `Number([])`
are all a finite `0`, and 0 is a real reference (`front:intro` rows). An explicit
`null` in a payload is absent, not `""`.

**Writers that log less than they wrote.** `pipelineImport.ts`'s tq apply wrote
`verse` and omitted it from the audit payload (fixed in #543); the tn hint
expansion still logs `chapter`/`verse` its UPDATE never writes (#546). Any fold
over `edit_log` inherits these.

**Two spellings of the same column.** `bookReimport.ts` logs a `ParsedTsvRow`
verbatim, so its payloads carry camelCase `refRaw`; `bookImport.ts` and `rows.ts`
write snake_case `ref_raw`. `readPayloadField` exists for exactly this and any new
fold needs the same treatment.

**Prove the test fails without the fix.** Two assertions written during this work
looked right and were vacuous — an integration scenario that used the same value
in both `ref_raw` spellings passed with the fix removed. Ablate every new guard
and count the failures. The same applies to `tsc`: plant a deliberate type error
once to confirm the file is actually in the program.

**Run it against the real thing.** Thirty passing unit tests hid the fact that
Gitea ignores `limit`. A mocked contract proves only that the mock matches itself.

**Tooling.** The Bash tool mangles `\n` inside heredocs, and backticks inside a
double-quoted `git commit -m` are shell-substituted (one commit message here lost
a word that way). Use the Edit tool for test-file edits. Commit per branch before
switching — a `git add -A` on the wrong branch swept unrelated work into #542.

---

## 5. How to verify work in this area

None of this has a UI to click; the browser is the wrong tool. What works:

- `api/src/tsvMergeIntegration.test.mjs` and `api/src/reimportJourney.test.mjs`
  run the **real** functions and the **real** SQL against `node:sqlite` with the
  production migrations applied. New merge behavior belongs there, not only in a
  pure test.
- Prod D1 is readable read-only:
  `npx wrangler d1 execute bible_editor --remote --env production --command "…"`
  from `api/`. Keep queries index-friendly; a self-join over `edit_log` exceeds
  D1's CPU limit.
- `api/src/applyVerseRows.test.mjs` is the same harness for the VERSE side —
  real `applyVerseRows`, real migrations, real `verse_merge_conflicts` rows. A
  merge decision that only has a pure test has not been shown to reach storage.
- Prod D1 is readable read-only:
  `npx wrangler d1 execute bible_editor --remote --env production --command "…"`
  from `api/`. Keep queries index-friendly; a self-join over `edit_log` exceeds
  D1's CPU limit. Note this needs an authorized wrangler login — it fails with
  `code: 7403` from a worktree whose CLI is not authenticated, so a claim that
  rests on a prod count needs the login first, not a guess.
- The Door43 API is readable unauthenticated for these public repos, which is how
  the commit shapes above were verified. A scratch script that imports the real
  module and hits the live API caught a bug the whole unit suite missed. For the
  lineage specifically: call `listMasterCommitsSince(env, repo, path, null,
  { sinceTime })` with a watermark N days back and print each commit's `kind`.
  Measured 2026-08-19 — `en_ult/26-EZK.usfm` over 3 days is 2 ours + 2 ai + 0
  human, `en_tq/tq_AMO.tsv` over 30 days is 6 ours + 5 ai + 1 human.
- **Ablate every guard and count the failures.** Two assertions written during
  this work looked right and were vacuous. Ablation is also what proves a review
  finding was real: each fix here was re-broken and the failure count recorded in
  the commit message.
