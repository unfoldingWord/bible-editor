// Pure leaf module (no Env / Hono / D1 imports) so blankStubTrash.test.mjs can
// import the clause without dragging in rows.ts's whole dependency graph —
// same reason rowId.ts stands alone.

// Extra WHERE clause for the auto-discard of an abandoned blank note stub.
//
// "Add note" POSTs note:"" on purpose, to mint an empty stub for the translator
// to type into, so neither blank-note guard can fire on create — both are scoped
// to a non-empty -> empty PATCH. The client therefore discards a stub it finds
// still empty on deactivation (see NoteCard's discard effect and
// isAbandonedBlankStub in web/src/lib/noteGuard.ts).
//
// But the client decides from its CACHED copy of the row. If another tab or
// collaborator fills the stub in between, an unconditional trash would bin a
// now-substantive note, and the nightly job would promote that to a permanent
// deleted_at tombstone. So the server re-asserts the whole predicate inside the
// UPDATE, where SQLite evaluates it atomically against the current row; a no-op
// result becomes a 409 rather than a false success.
//
// Mirrors isAbandonedBlankStub in web/src/lib/noteGuard.ts — keep the two in
// sync. TRIM(REPLACE(...)) is the SQL equivalent of isBlankNoteText: notes store
// line breaks as a literal backslash-n (TSV escape), so strip those before
// trimming, or a note of "\n" would read as substantive.
//
// Deliberately NOT applied to the manual delete button's path: that one must be
// able to trash a note that has text.
export const BLANK_STUB_CLAUSE = `
  AND version = 1
  AND updated_by IS NOT NULL
  AND trashed_at IS NULL
  AND preserve = 0
  AND hint = 0
  AND occurrence IS NULL
  AND TRIM(COALESCE(tags, '')) = ''
  AND TRIM(REPLACE(COALESCE(note, ''), '\\n', '')) = ''
  AND TRIM(REPLACE(COALESCE(quote, ''), '\\n', '')) = ''
  AND TRIM(REPLACE(COALESCE(support_reference, ''), '\\n', '')) = ''`;
