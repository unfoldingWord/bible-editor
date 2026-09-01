# Project state · bible-editor

> The agent forgets; this file does not. Read it at the start of a session.
> It holds what this project **is** — the gotchas, the durable lessons, and what's
> blocked on a human — none of which is derivable from the code.
>
> **This file is not a session log, and a session log must never be added back.**
> "What I just did" goes in the commit message and the PR description: those are
> per-branch, written once, and cannot collide. A shared status section is written
> by every parallel worktree at the same anchor line, so git gets N blocks claiming
> one position and conflicts every time. That is exactly what happened here — the
> old `## Last run` grew to 1,035 of 1,261 lines and 12 of the last 20 commits to
> this file landed on the identical hunk.
>
> - **Never commit a `STATE.md`-only change to main.** A code-free commit to a shared
>   file makes every open branch stale. A note *about* a PR belongs in that PR.
> - **In-flight status → `.claude/state/<worktree-name>.md`**, one file per worktree,
>   deleted when its PR merges. Separate files never collide.
> - A conflict that *does* happen here is now meaningful: two sessions learned
>   contradictory things, and that is worth stopping for.
>
> Pair it with the standing spec: [`CLAUDE.md`](CLAUDE.md) (how to work here) and
> [`docs/plan.md`](docs/plan.md) / [`docs/handoff.md`](docs/handoff.md) (where the project is going).

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
- **`JER 36:11` ULT needs a manual re-align** — the word "the" is bare in D1 but aligned to `הַ⁠סֵּֽפֶר`
  ("the book") on master, so the alignment backstop has blocked JER ULT's export since 2026-07-31.
  Not a code bug: on 2026-07-30 a human cleared the verse in the aligner panel and rebuilt it word-by-word
  in ~100s (un-fusing master's 6-word compound card) and left the article off that card. Word sequence is
  identical both sides, so index 16 is unambiguous. Fix = drag "the" onto the `הַ⁠סֵּֽפֶר` card, then re-export.
- **Two rows carry a blank Occurrence that DCS hard-rejects** — each silently blocks its whole book+resource,
  because the Occurrence checks in `validate_{twl,tn}_files.py` pass no `severity` kwarg and so default to
  `"error"`, failing the run that `merge-be-pr.yaml` gates the `-be-` merge on. Fix both by setting
  **Occurrence = 1 in the editor** (preferred over prod SQL):
  - twl `DAN 3:5` id `xf8f` — OrigWords "fall down", Occurrence NULL. Its OrigWords is Gateway-Language
    rather than Hebrew, which is worth a look but is only a validator *warning* and does not block the merge.
  - tn `JER 37:5` id `bfyt` — quote "the Chaldeans, the ones laying siege", Occurrence NULL.
  A corpus scan on 2026-08-03 found no others: `xf8f` is the only twl row with a blank/zero Occurrence, and of
  nine tn rows with a quote and no Occurrence the other eight have Hebrew quotes that `origLangOccurrence`
  already renders as 1. The create/patch paths can no longer mint such rows (PR #403), but that fix is
  insert-time only and does not remediate these two.
- **15 prod VERSE rows carry straight quotes that reached master** — JER 32/33 and NUM 26:53, ULT and UST,
  written by the AI pipeline in June-July 2026 (root-caused via prod forensics 2026-08-14: `pipelineImport.ts`
  had no quote normalization on the verse-ingest path, unlike the client keystroke interceptor
  (`web/src/lib/curlyQuotes.ts`) and the tn/tq TSV export (`tsvFormat.ts` `educateQuotes`)). The gap is closed
  going forward (`curlifyVerseObjects` in `importParsers.ts`, wired into `applyVerseUpdate`), but the fix is
  insert-time only, same shape as the Occurrence rows above — these 15 already-written rows still need a
  one-time repair (re-run `curlifyVerseObjects` over them + bump version + `edit_log` row, the prod
  verse-data-repair pattern) before the next export re-ships the straight quotes to Door43. Not yet located
  by book+chapter+verse+bible_version — that inventory is the first step of the repair.

## Lessons learned (write durable, cross-session facts here — not in chat)

For the full corpus, see the memory index at
`C:\Users\benja\.claude\projects\C--Users-benja-Documents-GitHub-bible-editor\memory\MEMORY.md`.
Highlights that bite repeatedly:

- **A TSV row's `updated_at` is NOT the time its review flag was minted, and keying any flag-age decision on it is
  unsafe in the one direction that matters.** The mint IS guarded on `cur.review_kind == null`, so the flag is
  written once — but rows.ts's non-versioning fast paths (reorder drag `rows.ts:815`, preserve/hint toggles
  `:1244`, trash toggles `:1317`/`:1338`) move `updated_at` and deliberately leave `review_kind` standing. So
  `updated_at >= mint`, never `==`, and a walk window starting there can start *after* the Door43 human commit the
  flag is about — reporting "no human found" over a range that never contained it, which is the one answer that
  retires a true warning. Immutable mint evidence exists in two places instead: `review_master_json._meta.flag_at`
  / `flag_since` for post-#653 flags, and the mint's own `edit_log` row (`action='update'`, payload carries
  `"review_kind":"merge_no_base"`, `logEditStmt` at `bookReimport.ts:2668`) for older ones. Note that edit_log is
  *not* forever: `editLogSweep.ts` deletes `update` rows past 180 days (only the newest `create` per live row is
  exempt), so mint evidence expires. #683 (`sweepStaleMergeNoBase`) derives a pre-#653 flag's window from the mint
  run's persisted lineage, admitted only when `master_lineage_computed_at <= mintAt` proves that lineage is the
  mint's own and not a later overwrite.
- **A column added by a migration is NULL for exactly the rows a backlog-draining fix cares about, because those
  rows are stuck precisely for want of a later run to fill it.** #683's first cut derived its window from
  `book_resource_syncs.master_lineage_confirmed_at` (migration 0058, deployed 2026-08-31). Measured read-only in
  prod on 2026-09-01: NULL for all three stuck pairs (AMO tn, AMO tq, ECC tq) — the column only fills on a run
  after that deploy, and "no run has visited this pair since" is the *definition* of the backlog. The fix needed a
  second evidence tier over a column that predated the flags (`master_lineage_computed_at`, 0054). Before relying
  on a recently-added column to heal historical rows, check whether those rows can ever have it.
- **A per-book nightly step can only heal books the nightly visits, so any self-healing wired inside the sync
  reaches exactly the books that did not need healing.** #665's merge_no_base auto-clear sat inside
  `loadMasterLineage`, which runs only when a resource's master file moved; 12 flags on AMO and ECC therefore
  survived it because those books had gone quiet. Fixed by a once-per-run sweep driven by "which rows still hold a
  flag" rather than "which books did we sync" — the shape to reuse for any future row-state cleanup.

- **Marker chips are TEXT, and `smartEditVerse` rebuilds the verse's whole marker layout from the captured text
  alone — so a capture that loses the chips silently deletes every `\q` in the verse.** `reconcileMarkers`
  (`web/src/lib/replace.ts`) unconditionally drops every inert in-flow marker and re-inserts only the ones it
  finds in `newPlain`. When the chips are missing, every word still round-trips, so alignment survives intact and
  `preservedAlignment` stays **true** — neither the collateral-loss guard nor the unaligned-words toast fires —
  and the nightly export carries the loss to master. That is #606: HOS ULT 11:9/11/12 lost all 11 of their `\q`
  markers on 2026-08-11 and it sat live on Door43 for a fortnight. Reproduced exactly by replaying the real edit
  (delete a curly quote) against the pre-damage trees parsed from export `ce54ec0d76` with the production
  importer: chips present → 11 markers kept, chips dropped → 0. The engine now guards it
  (`markerCaptureLooksDropped`), but the guard only covers an edit where **no word changed**; the upstream
  capture bug is #642 (the Find overlay repaints the editable cell from marker-free `plain_text` while it stays
  `contentEditable`, and closing Find does not restore the chips once a draft exists). **Lesson for any future
  marker-loss report: check whether the captured text still had its chips before suspecting the diff tiers.**

- **`edit_log` has never aged anything out, and "the history aged out" is the wrong diagnosis for a missing
  ancestor.** Measured 2026-08-19: the table spans **93 days** (oldest row 2026-05-18), so the 180-day sweep in
  `index.ts` has deleted nothing, ever. It explained none of the 190 then-unadjudicable verses. The real reason a
  verse merge finds `base === null` is that **nothing was written to `edit_log` for it before the book's
  `master_confirmed_at`** — and for 186 of those 190 an ancestor *did* exist and was simply invisible:
  `pipelineImport.ts` writes an `action='baseline'` row holding the pre-AI content with `created_at` back-dated
  to that content's own timestamp, while the ancestor sub-select filters `action IN ('create','update')` AND
  bounds on `id <= master_confirmed_edit_id` — and a back-dated row's **id is not chronological with its
  content**, so all 186 fail the id test and all 186 pass the timestamp test. Any fold over `edit_log` must decide
  deliberately which `action` values it accepts (prod also holds `restore_master_verse`, `normalize-*`, `heal-*`,
  `remove-doubled-q1`) and whether each payload is a full post-state snapshot. See `docs/sync-attribution-handoff.md`.

- **Door43's Gitea IGNORES `limit` on the commits endpoint and pages at a fixed 50.** `?limit=2` on a 15-commit
  file returns all 15; `?limit=100` on a 143-commit file returns 50. `page` works, and the response carries
  `X-PageCount` / `X-Total` / `X-HasMore`. So **never infer end-of-history from "the page came back shorter than
  I asked for"** — that reads a number the server discarded, and with a requested size above 50 it calls page 1
  the end of history every time. `fileCommitSha` has passed `limit=1` since forever and never noticed, because it
  reads `commits[0]`. Thirty passing unit tests hid this; only running against the live API found it. Corollary:
  a mocked contract proves the mock matches itself.

- **Gitea's raw endpoint silently serves master's CURRENT tip for an ABBREVIATED sha.** Measured 2026-08-24:
  `/api/v1/repos/unfoldingWord/en_ult/raw/24-JER.usfm?ref=127cc1f3` returned bytes identical to master's tip
  (same md5 for two different commits), while the same call with the full 40-char sha returned the two real,
  different revisions. It does not error and does not warn — it hands back the wrong file. Anything pinning a
  fetch to a revision must pass the FULL object id and reject anything shorter (`fetchHumanTouchedRefs` in
  `dcsSources.ts` does), and keep a second net: `refsTouchedInUsfm`'s hunk-past-end-of-file check exists because
  real hunk line numbers against the wrong bytes usually run off the end.

- **Master's three commit producers are distinguishable, and two shapes are traps.** Ours:
  `bible-editor: {BOOK} {res} → master (#N)` AND `bible-editor export: … → {BRANCH} (export-…)` — the `-be-`
  branch commit also appears in master's file history once the branch merges. AI: author `bot@unfoldingword.org`,
  usually `@api.bp-assistant` in the subject. Human: everything else. Trap 1: `Revert "bible-editor: EZK ult →
  master (#6711)" (#6716)` is a real **human** commit, so the prefix must be anchored at the start of the subject,
  never a substring test. Trap 2: `ULT: EZK 38 [pjoakes]` is bot-authored with a plain username in the bracket —
  the bot pushes on a human's behalf, and the content is still machine-written, so the **author** decides, not
  the bracket. `login` is null on plenty of commits, human ones included; never key on it.

- **In an ancestor fold, "absent" and "wrong" are opposite failures, and only one is safe.** A missing component
  withholds (the export holds, nothing is overwritten); a component that is present but wrong can *unblock* an
  overwrite. That makes silent coercion the hazard: `Number(null)`, `Number("")`, `Number(false)` and
  `Number([])` are all a finite `0`, and **0 is a real reference here** (chapter-front `front:intro` rows).
  Likewise an explicit `null` in a payload is *absent*, not `""` — `pipelineImport.ts`'s hint expansion writes
  `ref_raw = COALESCE(?5, ref_raw)`, so a null there leaves the row unchanged. Two more sources of wrong values:
  writers that log less than they wrote (#546), and `(book = ? OR book IS NULL)` in the ancestor query — prod holds
  **7,689** tn/tq/twl `edit_log` rows with a NULL `book`, and row ids are unique only per `(book, id)`, so another
  book's history can fold into this one's ancestor (#545).

- **`source_sha` and `master_confirmed_at` are two different points in master's history, and they drift apart by
  design.** `recordResourceSync` advances `source_sha` at the end of any successful reimport; `master_confirmed_at`
  moves only on a POSITIVE measurement that master holds our render (`markOwnPublishConverged`, or
  `exportWorkflow`'s `confirmMaster` gate). So `source_sha` is routinely NEWER than the merge's content ancestor.
  Any question of the form *"what happened to master since the ancestor?"* must therefore be bounded by
  `master_confirmed_at`, **never** by `source_sha`: a human commit landing between the two is invisible to a
  sha-bounded walk, and "no human commit found" is the one answer that unblocks an overwrite. The same asymmetry as
  the fold rule above — walking too FAR back is harmless (an extra commit can only add a protective `human`), while
  stopping too early is the failure. This bit the first version of the commit-lineage wiring, and both cold
  reviews found it independently.

- **A merge outcome that reverses who wins needs its own `review_kind`, and its message needs its own first
  line.** The in-app cleanup chip titles itself from `review_kind` and clamps the message to two lines
  (`BookLintIndicator`), and the title was hardcoded per kind — so a row whose app-side edit was KEPT displayed
  "Merged Door43 edit", the reverse of what happened, above a message saying the opposite; a reference move,
  which merges nothing, said the same. Lead every such message with the outcome and the remedy, because for many
  readers the clamped opening IS the message. And it may not promise a publish: the export watermark is withheld
  for the WHOLE book+resource by any held reference move, a lock, or a recording failure elsewhere in the same
  file, so per-row code can only honestly say "the next export that runs for this file".

- **A master row lost to a tombstoned id is dropped by the reimport's TOMBSTONE branch,
  not by its `ON CONFLICT DO NOTHING` insert.** `applyTsvRows`' `existing` read does not
  filter `deleted_at IS NULL`, so a tombstoned id is always found and never reaches the
  insert at all; the drop happens where the tombstone is declined, and it was counted as
  an ordinary `skipped_edited`. Anyone "fixing the ON CONFLICT insert" for issue #427 will
  ship a change that provably could not have caught the 1CH 23 tQ incident. The
  discriminator that separates a real drop from a correct one is the REFERENCE: master
  carrying the id at the same ref = a delete awaiting export (skip is right); at a
  different ref = the id was reissued to a different row (real loss). See
  `isReissuedTombstone` in `api/src/reimportClassify.ts`.

- **Our own USFM render does not round-trip, so "D1 differs from master" does NOT mean a
  human changed anything.** Measured 2026-08-11 by running the real
  `extractVersesForRange` → `buildUsfm` → `extractVersesForRange` over the checked-in ZEC
  samples: **37 of 225 ULT verses and 42 of 225 UST (16–19%)** come back with a different
  tree. Three causes, all ours: `normalizeUsfmFormatting` rewrites blank lines and
  re-parsing absorbs them into the verse's trailing text node (`".”\n"` → `".”\n\n"`, and
  the same on `nextChar`); `recomputeTargetOccurrences` renumbers word occurrences on the
  second pass for verses with nested `\zaln` (a word going `1/4` → `1/5`); and text-node
  tree shape shifts (a newline-only node appears before a trailing `\p`/`\q`; two adjacent
  text nodes merge, `", "` + `"‘"` → `", ‘"`). Round trips are **convergent, not
  oscillating** — a verse differs once and then stabilizes (verified over 5 passes).
  **Any feature that compares stored content against a render — or against master, which is
  a render we published — must normalize for this or it will act on phantom changes.** The
  verse merge nearly shipped rewriting ~17% of edited verses nightly and deleting their
  `text`-lane sign-offs on that basis. Its workaround is comparison-level only
  (`sortKeysDeep` / `collapseWhitespaceForCompare` / `dropOccurrenceForWordNodes` in
  `verseMerge.ts`) and is safe by construction: dropping a field from the compared form can
  only make two sides look MORE equal, so it can only ever reduce writes, never manufacture
  one — the bytes written stay verbatim. **That is a mask, not a fix**; the underlying
  instability is still there, is probably implicated in the recurring export churn, and
  those masks must not be removed until a round-trip-stability test passes.

- **A two-way compare cannot tell you who moved, and guessing is how the nightly sync
  lost data for months.** D1-vs-master alone is symmetric: a difference proves *something*
  changed, never *which side*. The old sync resolved that ambiguity by assuming D1 was the
  newer side (skip any verse with `updated_by` set), so every out-of-band correction made
  directly on Door43 master was skipped on the way in and then reverted on the way out by
  the export rendering stale D1 over it. The 2026-08-11 1CH incident is the measured case:
  192 verses reverted, 185 of them with `updated_by` set, 174 with their last app edit
  *older* than the master content they destroyed. **The fix is an ancestor, not a
  preference.** The content is recoverable for free from `edit_log` — every `kind='verse'`
  payload is a FULL snapshot (`verseHistory.ts`'s `normalizeContent` absorbs the two writer
  shapes) — but **the cutoff that bounds it is the part that is easy to get catastrophically
  wrong.** `export_snapshots.committed_at` is NOT it, and reaching for it is the trap: that
  is when we pushed to a `-be-` BRANCH, and merging is done by an external DCS Actions job
  with no `merged_at` recorded anywhere in this codebase. Unmerged `-be-` branches are
  routine (JER ULT blocked since 2026-07-31; dangling refs need a manual PAT). Use a branch
  push as "published" and a translator's edit that master never received looks like "we
  didn't move, master did" — so the merge reverts the translator to master's older text,
  silently, in the exact situation the fix targets (an out-of-band master edit is *what
  makes* the branch unmergeable). The only trustworthy signal is a **live, freshly-measured
  byte comparison against master**, which `commitToDcs` already performs: it GETs master and
  returns `branchTouched: false` only when our render is byte-identical to it. That stamps
  `book_resource_syncs.master_confirmed_at` (migration 0045), and *that* is the cutoff.
  Note `changed: false` alone is NOT sufficient — it also fires when our render matches the
  unmerged `-be-` branch, which proves nothing about master. Two further load-bearing
  properties: `edit_log` is swept at 180 days (`index.ts` ~329), and a book+resource never
  confirmed on master has no ancestor at all — so "no ancestor → keep D1" must stay a
  first-class outcome, never an error path and never read as "nothing changed".
  Note also that `computeEditedFieldMerge` (PR #422) is **not** a three-way merge despite
  being cited as one — it compares only D1 and master, and adopts on ancestor-free
  predicates (a field no human can own, or a whitespace-only difference).
  See `verseMerge.ts`, `verse_merge_conflicts` (migration 0044).
- **To count what bible-editor pushed to Door43, match `bible-editor: {BOOK} {resource} →
  master (#PR)`.** The merge bot squashes our `-be-` PRs, so the message on `master` is
  NOT the branch commit's `bible-editor export: …` text and does NOT contain `-be-`.
  Searching for either of those returns zero hits and reads as "we never pushed that
  book" — a false negative I published before being corrected: the true count was 125
  pushes to 25 already-published books over ~300 commits per repo. Note the arrow is
  U+2192, and Windows consoles need `sys.stdout.reconfigure(encoding="utf-8")` or the
  script dies mid-scan. Same class as the measurement-harness lesson: when a scan
  reports zero, verify the pattern against one known-true example (e.g. en_tn commit
  `58ea381e`) before believing it.

- **`isReadOnly()` in `web/src/sync/api.ts` suppresses the SAVE, not the INPUT.** It
  short-circuits the outbox and drafts, but nothing it does sets `contentEditable=false`
  or disables a button — so a "read-only" surface can still be typed into, look like it
  worked, and silently discard the work. The **viewer role has this same latent gap
  today.** Any new read-only mode must ALSO thread a flag into the props that actually
  disable editing (the chapter-lock plumbing in `docs/ai-pipeline-handoff.md` is the
  pattern). Two corollaries found while building book locks: drag-and-drop surfaces (the
  aligner) are invisible to a `contenteditable` audit, so check them separately; and a
  blanket write-block in `request()` also kills writes the server deliberately still
  allows — it made comments vanish and made unlocking impossible from the UI. Split
  read-only into named reasons rather than one global boolean.

- **"Where is the user?" has no single source in this app — and both available sources
  are blind in a different direction.** `activeVerse` is Shell-LOCAL state
  (`useState(initialVerse)`), so clicking a verse does not necessarily rewrite the URL
  hash: measured live, the app sat on verse 4 while the hash still read `#/ZEC/1/2`.
  Meanwhile `App` renders `<Shell key={loc.book}>`, so a BOOK change destroys the whole
  subtree and any ref inside it still holds the old book when its teardown runs. So
  in-tree state is authoritative for verse/chapter and useless for book; the hash is
  authoritative for book and can lag on verse. Any feature that fires on "the user
  navigated away" must take each dimension from the source that can actually see it —
  reading verse from the hash reintroduces the bug it was meant to fix (PR #411).
  Related: a component memoized with a custom comparator (`areNotePropsEqual`) will
  swallow the render an effect needs unless the new prop is added to the comparator.

- **An absent measurement is not a clean measurement — and it must never overwrite
  evidence.** Third instance of this class (after the alert-wording fix and the reimport
  watermark certifying skipped chapters). `alignment_attention` is a replace-all snapshot,
  so any code path that writes it on a night nothing was compared DELETES real prior
  findings and leaves the indicator silently empty. Two doors had to be closed, not one:
  `master_unreadable` yields an EMPTY offender list, and `unparseable_render` /
  `empty_render` yield a NON-empty list holding only the synthetic `ref: "*"` sentinel —
  so a plain `length === 0` guard is insufficient. Rule for any future evidence table:
  the write path must prove it measured something per-verse before it is allowed to
  replace what is already stored, and "clean" must arrive by its own explicit path
  (here `detail === "ok"` → `clearAlignmentAttention`), never inferred from emptiness.

- **A guard that CAN detect something is not automatically entitled to block on it.**
  Benjamin's ruling (2026-08-04) on the alignment-shrink backstop: "an unaligned word or
  two here or there is no reason not to sync to Door43 ... don't hold somebody's work back
  cause he didn't drag 'and' to the right spot." Detection and embargo are now separate
  decisions (`classifyAlignmentLossSeverity` in `export.ts`): translator-scale loss ships
  with a `warning` banner, and only bug-shaped loss — a flattened verse, a gutted verse,
  systemic scale, a broken render, an unverifiable master — still withholds the book. When
  adding any future export gate, ask who is harmed by the block, not just whether the
  condition is detectable.

- **…but that policy has a measurable BOUNDARY: does DCS itself hard-reject the condition?**
  Applying it to the three remaining export gates (2026-08-04) found that none of them
  should be split, for one reason: shipping past them would not publish the book anyway.
  The test to run before relaxing any gate is "if we ship this, does it MERGE?"
  - `validate_usfm_files.py` (Checks 7/8, the USFM HOLD gate) has **no severity tier at
    all** — its `ValidationError` has no `severity` field, so every issue counts toward the
    exit code. That is the opposite of `validate_tn/tq/twl_files.py`, whose blank-field
    checks are `severity="warning"` (the reason that gate was rightly deleted). Same for
    the Occurrence checks behind `hardRejectGuard.ts`: no `severity` kwarg → default
    `"error"`. `merge-be-pr.yaml` merges only on `workflow_run.conclusion == 'success'`,
    so a hard error means the `-be-` PR goes red and never merges.
  - So for those gates, blocking withholds **nothing that shipping would have delivered**;
    it only adds a banner naming the row/line. Alignment loss was different precisely
    because DCS has *no* alignment check anywhere (verified: zero hits for `zaln`,
    `occurrence`, `\w` across all 8 checks), so shipping it really did publish the work.
  - The TSV shrink guard already had this split done right (`attributeTsvShrink`:
    `unexplained === 0` ships, plus the `allowShrink` override). Every remaining block is
    data loss, an unreadable master, or our own render disagreeing with itself. Leave it.
  - Validation is **per-book** (`--book` from the `-be-` branch name), so one bad book
    cannot block another's PR. The whole-repo behaviour noted elsewhere applies to the
    push-to-master workflow, which gates nothing.

- **A ported validator's FIDELITY is the gate's whole justification — diff it against the
  real source, don't eyeball it.** `usfmValidate.ts` had drifted from DCS in six places,
  five of which made it *under*-block (it accepted `\p “And he said\v 5`, `\b\v 5`, and had
  no `\ts\*`/`\b` own-line or `\b`-after-`\ts\*` rules at all): DCS's `_VERSE_PREFIX_RE` is
  `$`-anchored and has no `b` branch, where ours used a word boundary and allowed `b`. The
  sixth made it *over*-block: DCS's Check 8 skips the header (everything before the first
  blank line) and ours did not — and Check 7 lives in a different DCS function with **no**
  header skip, so the two checks must be gated differently in our single loop. Note the
  blank line after `\mt1` is load-bearing: without one, DCS's Check 8 never activates at
  all, so a test fixture lacking it passes vacuously. Measured impact of the fix: 0 issues
  across 34 real `en_ult`/`en_ust` master files, verified by injecting each violation into a
  real file to prove the rules actually fire.

- **DCS's blank-required-field checks are WARNINGS, not errors — measure the validator
  before gating on it.** All five (`validate_tn_files.py` "Note column cannot be blank",
  `validate_tq_files.py` Question/Response, `validate_twl_files.py` OrigWords/TWLink) are
  raised at `severity="warning"`. All three validators share an `ErrorCollector` whose
  `has_failures()` says "Only hard errors decide the exit code. Warnings are advisory …
  must not stop a book from merging", `emit_results` returns `1 if failed else 0`, and
  `merge-be-pr.yaml` merges on `workflow_run.conclusion == 'success'`. So a blank row
  PUBLISHES: en_tn master carried 19 blank-Note rows (2CH 5, ECC 8, JER 6) with green push
  validation. The `blank_field_guard` export HOLD gate was built on the opposite assumption,
  asserted in five comments and never measured, and it withheld all of JER/ECC/2CH from
  Door43 indefinitely. Removed 2026-08-03. **The validators are not in this repo — fetch
  them from `https://git.door43.org/unfoldingWord/en_<res>/raw/branch/master/.gitea/workflows/`
  and read the severity before building anything that assumes DCS will reject content.**
  Corollary: nothing downstream catches a blank field, so the in-app lint and the save-path
  guards (`rows.ts` 422 `blank_note`, `NoteCard.flushPending`) are the only protection.

- **`Occurrence` is the column DCS actually hard-rejects — and it must be judged on the
  RENDERED TSV, never on the D1 rows.** In the same validator files, the Occurrence checks carry
  no `severity` kwarg, so they default to `"error"`: twl rejects a blank Occurrence
  unconditionally, tn only when Quote is non-blank, tq not at all. `api/src/hardRejectGuard.ts`
  holds the export for these. It reads the rendered bytes because `origLangOccurrence`
  (`export.ts`) coerces null/0 → 1 whenever the Quote contains Hebrew/Greek: 10,708 prod tn rows
  look offending in D1 but only **one** renders offending. Gating on rows would hold nearly every
  tn book — the same over-broad mistake as the blank-field gate, in the other direction.
  Live offenders as of 2026-08-03: `tn JER 37:5` `bfyt` (English quote, Occurrence NULL — holds
  JER TN; fix is one field in the editor) and `twl DAN 3:5` `xf8f` (OrigWords "fall down",
  Occurrence NULL — DAN TWL has been silently failing DCS validation). Root cause is a create
  path: `Shell.tsx` "add word" posts no `occurrence` and `CreateTwl` has no default.

- **A green typecheck can mean "checked nothing".** If `node_modules` is damaged, an
  unresolvable entry in tsconfig `types` (here `vite/client`) makes `tsc` emit one TS2688
  and silently skip the entire program — it reports success while checking zero files.
  Before trusting any "typecheck clean" claim on a checkout whose deps are questionable,
  **plant a deliberate canary error** (`export const canary: number = "nope";`) and confirm
  the checker reports it. Doing this on 2026-07-20 exposed a real bug that the broken check
  had hidden. Workaround when a `types` entry can't resolve: a temp tsconfig that
  `extends` the real one with `"types": []`, then ignore the resulting `import.meta.env`
  errors as artifacts. The same "prove the tool runs before trusting its silence" rule
  applies to any linter/test filter.

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

- **Chapter-front `\p` can pile up +1 per nightly export (EZK 8/11, 2026-07).** bp-assistant's out-of-band
  direct-to-master push is only the *trigger*; the per-night pump is the DCS-side merge of the never-rebased
  `-be-` export branch (frozen merge-base drift — same class as the `-be-` no-rebase issue). Every BE transform
  (`extractVersesForRange`/`buildUsfm`/`normalizeUsfmFormatting`/`applyVerseRows`) is idempotent on real bytes,
  so BE never *creates* the extra `\p` — but it also never *collapsed* it (`dropDoubledLeadingMarkers` excludes
  verse-0 by design), so it carried the growth forward. Fix: a front-run collapse of consecutive bare `\p` → one,
  in `normalizeUsfmFormatting` (export) **and** `extractVersesForRange`/verse-0 (import, so D1 self-heals). It only
  ever *removes* a duplicate `\p` — never invents one, never touches poetry or a chapter that opens without `\p`.
  Our export normalizer is a line-*formatter*, not a semantic validator: only DCS-side CI caught the stack — hence
  the separate task to adopt DCS's USFM validation into our write path.

- **A watermark must not certify data it didn't apply — and the check must sit where the laundering can't
  reach it.** The nightly reimport skips chapters held by a pipeline lock, then stamped
  `book_resource_syncs` for the whole `(book, resource)` anyway; the export's freshness gate trusts that
  stamp, so EZK 40 UST (stale in D1 since 2026-06-10) nearly reverted a whole new chapter bp-assistant had
  pushed to master. Three traps found while fixing it, each worth remembering as a *class*: (1) `skipped_locked`
  is **overloaded** — apply-phase chapter skips *and* prune-phase row skips — so gating on it is far too broad;
  gate on purpose-built counters. (2) The prune runs in a **later Workflow step** than the chunks, so it re-reads
  lock state — a job starting between them was invisible to a chunk-only gate. (3) A fail-safe that treats an
  absent field as "withhold" is defeated if an aggregation step upstream coerces absent → `0`: the check then sees
  a *present* zero. Put the taint in the aggregation, not just the predicate. Also: `checkMasterFreshness` returns
  `no_watermark` as **ok**, so "withhold the stamp" is a no-op for a book that never had a row — withholding must
  write something that cannot match a real SHA. (PRs #394/#395)
- **A guard's alert wording is not cosmetic — a wrong cause sends the operator at the wrong fix.** The alignment
  backstop reported EZK 40 as `lost alignment on "steps"` when D1 and master held entirely *different revisions*
  of the verse; those words were coincidental surface matches, and the alert told a human to re-align a word when
  the real fix was the sync. Same shape in the TSV shrink guard, which asserted "truncated fetch, not a real
  deletion" unconditionally and recommended a re-sync that would have **resurrected 62 deliberately deleted**
  1CH TQ questions. Rule: an alert may only state a cause the code actually measured; when it can't tell, say so
  and name the detail. Use `analyzeAlignmentDelta`'s `wordSequenceUnchanged` to separate genuine collateral
  de-alignment from a revision mismatch — **for wording only.** Never let it narrow the refusal *decision*:
  that exemption is exactly what let the 1CH 4:21 collateral loss ship (see the warning comment in
  `alignmentDelta.ts`).
- **The `deferredreward/bible-editor-multilingual` downstream fork is not a source of unmerged fixes for us —
  check their own sync doc before re-triaging from scratch.** It forked at `7f83a398` (2026-07-13) and has
  since rearchitected into a multi-tenant product (workspaces, per-org config, an `aquifer`/articles import
  pipeline, an AI-provider BYO-key system, a "flows" UI) with no equivalent surface here. Their own
  `docs/upstream-sync-2026-08-21.md` (in their repo, not ours) records that they actively triage *our* commits
  into *their* fork — 298 of our commits reviewed, ~40 ported, the rest deferred or "ruled not applicable
  (fork verified)" because the subsystem doesn't exist on their side (book locks, comments/mentions,
  alignment_attention, occurrenceRule, etc.). That list is the mirror image of what would be relevant in the
  other direction: on 2026-08-24 every candidate backend fix sampled from their commits since the fork point
  (shrink-guard master-404 bootstrap, force-wipe safety-gate widening, cross-source tn/tq id remap, DCS-fetch
  error surfacing) was either already superseded by more mature protections already in our `shrinkGuard.ts`/
  `exportWorkflow.ts`/`bookReimport.ts`, or tied to a feature (multi-source import, admin force-reimport,
  per-org routing) that doesn't exist in this codebase. Their 3 commits since their own sync
  (`655e9f6`/`556919e`/`b631959`, 2026-08-22) are all fixes to their own "flows"/admin-desk React components
  that have no counterpart here. **Next time this routine runs:** read their `docs/upstream-sync-*.md` first
  (it names the merge-base and what they've already absorbed from us), then diff commits after their latest
  sync doc's date rather than re-walking the full history back to `7f83a398`.

## Stop conditions / goals

- No standing automated loop is wired to this file yet. When one is, record its goal here, e.g.:
  - `/goal "npm run typecheck && npm run build clean"` — met on `<commit>` at `<time>`.
