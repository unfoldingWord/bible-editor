// Pure leaf module (no Env / Hono / D1 imports) so verseMergeConflicts.test.mjs
// can run the EXACT production SQL against real SQLite without dragging in
// verses.ts's / verseMergeConflicts.ts's whole dependency graph — same reason
// blankStub.ts stands alone for blankStubTrash.test.mjs. Every statement here
// is imported by BOTH the production code and the test, so the two cannot
// silently drift apart.

// ---------------------------------------------------------------------------
// verses.ts's PATCH route, statement 1 of its `env.DB.batch([...])` array —
// the actual content write. Exported so tests can drive the exact
// version-matching / `changes()`-seeding behavior the other two statements in
// that batch depend on, without hand-copying a "simplified" stand-in that
// could drift from the real WHERE clause.
//
// Binds, in order: (contentJson, plainText, updatedAt, updatedBy, book,
// chapter, verse, bibleVersion, expectedVersion).
// ---------------------------------------------------------------------------
export const VERSE_PATCH_UPDATE_SQL = `UPDATE verses
   SET content_json = ?1, plain_text = COALESCE(?2, plain_text), version = version + 1,
       updated_at = ?3, updated_by = ?4
 WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8
   AND version = ?9`;

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
//   'keep_ai_master'         — kept D1 (nothing overwritten): both sides moved,
//                              but every commit that moved master's file since
//                              the ancestor came from our own export or the
//                              unfoldingWord bot account, so the app edit won
//                              (#540 item 2). Unlike the two above, the export —
//                              when it next runs for this resource — PUBLISHES
//                              D1 here, which is the point, so what a human is
//                              asked to check is the kept value, not a revert
//                              waiting to happen.
// A clean 'adopt' (master moved, we didn't) is deliberately EXCLUDED — it needs
// no judgement and stays in the table purely as an audit trail.
//
// Binds, in order: (book, resource).
// ---------------------------------------------------------------------------
export const SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL = `SELECT chapter, verse, action, reason, overwritten_version, alignment, detected_at
     FROM verse_merge_conflicts
    WHERE book = ?1 AND resource = ?2
      AND action IN ('adopt_conflict', 'keep_alignment_refused', 'source_attr_divergent', 'keep_ai_master')
      AND resolved_at IS NULL
    ORDER BY chapter ASC, verse ASC`;

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
// 'keep_alignment_refused' / 'keep_ai_master' reactivation carve-out at the
// bottom of the SET clause for the deliberately safe exceptions (none has a CAS
// write, so the failure mode below cannot arise for either). The first
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
// feature this table exists to support, not a bug to route around.
//
// Binds, in order: (book, resource, chapter, verse, action, reason,
// overwrittenVersion, alignmentJson, now, bibleVersion, observedVersion).
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
     (book, resource, chapter, verse, action, reason, overwritten_version, alignment, detected_at, last_recorded_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
   ON CONFLICT (book, resource, chapter, verse) DO UPDATE SET
     -- A row needing human judgement must never be DOWNGRADED by a later
     -- routine adoption — see recordVerseMergeConflicts's own doc comment for
     -- the full Night-1/Night-2 walkthrough this anti-downgrade protects.
     -- 'keep_ai_master' is deliberately NOT in this carve-out, unlike
     -- 'adopt_conflict'. The two need opposite treatment: an adopt_conflict
     -- leaves a human something to RECOVER, which a later routine adoption must
     -- not hide, whereas a keep_ai_master overwrote nothing, and a later clean
     -- 'adopt' means master's value was taken after all — the disagreement is
     -- over. Keeping it sticky would leave the banner asserting "the editor's
     -- version was kept and the export will publish it" about a verse that has
     -- since adopted master's. Nothing else un-sticks it: CONFIRM_ADOPTED_
     -- CONFLICT_SQL below matches only ('adopt','adopt_conflict').
     action = CASE
       WHEN excluded.action = 'adopt' AND verse_merge_conflicts.action = 'adopt_conflict'
       THEN verse_merge_conflicts.action
       ELSE excluded.action
     END,
     reason = CASE
       WHEN excluded.action = 'adopt' AND verse_merge_conflicts.action = 'adopt_conflict'
       THEN verse_merge_conflicts.reason
       ELSE excluded.reason
     END,
     -- KNOWN NARROWER FOLLOW-ON (flagged, deliberately not fixed here): this
     -- keeps the EARLIEST overwritten_version pointer, including across a
     -- resolve -> new-conflict cycle on the SAME verse. So a row resolved on
     -- night 1 (pointer -> v2) that gets a genuinely NEW, distinct overwrite
     -- confirmed on night 30 can still show the OLD v2 pointer rather than
     -- night 30's real overwrite, if v2 was never cleared. Only relevant
     -- across a resolve -> new-conflict cycle on the SAME verse — worth a
     -- follow-up if that combination turns out to matter in practice.
     overwritten_version = CASE
       WHEN excluded.action IN ('keep_alignment_refused', 'source_attr_divergent', 'keep_ai_master') THEN NULL
       ELSE COALESCE(verse_merge_conflicts.overwritten_version, excluded.overwritten_version)
     END,
     alignment = COALESCE(excluded.alignment, verse_merge_conflicts.alignment),
     last_recorded_at = excluded.last_recorded_at,
     -- REACTIVATION carve-out, 'source_attr_divergent', 'keep_alignment_refused',
     -- and 'keep_ai_master' ONLY. Every other action leaves
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
     -- shares the exact same no-CAS-race shape, so it gets the same carve-out.
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
       WHEN excluded.action IN ('source_attr_divergent', 'keep_alignment_refused', 'keep_ai_master')
         AND (?11 IS NULL OR ?11 = (
           SELECT version FROM verses WHERE book = ?1 AND bible_version = ?10 AND chapter = ?3 AND verse = ?4
         ))
       THEN NULL
       ELSE verse_merge_conflicts.resolved_at
     END,
     resolved_by = CASE
       WHEN excluded.action IN ('source_attr_divergent', 'keep_alignment_refused', 'keep_ai_master')
         AND (?11 IS NULL OR ?11 = (
           SELECT version FROM verses WHERE book = ?1 AND bible_version = ?10 AND chapter = ?3 AND verse = ?4
         ))
       THEN NULL
       ELSE verse_merge_conflicts.resolved_by
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
// Binds, in order: (book, resource, chapter, verse).
// ---------------------------------------------------------------------------
export const CONFIRM_ADOPTED_CONFLICT_SQL = `UPDATE verse_merge_conflicts
    SET resolved_at = NULL, resolved_by = NULL
  WHERE book = ?1 AND resource = ?2 AND chapter = ?3 AND verse = ?4
    AND action IN ('adopt', 'adopt_conflict')`;

// ---------------------------------------------------------------------------
// verseMergeConflicts.ts's deleteLostAdoptionConflicts — cleanup for a
// speculative row written BEFORE the master-adoption CAS batch (see
// bookReimport.ts step 6b/7b) whose write did NOT actually land (a human
// wrote the verse first). Scoped to `action IN ('adopt', 'adopt_conflict')`
// — a 'keep_alignment_refused' row never attempts a write, so it's never a
// candidate.
//
// `last_recorded_at = ?5` (NOT `detected_at` — see UPSERT_VERSE_MERGE_CONFLICT_SQL's
// doc comment for why the two are kept separate) narrows the delete to rows
// PROVABLY touched by THIS run's speculative upsert: a brand-new row gets
// last_recorded_at = now on INSERT, so deleting it here on a lost CAS is
// exactly the old (correct, harmless) behavior — nothing valid existed
// before it. A row that predates tonight and is CURRENTLY RESOLVED
// (resolved_at non-null, from a real prior resolution) is excluded by
// `resolved_at IS NULL` regardless of last_recorded_at — under two-phase
// reactivation its resolved_at was never touched by tonight's speculative
// upsert in the first place (see above), so this condition alone is what
// protects it; last_recorded_at no longer needs to distinguish "old" from
// "new" for that case. A row that predates tonight and is CURRENTLY ACTIVE
// (never resolved) still gets deleted on a lost CAS — matching this
// cleanup's ORIGINAL, pre-review behavior for that case (it was never
// specially protected, and the two-phase design doesn't change that).
//
// Binds, in order: (book, resource, chapter, verse, lastRecordedAt).
// ---------------------------------------------------------------------------
export const DELETE_LOST_ADOPTION_CONFLICT_SQL = `DELETE FROM verse_merge_conflicts
    WHERE book = ?1 AND resource = ?2 AND chapter = ?3 AND verse = ?4
      AND action IN ('adopt', 'adopt_conflict')
      AND resolved_at IS NULL
      AND last_recorded_at = ?5`;
