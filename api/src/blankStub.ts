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
// sync.
//
// `isBlank` below is the SQL equivalent of isBlankNoteText. Two wrinkles:
//
//  - Notes store line breaks as a literal backslash-n (the TSV escape, two
//    characters), so strip those first or a note of "\n" reads as substantive.
//    In this TS template literal '\\n' produces backslash+n, and SQLite string
//    literals do not process backslash escapes, so REPLACE sees the two
//    characters we want. blankStubTrash.test.mjs pins this against real SQLite.
//
//  - SQLite's TRIM() strips ONLY U+0020 spaces, whereas JS .trim() also strips
//    tabs, real newlines, CR and NBSP. Left as a bare TRIM, a stub whose note
//    was a tab or a real newline would read blank to the client (which fires the
//    discard) but substantive to this clause (which refuses), so the discard
//    would 409 forever and the stub would never go away. Fail-safe rather than
//    destructive, but it defeats the purpose, so normalise those characters too.
//    char(9)=tab, char(10)=LF, char(13)=CR, char(160)=NBSP.
//
// Deliberately NOT applied to the manual delete button's path: that one must be
// able to trash a note that has text.
const isBlank = (col: string) => `TRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
    COALESCE(${col}, ''), '\\n', ''), char(9), ''), char(10), ''), char(13), ''), char(160), '')) = ''`;

// `userParam` is the bind position holding the CALLER's user id, and the
// ownership check it feeds is a data-loss guard, not bookkeeping.
//
// `updated_by IS NOT NULL` alone only proves "some editor created this", which
// is enough to protect the 11 genuine upstream empties but NOT enough to stop a
// cross-user delete: editor A creates a stub and starts typing without saving,
// so the row is still blank in D1 while A's text sits in A's local state and
// A's own IndexedDB draft. If editor B then activates that card and clicks
// away, B's client asks to discard it and every other clause here passes — the
// row really is blank. Requiring `updated_by = <caller>` means B's request
// no-ops into a 409 instead of binning A's note (which the nightly job would
// then promote to a permanent tombstone). Only the row's own author can discard
// their abandoned stub.
export const blankStubClause = (userParam: number) => `
  AND version = 1
  AND updated_by IS NOT NULL
  AND updated_by = ?${userParam}
  AND trashed_at IS NULL
  AND preserve = 0
  AND hint = 0
  AND occurrence IS NULL
  AND ${isBlank("tags")}
  AND ${isBlank("note")}
  AND ${isBlank("quote")}
  AND ${isBlank("support_reference")}`;
