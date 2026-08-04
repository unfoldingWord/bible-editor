// Guards against silently blanking a translationNote's body.
//
// Every tn note→server PATCH funnels through NoteCard.flushPending, which
// diffs local state against the last-saved row and sends `note` whenever it
// changed. Nothing stopped an empty value from winning that diff, so a stray
// select-all+delete (or any keystroke that clears the field) followed by a
// save would overwrite a substantive note with "". That "" then exports to DCS
// and PUBLISHES: the validator warns ("Note column cannot be blank" at
// severity="warning") but exits 0, so nothing downstream stops it. That is why
// this guard is the real protection — the loss is silent and permanent. See
// NUM 22:10 (tn id `iuqz`): a full v4 was blanked to v5 seventeen seconds later.
//
// The check lives here as a pure function so it can be unit-tested and shared
// by the client guard (NoteCard) and, in spirit, the API backstop.

// A note body is "blank" for save/export purposes if — after converting the
// TSV line-break escape (literal backslash-n, two chars) to a real newline —
// it trims to nothing: empty, whitespace-only, or only line breaks. All of
// those publish to Door43 as an empty Note column (DCS warns, does not block).
export function isBlankNoteText(note: string | null | undefined): boolean {
  return (note ?? "").replace(/\\n/g, "\n").trim() === "";
}

// True when persisting `nextNote` would blank out a note that previously held
// substantive text — the silent-data-loss transition we refuse to save. A
// note that was already blank (new stub, imported empty) going to blank is not
// data loss, so it returns false; the caller (or a real delete) handles those.
export function wouldBlankExistingNote(
  savedNote: string | null | undefined,
  nextNote: string | null | undefined,
): boolean {
  return !isBlankNoteText(savedNote) && isBlankNoteText(nextNote);
}

// ---------- abandoned blank stubs ----------
//
// wouldBlankExistingNote above cannot fire on a brand-new note: it requires a
// previously non-blank saved value, and "Add note" deliberately POSTs
// `note: ""` to mint an empty stub for the user to type into (Shell's
// onNoteCreate / onNoteInsertAfter). The API create route accepts that by
// design, so neither guard covers the row that is created blank and then never
// filled — the translator clicks Add note, gets distracted, and clicks away.
// Prod D1 carries two such rows (JER 36:21 `fa9t`, 36:24 `c3u7`, created
// 2026-07-27/28, absent from en_tn master entirely), plus eight ECC rows that
// predate the blanking guards.
//
// The fix is to discard the stub when the user leaves it, rather than to refuse
// the create. This predicate decides whether that discard is safe.

// The subset of a TnRow the stub check reads. Declared structurally so the
// unit test can build a plain literal without importing the full row type.
export interface BlankStubRow {
  version: number;
  updated_by: number | null;
  note: string | null;
  quote: string | null;
  support_reference: string | null;
  tags: string | null;
  occurrence: number | null;
  trashed_at: number | null;
  preserve: 0 | 1;
  hint: 0 | 1;
}

// What the card currently holds, which can differ from the row: a draft
// restored from IndexedDB lands in local state without touching the server row.
export interface BlankStubLocalState {
  note: string;
  quote: string;
  supportRef: string | null;
  // False until the on-mount draft lookup resolves. Before that, local state is
  // empty because we have not read the draft yet, NOT because the card is
  // empty — discarding then would destroy unsaved typing. Never skip this.
  hydrated: boolean;
}

// True when this row is an app-created stub that is still completely empty and
// carries nothing the user could lose, so trashing it on deactivation is a
// no-op for content and reversible via the trash/restore UI.
//
// Every clause exists to protect something specific:
//  - hydrated .......... a draft may hold unsaved text we have not read yet
//  - version === 1 ..... a row edited even once is the user's, not a stub
//  - updated_by !== null a NULL updater means an upstream import, not our app.
//                        Prod has 11 genuine upstream empties (2CH/JER) that
//                        exist on master and must be left exactly alone.
//  - preserve / hint ... an explicit "keep this" bit; a hint is an intentionally
//                        empty stub queued for the next AI pipeline run
//  - trashed_at ........ already gone; nothing to do
//  - every content field blank, in BOTH the row and the card, so a quote picked
//    or a support reference chosen (but body not yet typed) still blocks it
export function isAbandonedBlankStub(
  row: BlankStubRow,
  local: BlankStubLocalState,
): boolean {
  if (!local.hydrated) return false;
  if (row.trashed_at !== null) return false;
  if (row.version !== 1) return false;
  if (row.updated_by === null) return false;
  if (row.preserve === 1 || row.hint === 1) return false;
  if (row.occurrence !== null) return false;
  if (!isBlankNoteText(row.tags)) return false;
  const rowEmpty =
    isBlankNoteText(row.note) &&
    isBlankNoteText(row.quote) &&
    isBlankNoteText(row.support_reference);
  const localEmpty =
    isBlankNoteText(local.note) &&
    isBlankNoteText(local.quote) &&
    isBlankNoteText(local.supportRef);
  return rowEmpty && localEmpty;
}
