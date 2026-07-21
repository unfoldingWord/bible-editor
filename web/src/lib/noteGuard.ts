// Guards against silently blanking a translationNote's body.
//
// Every tn note→server PATCH funnels through NoteCard.flushPending, which
// diffs local state against the last-saved row and sends `note` whenever it
// changed. Nothing stopped an empty value from winning that diff, so a stray
// select-all+delete (or any keystroke that clears the field) followed by a
// save would overwrite a substantive note with "". That "" then exports to
// DCS and fails whole-repo validation — blank rows are rejected for
// en_tn/en_tq/en_twl. See NUM 22:10 (tn id `iuqz`): a full v4 was blanked to
// v5 seventeen seconds later.
//
// The check lives here as a pure function so it can be unit-tested and shared
// by the client guard (NoteCard) and, in spirit, the API backstop.

// A note body is "blank" for save/export purposes if — after converting the
// TSV line-break escape (literal backslash-n, two chars) to a real newline —
// it trims to nothing: empty, whitespace-only, or only line breaks. All of
// those are rejected by DCS whole-repo validation.
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
