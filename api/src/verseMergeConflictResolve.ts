// Pure leaf module (no Env / Hono / D1 imports) so verseMergeConflicts.test.mjs
// can run the exact resolve-clause SQL against real SQLite without dragging in
// verses.ts's whole dependency graph — same reason blankStub.ts stands alone
// for blankStubTrash.test.mjs.
//
// The statement verses.ts's PATCH route runs, as the 3rd element of its
// `env.DB.batch([...])` array, when a human saves a verse that has an
// unresolved verse_merge_conflicts row (see verses.ts's PATCH handler and
// verseMergeConflicts.ts's header comment). Marks resolved_at/resolved_by
// instead of the old DELETE — migration 0047 — so the row (and its
// overwritten_version recovery pointer) survives for the audit trail while
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
export const RESOLVE_VERSE_MERGE_CONFLICT_SQL = `UPDATE verse_merge_conflicts
    SET resolved_at = ?1, resolved_by = ?2
  WHERE book = ?3 AND resource = ?4 AND chapter = ?5 AND verse = ?6
    AND resolved_at IS NULL
    AND changes() > 0`;
