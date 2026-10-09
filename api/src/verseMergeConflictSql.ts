// Pure leaf module (no Env / Hono / D1 imports) so verseMergeConflicts.test.mjs
// can run the EXACT production SQL against real SQLite without dragging in
// verses.ts's / verseMergeConflicts.ts's whole dependency graph — same reason
// blankStub.ts stands alone for blankStubTrash.test.mjs. Every statement here
// is imported by BOTH the production code and the test, so the two cannot
// silently drift apart.
//
// The one import below is another pure-leaf module (verseMergeEditorAlerts has
// zero imports of its own), so it keeps this module's leaf property intact while
// letting the no-base DELETE guards reference the single-source-of-truth
// fingerprint constants rather than re-hardcoding them.
import { NO_BASE_ADMIN_FINGERPRINT, NO_BASE_EDITOR_FINGERPRINT } from "./verseMergeEditorAlerts.ts";

// ---------------------------------------------------------------------------
// verses.ts's PATCH route, statement 1 of its `env.DB.batch([...])` array —
// the actual content write. Exported so tests can drive the exact
// version-matching / `changes()`-seeding behavior the other two statements in
// that batch depend on, without hand-copying a "simplified" stand-in that
// could drift from the real WHERE clause.
//
// Binds, in order: (contentJson, plainText, updatedAt, updatedBy,
// lastChangeAction, lastChangeSource, lastChangeActor, book, chapter, verse,
// bibleVersion, expectedVersion). Bound at exactly one call site — verses.ts's
// PATCH route (issue #686).
// ---------------------------------------------------------------------------
export const VERSE_PATCH_UPDATE_SQL = `UPDATE verses
   SET content_json = ?1, plain_text = COALESCE(?2, plain_text), version = version + 1,
       updated_at = ?3, updated_by = ?4, last_change_action = ?5, last_change_source = ?6, last_change_actor = ?7
 WHERE book = ?8 AND chapter = ?9 AND verse = ?10 AND bible_version = ?11
   AND version = ?12`;

// ---------------------------------------------------------------------------
// verses.ts's PATCH route, statement 3 — marks a flagged conflict resolved
// instead of the old DELETE (migration 0049), when a human saves a verse
// that has an unresolved verse_merge_conflicts row (see verses.ts's PATCH
// handler and verseMergeConflicts.ts's header comment). Keeps the row (and
// its overwritten_version recovery pointer) for the audit trail while
// dropping out of every "active conflicts" view (`resolved_at IS NULL`).
//
// `changes() > 0` reads the row count from the PRECEDING statement in the
// same batch (the edit_log INSERT, itself gated on the verses UPDATE having
// landed) — see verses.ts's inline comment for why this is deliberately NOT
// `verses.version = newVersion`. `resolved_at IS NULL` keeps a later,
// unrelated save from re-stamping (and reassigning resolved_by on) a
// conflict a previous save already resolved.
//
// Binds, in order: (resolvedAt, resolvedBy, book, resource, chapter, verse).
// ---------------------------------------------------------------------------
export const RESOLVE_VERSE_MERGE_CONFLICT_SQL = `UPDATE verse_merge_conflicts
    SET resolved_at = ?1, resolved_by = ?2
  WHERE book = ?3 AND resource = ?4 AND chapter = ?5 AND verse = ?6
    AND resolved_at IS NULL
    AND changes() > 0`;

// ---------------------------------------------------------------------------
// bookReimport.ts's applyVerseRows (issue #789) — resolves a
// `keep_alignment_refused` / `source_attr_divergent` / `keep_local_structure`
// row for a verse the SAME reimport run measured as `keep_converged` or
// `keep_master_unchanged` (computeVerseMerge's two clean outcomes — `adopt:
// false, conflict: false` — which write NO verse_merge_conflicts row of their
// own; see verseMerge.ts). Until this statement existed, none of the three
// actions above was ever re-recorded once the underlying D1-vs-master
// difference resolved itself, so a standing row from an old refusal sat in
// the "Sync flagged N verse(s)" banner with its original `first flagged` date
// long after the sync stopped disagreeing about that verse (prod 2026-09-14:
// rows stale three to four weeks across EZK ULT/UST, JER UST, DAN UST).
//
// `resolved_by = NULL` is the documented system-retired marker — see
// RETIRE_KEPT_AI_MASTER_CONFLICTS_SQL's doc comment above for why that pair
// is unambiguous against a real human resolve (RESOLVE_VERSE_MERGE_CONFLICT_SQL
// above always binds a non-null resolved_by). Deliberately excludes `adopt`,
// `adopt_conflict`, and `adopt_no_visible_change`: those record a landed
// adoption a human is meant to look at, and only a human's own save
// (RESOLVE_VERSE_MERGE_CONFLICT_SQL) resolves them. `resolved_at IS NULL`
// keeps this idempotent — a row already resolved, by a human or an earlier
// run, is left untouched (0 changes).
//
// `recorded_generation` is an optimistic token: a concurrent upsert increments
// it, so a cleanup based on an older backlog read cannot retire fresh evidence.
// Binds, in order: (resolvedAt, book, resource, chapter, verse, action,
// recordedGeneration).
// ---------------------------------------------------------------------------
export const RESOLVE_CONVERGED_VERSE_MERGE_CONFLICT_SQL = `UPDATE verse_merge_conflicts
    SET resolved_at = ?1, resolved_by = NULL
  WHERE book = ?2 AND resource = ?3 AND chapter = ?4 AND verse = ?5
    AND action = ?6
    AND recorded_generation = ?7
    AND resolved_at IS NULL`;

// ---------------------------------------------------------------------------
// verseMergeConflicts.ts's raiseVerseMergeConflictAlert — the active,
// human-actionable conflict rows for one (book, resource). Exported (not
// inline) so verseMergeConflicts.test.mjs can prove the exact `action IN (...)`
// filter against real SQLite, the same anti-drift reason every other statement
// here is a shared constant.
//
// The alertable actions are the ones a human still needs to look at:
//   'adopt_conflict'         — Door43's version replaced a human edit.
//   'keep_alignment_refused' — kept D1 (nothing overwritten), export will
//                              still revert master until resolved.
//   'source_attr_divergent'  — kept D1 (nothing overwritten): master carries a
//                              curated original-language source fix on a verse
//                              whose repeated source words made the fix
//                              impossible to place unambiguously (the EZK 40
//                              repeated-architecture-terms case). Same
//                              export-reverts-until-resolved shape as a refusal.
// 'keep_ai_master' was a fifth entry until issue #749 and is deliberately GONE:
// that outcome (both sides moved, but a COMPLETE lineage walk found every commit
// that moved master's file since the ancestor came from our own export or the
// unfoldingWord bot account, so the app edit won — #540 item 2) is adjudicated
// on evidence, takes nothing from Door43, and is published by the next export.
// Listing it here put rows in the "Sync flagged N verse(s)" banner that no human
// could usefully act on and that only left it on a manual edit or dismiss (prod
// 2026-09-09: 37 such rows across EZK ULT/UST and JER ULT, some standing three
// weeks). bookReimport.ts no longer records the row at all, and
// retireVerseKeptAiMasterFlags retires the standing ones. This is the verse
// analogue of #703's retirement of the TSV `merge_kept` review flag.
// A clean 'adopt' (master moved, we didn't) is deliberately EXCLUDED — it needs
// no judgement and stays in the table purely as an audit trail.
// Same for 'adopt_no_visible_change' (issue #633): both sides moved by stableKey
// but plain text and alignment groups match, so the write is cosmetic — audit
// only, never a banner claiming Door43 replaced the editor's work.
// 'keep_local_structure' (issue #728) is a fourth kept-D1 action: the nightly
// sync kept D1's verse-bridge STRUCTURE (a `\v a-b` row, or its split) where
// master's differs — reasons master_moved_non_human, master_structure_complex,
// master_moved_under_local_bridge, or anchor_<merge action>. Like the other
// keep actions it has no CAS write, so it joins their overwritten_version→NULL
// and re-detection reactivation carve-outs below. This list is duplicated in
// the two CLEAR_* statements — keep all three in step.
//
// Binds, in order: (book, resource).
// ---------------------------------------------------------------------------
export const SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL = `SELECT chapter, verse, action, reason, overwritten_version, alignment, detected_at, recorded_generation
     FROM verse_merge_conflicts
    WHERE book = ?1 AND resource = ?2
      AND action IN ('adopt_conflict', 'keep_alignment_refused', 'source_attr_divergent', 'keep_local_structure')
      AND resolved_at IS NULL
    ORDER BY chapter ASC, verse ASC`;

// ---------------------------------------------------------------------------
// The two DELETEs clearResolvedConflictBannerIfLast runs once it has decided
// the resolve it was called for was the LAST active alertable conflict.
//
// The NOT EXISTS re-states that decision INSIDE the DELETE, and that is the
// whole point of these two constants existing rather than reusing
// clearUndismissedAlertsStmt (PR #631 Codex review). The decision and the
// delete are separate round-trips, so a reimport landing in the gap could
// record a fresh conflict and raise its banner only for this now-stale clear
// to delete it — leaving a real Door43/app divergence with no banner until the
// next sync. Re-checking the predicate atomically closes that window: a
// reimport writes its verse_merge_conflicts rows BEFORE it raises the alert
// (raiseVerseMergeConflictAlert derives the message by reading this table), so
// either those rows are already visible and this DELETE matches nothing, or
// they land afterwards and the reimport's own alert is written after we are
// done. Either way the surviving banner reflects the real conflict set.
//
// The two `message NOT LIKE` guards exclude any undismissed alert still carrying
// a keep_no_base warning (#761 3rd-pass Codex review P1). keep_no_base writes NO
// verse_merge_conflicts row, so the NOT EXISTS guard above cannot see it — a
// no-base warning that lands in the read→DELETE race window would otherwise be
// erased by the source-wide form, losing the only durable carrier of that
// warning before export (the same invariant alertMessageCarriesNoBaseWarning
// enforces in JS; these fingerprints contain no SQL wildcards, so LIKE '%x%'
// matches exactly includes(x)). Narrowing only — can never delete more.
//
// Binds, in order: (source, book, resource).
export const CLEAR_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL = `DELETE FROM system_alerts
    WHERE source = ?1 AND dismissed_at IS NULL
      AND message NOT LIKE '%${NO_BASE_ADMIN_FINGERPRINT}%'
      AND message NOT LIKE '%${NO_BASE_EDITOR_FINGERPRINT}%'
      AND NOT EXISTS (SELECT 1 FROM verse_merge_conflicts
                       WHERE book = ?2 AND resource = ?3
                         AND action IN ('adopt_conflict', 'keep_alignment_refused', 'source_attr_divergent', 'keep_local_structure')
                         AND resolved_at IS NULL)`;

// Binds, in order: (username, source, book, resource).
export const CLEAR_CONFLICT_ONLY_ALERTS_BY_USER_SQL = `DELETE FROM system_alerts
    WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL
      AND message NOT LIKE '%${NO_BASE_ADMIN_FINGERPRINT}%'
      AND message NOT LIKE '%${NO_BASE_EDITOR_FINGERPRINT}%'
      AND NOT EXISTS (SELECT 1 FROM verse_merge_conflicts
                       WHERE book = ?3 AND resource = ?4
                         AND action IN ('adopt_conflict', 'keep_alignment_refused', 'source_attr_divergent', 'keep_local_structure')
                         AND resolved_at IS NULL)`;

// Stage 7 counterpart used by production clear paths. Keep the legacy DELETE
// exports above for pre-0066 compatibility callers/tests, but new transitions
// resolve rows so recurrence can mint a new alert without erasing history.
export const RESOLVE_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL = `UPDATE system_alerts
    SET resolved_at = unixepoch()
    WHERE source = ?1 AND resolved_at IS NULL AND kind = 'review'
      AND message NOT LIKE '%${NO_BASE_ADMIN_FINGERPRINT}%'
      AND message NOT LIKE '%${NO_BASE_EDITOR_FINGERPRINT}%'
      AND NOT EXISTS (SELECT 1 FROM verse_merge_conflicts
                       WHERE book = ?2 AND resource = ?3
                         AND action IN ('adopt_conflict', 'keep_alignment_refused', 'source_attr_divergent', 'keep_local_structure')
                         AND resolved_at IS NULL)`;

export const RESOLVE_CONFLICT_ONLY_ALERTS_BY_USER_SQL = `UPDATE system_alerts
    SET resolved_at = unixepoch()
    WHERE username = ?1 AND source = ?2 AND resolved_at IS NULL AND kind = 'review'
      AND message NOT LIKE '%${NO_BASE_ADMIN_FINGERPRINT}%'
      AND message NOT LIKE '%${NO_BASE_EDITOR_FINGERPRINT}%'
      AND NOT EXISTS (SELECT 1 FROM verse_merge_conflicts
                       WHERE book = ?3 AND resource = ?4
                         AND action IN ('adopt_conflict', 'keep_alignment_refused', 'source_attr_divergent', 'keep_local_structure')
                         AND resolved_at IS NULL)`;

// ---------------------------------------------------------------------------
// Issue #1137: the actions whose write is a master adoption, i.e. speculative
// until its version-CAS settles.
// ---------------------------------------------------------------------------
const ADOPTION_ACTIONS = `('adopt', 'adopt_conflict', 'adopt_no_visible_change')`;

// ---------------------------------------------------------------------------
// TWO-PHASE REACTIVATION (2026-08-15 Codex second-opinion review fix,
// superseding the first six-angle review's "reset resolved_at
// unconditionally" approach, which had a real bug — see below).
//
// verseMergeConflicts.ts's recordVerseMergeConflicts — the nightly-sync
// SPECULATIVE upsert, written BEFORE the master-adoption CAS batch even
// attempts its write (see bookReimport.ts step 6b). ON CONFLICT DO UPDATE,
// NOT INSERT OR REPLACE (a REPLACE deletes-then-reinserts, minting a new
// `id` and resetting `detected_at` on every re-detection of the SAME
// still-unresolved conflict — making "how long has this been sitting
// unresolved" unrecoverable).
//
// This statement does NOT touch resolved_at/resolved_by for any ADOPTION
// action (adopt / adopt_conflict) — see the 'source_attr_divergent' /
// 'keep_alignment_refused' / 'keep_local_structure' reactivation carve-out at
// the bottom of the SET clause for the deliberately safe exceptions (none has a
// CAS write, so the failure mode below cannot arise for either). The first
// version of this fix (2026-08-14) cleared them here unconditionally, on the
// theory that any fresh conflict detection should make the row visible
// again. Codex's second-opinion review found the real bug in that: this
// statement runs SPECULATIVELY, before we know whether the CAS write below
// will actually land. If a verse carried an OLD, human-resolved conflict and
// this run's speculative adopt_conflict upsert cleared resolved_at, but the
// CAS then LOST its race (a human saved first — nothing was actually
// overwritten), the row was left falsely reactivated: an active alert for an
// overwrite that never happened, with the ORIGINAL resolution's audit trail
// (resolved_by, and implicitly its resolved_at) destroyed — and
// deleteLostAdoptionConflicts's `detected_at`-based cleanup (see below)
// could not undo it, because detected_at is deliberately NOT refreshed here
// (see the next paragraph), so it never matched "this run" for a
// pre-existing row.
//
// Fix: resolved_at/resolved_by are only ever cleared by
// CONFIRM_ADOPTED_CONFLICT_SQL below, called AFTER the CAS batch confirms
// which adoptions actually landed. A lost CAS therefore leaves a
// previously-resolved row exactly as it was (resolved_at/resolved_by
// untouched) — nothing to undo, because nothing was speculatively cleared in
// the first place.
//
// `last_recorded_at` (a column separate from `detected_at`, added alongside
// resolved_at/resolved_by in migration 0049) IS refreshed unconditionally on
// every upsert — its only job is letting deleteLostAdoptionConflicts
// recognize "this exact row was touched by THIS run's speculative write",
// regardless of whether it's a brand-new row or a pre-existing one.
// `detected_at` is deliberately NOT given the same treatment: it keeps its
// original meaning ("first detected, preserved across every re-detection
// while still unresolved") untouched by any of this — conflating the two
// would have silently reset the age of a conflict that has been sitting
// unresolved for weeks every time this upsert re-ran, which is a real
// feature this table exists to support, not a bug to route around. The one
// exception (issue #1124) is an unresolved audit-only row promoted to
// adopt_conflict: nobody was ever alerted about it, so its streak as a
// conflict starts tonight (see the detected_at CASE below).
//
// Binds, in order: (book, resource, chapter, verse, action, reason,
// overwrittenVersion, alignmentJson, now, bibleVersion, observedVersion,
// runId). `runId` (issue #1137) names the logical run making a speculative
// adoption write, stable across that run's retries; see the prior_* columns
// at the end of the statement.
// `now` fills BOTH the ?9 slots (detected_at at INSERT time only, and
// last_recorded_at on every write) — SQLite allows a single bound value to
// satisfy a repeated numbered parameter. `bibleVersion` is the verses table's
// exact bible_version value ("ULT" | "UST" — NOT `resource`, which is
// lowercased) so the reactivation version guard's subquery (see below) can
// find the right row. `observedVersion` is the verse's version at the time
// the caller detected this action (bookReimport.ts's `ex.version`), or NULL
// for a caller with nothing to compare (unconditional reactivation, see the
// version guard's own comment below).
// ---------------------------------------------------------------------------
export const UPSERT_VERSE_MERGE_CONFLICT_SQL = `INSERT INTO verse_merge_conflicts
     (book, resource, chapter, verse, action, reason, overwritten_version, alignment, detected_at, last_recorded_at,
      prior_run)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9,
      CASE WHEN ?5 IN ${ADOPTION_ACTIONS} THEN ?12 END)
   ON CONFLICT (book, resource, chapter, verse) DO UPDATE SET
     -- A row needing human judgement must never be DOWNGRADED by a later
     -- routine adoption — see recordVerseMergeConflicts's own doc comment for
     -- the full Night-1/Night-2 walkthrough this anti-downgrade protects.
     -- The kept-D1 CONTENT actions ('keep_alignment_refused',
     -- 'source_attr_divergent') are deliberately NOT in this carve-out, unlike
     -- 'adopt_conflict'. The two need opposite treatment: an adopt_conflict
     -- leaves a human something to RECOVER, which a later routine adoption must
     -- not hide, whereas a kept-D1 row overwrote nothing, and a later clean
     -- 'adopt' means master's value was taken after all — the disagreement is
     -- over. Keeping it sticky would leave the banner asserting "the editor's
     -- version was kept" about a verse that has since adopted master's. Nothing
     -- else un-sticks it: CONFIRM_ADOPTED_CONFLICT_SQL below matches only
     -- ('adopt','adopt_conflict','adopt_no_visible_change'). ('keep_ai_master'
     -- was the original subject of this paragraph; issue #749 retired it — no
     -- new row of that action is ever written, so it can no longer be the
     -- surviving action here.)
     -- 'adopt_no_visible_change' (issue #633) is treated like 'adopt' here: it
     -- is audit-only and must not erase a prior adopt_conflict's recovery
     -- pointer / banner claim.
     -- 'keep_local_structure' (issue #728 review) joins the carve-out for an
     -- UNRESOLVED adopt_conflict only. It is a STRUCTURE-dimension flag that
     -- can land on a verse whose CONTENT-dimension adopt_conflict (an earlier
     -- night's real overwrite) is still waiting for a human; unlike the three
     -- content-path keep actions below, it does not supersede that decision,
     -- so it must not replace the pointer the human still needs. A RESOLVED
     -- adopt_conflict is deliberately not held sticky: the reactivation
     -- carve-out at the bottom clears resolved_at for keep_local_structure
     -- (no CAS race can make it lie), and doing that on a row still labelled
     -- adopt_conflict would be exactly the false "Door43 replaced your edit"
     -- reactivation two-phase adoption exists to prevent.
     action = CASE
       WHEN excluded.action IN ('adopt', 'adopt_no_visible_change')
         AND verse_merge_conflicts.action = 'adopt_conflict'
       THEN verse_merge_conflicts.action
       WHEN excluded.action = 'keep_local_structure'
         AND verse_merge_conflicts.action = 'adopt_conflict'
         AND verse_merge_conflicts.resolved_at IS NULL
       THEN verse_merge_conflicts.action
       ELSE excluded.action
     END,
     reason = CASE
       WHEN excluded.action IN ('adopt', 'adopt_no_visible_change')
         AND verse_merge_conflicts.action = 'adopt_conflict'
       THEN verse_merge_conflicts.reason
       WHEN excluded.action = 'keep_local_structure'
         AND verse_merge_conflicts.action = 'adopt_conflict'
         AND verse_merge_conflicts.resolved_at IS NULL
       THEN verse_merge_conflicts.reason
       ELSE excluded.reason
     END,
     -- This keeps the EARLIEST overwritten_version pointer while the row is
     -- still waiting for a human: their first lost text is what they have not
     -- looked at yet. A RESOLVED row also keeps its old pointer here, because
     -- this upsert is speculative and its CAS may still lose. If the overwrite
     -- lands, CONFIRM_ADOPTED_CONFLICT_SQL below swaps in tonight's pointer as
     -- it reactivates the row (issue #1112).
     --
     -- Issue #1124: the alignment snapshot below follows the same rule, so the
     -- pointer and the lost words always describe the same overwrite. And an
     -- UNRESOLVED audit-only row ('adopt' / 'adopt_no_visible_change', which
     -- never alerted anyone) promoted to adopt_conflict tonight takes tonight's
     -- pointer, snapshot and detected_at: the overwrite an editor must now look
     -- at is tonight's, and the alert goes to the author of the version the
     -- pointer names. Taking them here, speculatively, is normally safe: if
     -- tonight's CAS loses, the lost-race cleanup puts the row back as it was
     -- before this upsert (RESTORE_SPECULATIVE_CONFLICTS_SQL, issues #1132 and
     -- #1137) or deletes it if this run created it, so tonight's pointer does
     -- not outlive a lost race. And it survives a crash between the CAS and
     -- the confirm, which is why 6b writes before the CAS at all. A crash
     -- before the CAS is rolled back by the retry (rollBackDeadAttemptConflicts).
     -- What remains: a best-effort cleanup that throws, or a run that dies
     -- and is never retried, leaves the promoted row with tonight's pointer
     -- until a later run's speculation on the verse settles it.
     detected_at = CASE
       WHEN excluded.action = 'adopt_conflict'
         AND verse_merge_conflicts.action IN ('adopt', 'adopt_no_visible_change')
         AND verse_merge_conflicts.resolved_at IS NULL
       THEN excluded.detected_at
       ELSE verse_merge_conflicts.detected_at
     END,
     overwritten_version = CASE
       -- Same unresolved-adopt_conflict carve-out as action above: the row
       -- stays an adopt_conflict, so its recovery pointer stays with it.
       WHEN excluded.action = 'keep_local_structure'
         AND verse_merge_conflicts.action = 'adopt_conflict'
         AND verse_merge_conflicts.resolved_at IS NULL
       THEN verse_merge_conflicts.overwritten_version
       WHEN excluded.action IN ('keep_alignment_refused', 'source_attr_divergent', 'keep_local_structure') THEN NULL
       -- Issue #978: the #539 no-op guard (bookReimport.ts) sends a conflicted
       -- byte no-op as adopt_conflict with a NULL pointer — nothing was
       -- overwritten. It is the only adopt_conflict writer that sends NULL.
       -- When it promotes an audit-only adopt / adopt_no_visible_change row,
       -- that row's old pointer must not ride along: the editor fan-out
       -- (raiseVerseMergeConflictAlert) alerts on adopt_conflict + non-null
       -- pointer, so the author of that old version would be told Door43
       -- overwrote them. The pointer never alerted anyone while the row was
       -- audit-only. A stored adopt_conflict keeps its pointer (the ELSE):
       -- its human may still need it.
       WHEN excluded.action = 'adopt_conflict'
         AND excluded.overwritten_version IS NULL
         AND verse_merge_conflicts.action <> 'adopt_conflict'
       THEN NULL
       -- Issue #1124: an unresolved audit-only row promoted tonight (see above).
       WHEN excluded.action = 'adopt_conflict'
         AND verse_merge_conflicts.action IN ('adopt', 'adopt_no_visible_change')
         AND verse_merge_conflicts.resolved_at IS NULL
       THEN excluded.overwritten_version
       ELSE COALESCE(verse_merge_conflicts.overwritten_version, excluded.overwritten_version)
     END,
     -- Issue #1124: for an adoption, the snapshot comes from whichever overwrite
     -- the pointer above names. The stored row keeps its own snapshot exactly
     -- when it keeps its own (non-null) pointer, so a still-unresolved
     -- adopt_conflict keeps its first lost words beside its first pointer, and
     -- a resolved row with a pointer keeps June's beside June's
     -- (CONFIRM_ADOPTED_CONFLICT_SQL swaps both on a landed overwrite; a lost
     -- race leaves both). When the pointer is tonight's (or tonight's NULL), so
     -- is the snapshot, even NULL. That includes a RESOLVED row whose stored
     -- pointer is NULL (a resolved #978 no-op row, or one that came from a
     -- keep-D1 flag): the COALESCE above gives it tonight's pointer and
     -- snapshot, and a lost race puts its NULL pointer and old snapshot back
     -- (RESTORE_SPECULATIVE_CONFLICTS_SQL, issues #1132 and #1137).
     -- The keep-D1 flags carry no pointer and keep the old COALESCE.
     alignment = CASE
       WHEN excluded.action NOT IN ('adopt', 'adopt_conflict', 'adopt_no_visible_change')
       THEN COALESCE(excluded.alignment, verse_merge_conflicts.alignment)
       WHEN verse_merge_conflicts.overwritten_version IS NOT NULL
         AND NOT (excluded.action = 'adopt_conflict'
           AND excluded.overwritten_version IS NULL
           AND verse_merge_conflicts.action <> 'adopt_conflict')
         AND NOT (excluded.action = 'adopt_conflict'
           AND verse_merge_conflicts.action IN ('adopt', 'adopt_no_visible_change')
           AND verse_merge_conflicts.resolved_at IS NULL)
       THEN verse_merge_conflicts.alignment
       ELSE excluded.alignment
     END,
     last_recorded_at = excluded.last_recorded_at,
     recorded_generation = verse_merge_conflicts.recorded_generation + 1,
     -- REACTIVATION carve-out, 'source_attr_divergent', 'keep_alignment_refused',
     -- and 'keep_local_structure' ONLY. Every other action leaves
     -- resolved_at/resolved_by untouched (the ELSE), preserving the two-phase
     -- adoption invariant documented above. These three actions are the
     -- exception because they are safe to be: none has a CAS write that
     -- could lose a race (all three are unconditional keep-D1 flags, recorded
     -- once per run and never a candidate for deleteLostAdoptionConflicts), so
     -- re-detecting any of them is itself proof the underlying condition still
     -- exists. The reason the speculative upsert must not clear resolved_at
     -- for ADOPTIONS — a lost CAS would falsely reactivate a row nothing
     -- actually overwrote — simply cannot arise here. Without this, a human
     -- who clears the flag with an UNRELATED save
     -- (RESOLVE_VERSE_MERGE_CONFLICT_SQL is action-agnostic) while the
     -- condition persists would silence it forever, and tonight's export
     -- would keep reverting master's source fix / alignment-preserving skip
     -- nightly with no banner — the exact silent revert this row exists to
     -- surface. 'keep_alignment_refused' was originally left out of this
     -- carve-out (only partially masked by the merge_refused systemic
     -- freeze) — see issue #457, closed here. 'keep_ai_master' (#540 item 2)
     -- shared the same no-CAS-race shape and was carved out here too, until
     -- issue #749 stopped recording it: nothing takes anything from Door43 in
     -- that outcome, so there is no silent revert for a reactivation to
     -- surface. No new row of that action is written, and
     -- retireVerseKeptAiMasterFlags retires the standing ones, so it is gone
     -- from every list in this statement.
     --
     -- VERSION GUARD (issue #507): the condition this run's re-upsert acts on
     -- was read from verses.content_json EARLIER in the same applyVerseRows
     -- call (bookReimport.ts's 'ex' snapshot), not at the moment this
     -- statement executes. If a human saves a fix to the verse AND resolves
     -- this conflict row in the window between that read and this upsert, the
     -- detection is stale evidence: reactivating would erase a resolution
     -- recorded against a condition that may already be gone. Bind ?11 is the
     -- verse's version AT THE TIME OF THAT READ (ex.version); the subquery
     -- reads its CURRENT version at the moment this statement runs. A
     -- mismatch means the verse changed inside that window, so reactivation
     -- is withheld this run — the next sync re-reads fresh and reactivates
     -- normally if the condition still holds then. ?11 IS NULL is a
     -- backward-compatible escape hatch (unconditional reactivation, the
     -- pre-#507 behavior) for a caller with no observed version to compare;
     -- production always supplies one for all three of these actions (see
     -- verseMergeConflicts.ts's recordVerseMergeConflicts).
     resolved_at = CASE
       WHEN excluded.action IN ('source_attr_divergent', 'keep_alignment_refused', 'keep_local_structure')
         AND (?11 IS NULL OR ?11 = (
           SELECT version FROM verses WHERE book = ?1 AND bible_version = ?10 AND chapter = ?3 AND verse = ?4
         ))
       THEN NULL
       ELSE verse_merge_conflicts.resolved_at
     END,
     resolved_by = CASE
       WHEN excluded.action IN ('source_attr_divergent', 'keep_alignment_refused', 'keep_local_structure')
         AND (?11 IS NULL OR ?11 = (
           SELECT version FROM verses WHERE book = ?1 AND bible_version = ?10 AND chapter = ?3 AND verse = ?4
         ))
       THEN NULL
       ELSE verse_merge_conflicts.resolved_by
     END,
     -- Issue #1137: the durable pre-run capture (migration 0076). An adoption
     -- write is speculative until its CAS settles, so it records what the row
     -- said before it (prior_json, NULL when there was no row) and which run
     -- owns the speculation (prior_run = ?12). A landed overwrite settles its
     -- row (prior_run NULL) in the CAS's own transaction
     -- (SETTLE_LANDED_CONFLICT_SQL), so a row that still carries prior_run
     -- holds a speculation that has not landed, whoever owns it (a retry of
     -- the same run, a ref recorded twice in one call, a dead earlier run, a
     -- run still in flight). Its real prior state is still the one captured
     -- before that speculation: keep the capture and take ownership. A
     -- settled row is captured as it is now.
     --
     -- A non-adoption action (a kept-D1 or structure flag) is a final,
     -- measured write, not a speculation, so it settles the row (review A1):
     -- otherwise a lost race of the run that owns the capture, or a later run
     -- inheriting it, would rewind this flag to the state from before that
     -- speculation. The one exception is the sticky carve-out at the top of
     -- this statement (keep_local_structure over an unresolved adopt_conflict
     -- keeps the adopt_conflict and its pointer): the row still shows the
     -- speculative overwrite, so the capture stays to undo it. An adoption
     -- from a caller with no run id (?12 NULL) settles the row too.
     prior_json = CASE
       WHEN excluded.action = 'keep_local_structure'
         AND verse_merge_conflicts.action = 'adopt_conflict'
         AND verse_merge_conflicts.resolved_at IS NULL
       THEN verse_merge_conflicts.prior_json
       WHEN excluded.prior_run IS NULL THEN NULL
       WHEN verse_merge_conflicts.prior_run IS NOT NULL THEN verse_merge_conflicts.prior_json
       ELSE json_object(
         'action', verse_merge_conflicts.action,
         'reason', verse_merge_conflicts.reason,
         'overwritten_version', verse_merge_conflicts.overwritten_version,
         'alignment', verse_merge_conflicts.alignment,
         'detected_at', verse_merge_conflicts.detected_at,
         'last_recorded_at', verse_merge_conflicts.last_recorded_at)
     END,
     prior_run = CASE
       WHEN excluded.action = 'keep_local_structure'
         AND verse_merge_conflicts.action = 'adopt_conflict'
         AND verse_merge_conflicts.resolved_at IS NULL
       THEN verse_merge_conflicts.prior_run
       ELSE excluded.prior_run
     END`;

// ---------------------------------------------------------------------------
// verseMergeConflicts.ts's confirmAdoptedConflicts — the SECOND phase of
// two-phase reactivation. Called from bookReimport.ts AFTER the
// master-adoption CAS batch runs, for exactly the refs whose write actually
// LANDED (`adoptionsApplied` / `landedAdoptions`) — never for refs whose CAS
// lost, and never for `keep_alignment_refused` (which never attempts a
// write, hence the `action IN (...)` guard here as a second, independent
// check on top of the caller only ever passing landed-adoption refs).
//
// This is the ONLY statement that clears resolved_at/resolved_by for an
// adoption — see UPSERT_VERSE_MERGE_CONFLICT_SQL's doc comment for why the
// speculative upsert must not do this eagerly. Confirming only after the
// write is known to have landed means a lost CAS never reactivates anything:
// nothing was cleared speculatively, so there is nothing to undo.
//
// Issue #996: a row coming back from RESOLVED also gets detected_at = ?5
// (this run's `now`). The old streak ended when a person resolved it; tonight's
// landed overwrite is a new one, and the editor alert dates refs by
// detected_at ("first flagged"). Keeping June's date would present a fresh
// loss as an old, known one. A row that was still unresolved keeps its date,
// so detected_at still means "first detected, preserved across every
// re-detection while still unresolved". SQLite evaluates every SET expression
// against the row as it was before the UPDATE, so the CASE sees the old
// resolved_at even though the same statement clears it.
//
// Issue #1112: the same reactivation also takes tonight's overwritten_version
// (?6) and alignment snapshot (?7). The speculative upsert's COALESCE kept the
// resolved row's old pointer (June's v4), and the editor alert goes to the
// author of the version the pointer names, so keeping it told v4's author to
// recover v4 and never alerted the author of tonight's overwritten v11. June's
// lost-word snapshot likewise describes a loss someone already dealt with, so
// ?7 replaces it even when tonight's is NULL. A row still unresolved is left
// alone here: the speculative upsert already settled which overwrite it
// describes, with pointer and snapshot together (issue #1124). A standing
// adopt_conflict keeps its first pointer, first snapshot and detected_at,
// because that first loss is what its editor has not looked at yet. An
// audit-only row ('adopt' / 'adopt_no_visible_change') promoted tonight
// already holds tonight's pointer, snapshot and detected_at, since it never
// alerted anyone. This statement cannot make that distinction itself: by the
// time it runs, the upsert has already rewritten the row's action.
//
// Issue #1132 review: the confirm also bumps recorded_generation, keeping the
// token monotonic. Since issue #1137 the lost-race restore no longer reads it
// (RESTORE_SPECULATIVE_CONFLICTS_SQL is guarded by prior_run, which
// SETTLE_LANDED_CONFLICT_SQL clears with a landed CAS).
// The only other reader, RESOLVE_CONVERGED_VERSE_MERGE_CONFLICT_SQL, matches
// kept-D1 actions this statement never touches.
//
// Binds, in order: (book, resource, chapter, verse, now, overwrittenVersion,
// alignmentJson).
// ---------------------------------------------------------------------------
export const CONFIRM_ADOPTED_CONFLICT_SQL = `UPDATE verse_merge_conflicts
    SET detected_at = CASE WHEN resolved_at IS NULL THEN detected_at ELSE ?5 END,
        overwritten_version = CASE WHEN resolved_at IS NULL THEN overwritten_version ELSE ?6 END,
        alignment = CASE WHEN resolved_at IS NULL THEN alignment ELSE ?7 END,
        resolved_at = NULL, resolved_by = NULL,
        recorded_generation = recorded_generation + 1
  WHERE book = ?1 AND resource = ?2 AND chapter = ?3 AND verse = ?4
    AND action IN ('adopt', 'adopt_conflict', 'adopt_no_visible_change')`;

// ---------------------------------------------------------------------------
// Issue #1137 (superseding #1132's in-memory capture): settling a run's
// speculative adoption rows from the durable capture the upsert wrote
// (migration 0076). The three statements below run together, in this order,
// in one batch, over one scope:
//
//   ?1 book, ?2 resource, ?3..?4 chapter range, ?5 a JSON array of
//   "chapter:verse" refs or NULL for every verse in the range, ?6 the run id,
//   ?7 a stale cutoff (seconds) or NULL.
//
// Only unsettled rows are touched (prior_run set): a landed overwrite was
// settled in its CAS batch, and a non-adoption flag settles its row, so every
// row in scope holds a speculation that never landed. Of those, only rows THIS
// run owns (prior_run = ?6), or, with ?7, rows whose speculation was written
// before ?7 (last_recorded_at < ?7) by a run that must be dead by now: a
// speculation and its CAS happen within one applyVerseRows call, seconds
// apart, so a capture an hour old (the callers' cutoff) belongs to no live
// run, and undoing it cannot race that run's CAS (review A3). Callers:
// deleteLostAdoptionConflicts (step 7b, the refs whose CAS lost; no cutoff)
// and rollBackDeadAttemptConflicts (a nightly chunk step's or a UI pull's
// entry, every verse in its chapters: a dead earlier attempt of this run, or
// any dead run's stale capture).
//
// 1. RESTORE: a row that existed before the speculation and still shows it
//    (an adoption action; review A1) goes back to exactly what it said
//    before: an earlier
//    night's unreviewed adopt_conflict keeps its pointer, snapshot and alert;
//    an audit-only row promoted tonight (#1124) is audit-only again; a
//    RESOLVED row whose NULL pointer the upsert's COALESCE filled gets its
//    NULL back. resolved_at/resolved_by stay as they are now: the upsert
//    never changes them for an adoption, so a change since is a person's
//    save resolving the row, and that stands. recorded_generation is bumped
//    so a stale RESOLVE_CONVERGED_VERSE_MERGE_CONFLICT_SQL token cannot match.
// 2. DELETE: a row the speculation created (prior_json NULL): nothing existed
//    before it. A row someone resolved in the meantime is left (pre-#1132
//    behavior) and settled by 3.
// 3. SETTLE: whatever is still in scope (a resolved row 2 left) keeps its
//    current state and drops the capture.
// ---------------------------------------------------------------------------
const SPECULATION_SCOPE = `book = ?1 AND resource = ?2 AND chapter BETWEEN ?3 AND ?4
      AND (?5 IS NULL OR (chapter || ':' || verse) IN (SELECT value FROM json_each(?5)))
      AND (prior_run = ?6 OR (prior_run IS NOT NULL AND last_recorded_at < ?7))`;

export const RESTORE_SPECULATIVE_CONFLICTS_SQL = `UPDATE verse_merge_conflicts
    SET action = json_extract(prior_json, '$.action'),
        reason = json_extract(prior_json, '$.reason'),
        overwritten_version = json_extract(prior_json, '$.overwritten_version'),
        alignment = json_extract(prior_json, '$.alignment'),
        detected_at = json_extract(prior_json, '$.detected_at'),
        last_recorded_at = json_extract(prior_json, '$.last_recorded_at'),
        recorded_generation = recorded_generation + 1,
        prior_json = NULL, prior_run = NULL
  WHERE ${SPECULATION_SCOPE}
    AND prior_json IS NOT NULL
    AND action IN ${ADOPTION_ACTIONS}`;

export const DELETE_SPECULATIVE_CONFLICTS_SQL = `DELETE FROM verse_merge_conflicts
  WHERE ${SPECULATION_SCOPE}
    AND prior_json IS NULL
    AND action IN ${ADOPTION_ACTIONS}
    AND resolved_at IS NULL`;

export const SETTLE_SPECULATIVE_CONFLICTS_SQL = `UPDATE verse_merge_conflicts
    SET prior_json = NULL, prior_run = NULL
  WHERE ${SPECULATION_SCOPE}`;

// ---------------------------------------------------------------------------
// Issue #1137: settle the row of an overwrite that just landed. bookReimport.ts
// puts one of these in each master-adoption CAS batch (content and
// structure) directly after each write's changes()-gated edit_log row, so
// `changes() > 0` here means exactly "that ref's own write landed" (the gated
// log row was inserted). It runs in the same D1 transaction as the write: a
// landed overwrite and the end of its row's speculation commit together, and
// an attempt that dies right after its CAS leaves nothing for a retry to
// misread as unlanded. A reimport write that is not this adoption (a
// source-attribute reconcile, an AI reseed) never settles it (review A2: an
// edit_log lookup by version could not tell them apart). Any run's capture is
// dropped, not just this run's: once an overwrite of the verse has landed, the
// row describes a real overwrite whoever's speculation is on it.
//
// Binds, in order: (book, resource, chapter, verse).
// ---------------------------------------------------------------------------
export const SETTLE_LANDED_CONFLICT_SQL = `UPDATE verse_merge_conflicts
    SET prior_json = NULL, prior_run = NULL
  WHERE book = ?1 AND resource = ?2 AND chapter = ?3 AND verse = ?4
    AND prior_run IS NOT NULL
    AND changes() > 0`;

// ---------------------------------------------------------------------------
// verseMergeConflicts.ts's retireVerseKeptAiMasterFlags — issue #749, the verse
// analogue of #703's retireMergeKeptFlags. Retires every STANDING
// 'keep_ai_master' row: the action is no longer recorded (bookReimport.ts's
// applyVerseRows), so the rows still in the banner are pure backlog, and every
// one of them was minted under exactly the condition that retires it — a
// COMPLETE lineage walk that found no Door43 editor's commit behind master's
// side. The mint WAS the measurement, so unlike clearResolvedMergeNoBase this
// needs no re-walk and touches Door43 not at all: D1 only, one statement.
//
// It also needs no separate audit-log INSERT, which is the one place this
// deliberately differs from the TSV side (whose `sync_clear_review` edit_log row
// is the only trace a cleared review flag leaves). Here the ROW IS the audit
// trail: verse_merge_conflicts rows are never deleted, only stamped resolved
// (migration 0049), so a retired row survives with
// `resolved_at = <this run>, resolved_by = NULL`. That pair is unambiguous —
// a real human resolve always carries a non-null resolved_by (see
// RESOLVE_VERSE_MERGE_CONFLICT_SQL, bound with the saving user's id), so
// `resolved_by IS NULL AND resolved_at IS NOT NULL` reads as "system-retired"
// and can never be confused with someone's resolution.
//
// `resolved_at IS NULL` keeps it idempotent and non-destructive: a row a human
// already resolved keeps THEIR resolved_at/resolved_by, and the second night
// finds nothing (0 changes). No batching: D1 applies one UPDATE to every
// matching row in a single round trip, so unlike retireMergeKeptFlags there is
// no SELECT-then-write-in-slices to size against the 100-statement batch cap.
// `action` is not indexed (see migrations 0044/0049 — the indexes are on `book`,
// on (book, resource, chapter, verse), and the partial (book, resource) WHERE
// resolved_at IS NULL), so this scans; the table holds one row per adjudicated
// verse and the scan is a one-per-night cost, shrinking to nothing once the
// backlog is cleared.
//
// Binds, in order: (resolvedAt).
// ---------------------------------------------------------------------------
export const RETIRE_KEPT_AI_MASTER_CONFLICTS_SQL = `UPDATE verse_merge_conflicts
    SET resolved_at = ?1, resolved_by = NULL
  WHERE action = 'keep_ai_master'
    AND resolved_at IS NULL`;

// Pair-scoped retire: the same UPDATE narrowed to ONE (book, resource), so
// retireVerseKeptAiMasterFlags can batch each pair's retire atomically with
// that pair's banner clears WITHOUT one unbounded batch. A single global batch
// (retire + every pair's DELETEs) can breach D1's 100-statement cap once enough
// pairs (or per-username fan-out DELETEs) accumulate, and then fails and retries
// the same oversized batch forever (#761 Codex review, 2nd pass). Binds:
// (resolvedAt, book, resource).
export const RETIRE_KEPT_AI_MASTER_CONFLICTS_FOR_PAIR_SQL = `UPDATE verse_merge_conflicts
    SET resolved_at = ?1, resolved_by = NULL
  WHERE action = 'keep_ai_master'
    AND resolved_at IS NULL
    AND book = ?2 AND resource = ?3`;

// ---------------------------------------------------------------------------
// Issue #760 (#754 P1 follow-up). Read BEFORE RETIRE_KEPT_AI_MASTER_CONFLICTS_SQL
// runs, so retireVerseKeptAiMasterFlags knows which (book, resource) pairs it is
// about to retire rows for — the sweep is unscoped (every pair, not just the
// ones this run reimported), so a resource whose Door43 SHA didn't change this
// run never gets its "Sync flagged N verse(s)" banner re-derived by
// raiseVerseMergeConflictAlert, and the retire UPDATE alone never touches
// system_alerts. Each returned pair is a candidate for
// clearResolvedConflictBannerIfLast, which re-checks (atomically, in its own
// DELETE) whether any OTHER alertable conflict still justifies keeping the
// banner up — so a pair with a live adopt_conflict/keep_alignment_refused/
// source_attr_divergent/keep_local_structure row alongside its retired
// keep_ai_master rows correctly keeps its banner.
//
// DISTINCT, not a plain SELECT: a resource can carry many standing
// keep_ai_master rows (EZK ULT/UST alone held 37) and the caller only needs
// the (book, resource) shape once each.
// ---------------------------------------------------------------------------
export const SELECT_STANDING_KEPT_AI_MASTER_CONFLICT_PAIRS_SQL = `SELECT DISTINCT book, resource
    FROM verse_merge_conflicts
   WHERE action = 'keep_ai_master'
     AND resolved_at IS NULL`;
