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
// verseMergeConflicts.ts's recordVerseMergeConflicts — the nightly-sync
// upsert. ON CONFLICT DO UPDATE, NOT INSERT OR REPLACE (see that function's
// doc comment for why REPLACE's delete-then-reinsert would break
// `detected_at`'s "how long has this been unresolved" meaning).
//
// resolved_at/resolved_by are RESET TO NULL unconditionally on every DO
// UPDATE (2026-08-14 six-angle review fix, DEFECT: "re-detection
// invisibility"). Before this, a verse that was flagged, human-resolved, and
// then genuinely conflicted AGAIN on a later night stayed `resolved_at`
// non-null forever — both `raiseVerseMergeConflictAlert`'s banner query and
// GET /api/verse-merge-conflicts/:book filter `resolved_at IS NULL`, so the
// brand-new conflict was permanently invisible to every reader. Resetting
// unconditionally is safe: for a row that was never resolved (the common
// case), resolved_at is already NULL, so this is a no-op.
//
// detected_at is bound to an explicit caller-supplied timestamp (`now`, NOT
// SQL's `unixepoch()`) precisely so deleteLostAdoptionConflicts — called
// later in the SAME reimport run — can compare it for exact equality (two
// separate `unixepoch()` evaluations could tick over a second apart if I/O
// happens in between, which it does: the master-adoption CAS write batch
// runs between this insert and that cleanup). detected_at is NOT reset on an
// ordinary DO UPDATE (it's absent from the SET list, so SQLite leaves it at
// its stored value) — that preserves "how long has this been sitting
// unresolved" for a conflict that keeps re-detecting night after night
// without ever landing or being resolved. See deleteLostAdoptionConflicts's
// doc comment for how this interacts with its cleanup scoping.
//
// KNOWN NARROWER FOLLOW-ON (flagged, deliberately NOT fixed here — scope was
// "make the reactivated row visible again", not "re-derive its pointer"):
// `overwritten_version`'s CASE still applies the pre-existing "keep the
// EARLIEST pointer" rule (COALESCE onto the stored value if non-null)
// unconditionally, including across a resolved -> reactivated transition. So
// a row resolved on night 1 (pointer -> v2) that gets a genuinely NEW,
// distinct overwrite on night 30 will surface as active again (this fix) but
// can still show the OLD v2 pointer rather than night 30's real overwrite,
// if v2 was never cleared. Same caveat applies to `action`/`reason`'s
// anti-downgrade CASE, which can keep a stale pre-resolution action label.
// Only relevant across a resolve -> new-conflict cycle on the SAME verse —
// worth a follow-up if that combination turns out to matter in practice.
//
// Binds, in order: (book, resource, chapter, verse, action, reason,
// overwrittenVersion, alignmentJson, detectedAt).
// ---------------------------------------------------------------------------
export const UPSERT_VERSE_MERGE_CONFLICT_SQL = `INSERT INTO verse_merge_conflicts
     (book, resource, chapter, verse, action, reason, overwritten_version, alignment, detected_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
   ON CONFLICT (book, resource, chapter, verse) DO UPDATE SET
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
     overwritten_version = CASE
       WHEN excluded.action = 'keep_alignment_refused' THEN NULL
       ELSE COALESCE(verse_merge_conflicts.overwritten_version, excluded.overwritten_version)
     END,
     alignment = COALESCE(excluded.alignment, verse_merge_conflicts.alignment),
     resolved_at = NULL,
     resolved_by = NULL`;

// ---------------------------------------------------------------------------
// verseMergeConflicts.ts's deleteLostAdoptionConflicts — cleanup for a
// speculative row written BEFORE the master-adoption CAS batch (see
// bookReimport.ts step 6b/7b) whose write did NOT actually land (a human
// wrote the verse first). Scoped to `action IN ('adopt', 'adopt_conflict')`
// — a 'keep_alignment_refused' row never attempts a write, so it's never a
// candidate.
//
// `detected_at = ?5 AND resolved_at IS NULL` (2026-08-14 six-angle review
// fix, DEFECT: "lost-adoption cleanup destroying audit rows"): the OLD
// unconditional delete removed the row outright regardless of what history
// it held. Combined with the upsert now RESETTING resolved_at/resolved_by
// (see UPSERT_VERSE_MERGE_CONFLICT_SQL above), a row that already carried a
// real, human-resolved conflict from a PRIOR night could get speculatively
// touched by tonight's upsert and then wholesale deleted here — erasing that
// old resolved_by/overwritten_version audit trail even though nothing about
// it was actually false, just because THIS run's separate, later attempt
// happened to lose its CAS race.
//
// `detected_at = ?5` (the same caller-supplied `now` passed to this run's
// recordVerseMergeConflicts call) narrows the delete to rows that are
// PROVABLY new-or-reactivated-tonight: a brand-new row gets detected_at = now
// on INSERT, so deleting it here is exactly the old (correct, harmless)
// behavior. A row that predates tonight — whether still-unresolved from a
// prior night (detected_at preserved unchanged by the DO UPDATE) or resolved
// from a prior night (also preserved, since resetting resolved_at does not
// touch detected_at) — keeps its OLD detected_at, so it will NOT match `now`
// and is left alone: its prior state (including any resolved_by /
// overwritten_version) survives.
//
// RESIDUAL EDGE (documented, not fully closed — the "simplest acceptable"
// fix per the review that requested this): a row that was genuinely resolved
// on some earlier night, and then reactivated on THIS SAME night because a
// fresh, distinct conflict was detected (a different divergence than the one
// that was resolved), gets detected_at reset to... no — detected_at is NOT
// reset on reactivation either (see UPSERT_VERSE_MERGE_CONFLICT_SQL), so this
// specific row is NOT newly-detected-at-`now` and will correctly survive this
// delete too. The one case this does NOT protect is a row that is
// GENUINELY brand-new tonight (first-ever conflict for this verse) whose
// speculative adopt attempt then loses its CAS race in the SAME run — that
// row is correctly deleted (nothing valid existed before it), matching the
// pre-fix behavior exactly, so there is no known remaining data-loss window
// as of this comment. If future changes make detected_at mutable on
// reactivation, re-examine this scoping.
//
// Binds, in order: (book, resource, chapter, verse, detectedAt).
// ---------------------------------------------------------------------------
export const DELETE_LOST_ADOPTION_CONFLICT_SQL = `DELETE FROM verse_merge_conflicts
    WHERE book = ?1 AND resource = ?2 AND chapter = ?3 AND verse = ?4
      AND action IN ('adopt', 'adopt_conflict')
      AND resolved_at IS NULL
      AND detected_at = ?5`;
