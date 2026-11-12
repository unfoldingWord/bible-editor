// The PATCH a tn "use this version" restore sends. React-free so the
// strip-types test runner can load it (tnRestorePatch.test.mjs).

export interface TnRestoreSnapshot {
  quote: string | null;
  note: string | null;
  support_reference: string | null;
  // Not shown in the history dialog, only carried so a restored quote keeps
  // the Occurrence it had (#1330). Null when the snapshot holds none.
  occurrence?: number | null;
}

export interface TnRestoreSaved {
  quote: string | null;
  note: string | null;
  support_reference: string | null;
}

export interface TnRestorePatch {
  quote?: string;
  note?: string;
  support_reference?: string | null;
  occurrence?: number;
}

// A history snapshot's value is untyped JSON from edit_log. Only an integer is
// an occurrence; the PATCH schema (z.number().int()) would reject anything else.
export function snapshotOccurrence(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) ? raw : null;
}

// Only fields that differ from the saved server state, so picking the content
// the row already holds sends nothing and burns no version.
//
// Occurrence goes along only when the quote changes (#1330). Clearing a quote
// stores Occurrence 0 (#1329); a restore that brought back only the quote then
// let the server's requiredOccurrence turn 0 into 1, moving a note that pointed
// at the 2nd copy of a word onto the 1st. A restore that leaves the quote alone
// sends no occurrence, so it cannot undo an occurrence-only repair made after
// the restored version. It is sent even when the cached row already shows the
// same value: the cache can lag the server (a quote-clear still in flight), and
// a repeated value is harmless. The server's requiredOccurrence still has the
// final word.
export function tnRestorePatch(snap: TnRestoreSnapshot, saved: TnRestoreSaved): TnRestorePatch {
  const rawQuote = snap.quote ?? "";
  const rawNote = snap.note ?? "";
  const rawSr = snap.support_reference ?? null;
  const patch: TnRestorePatch = {};
  if (rawQuote !== (saved.quote ?? "")) patch.quote = rawQuote;
  if (rawNote !== (saved.note ?? "")) patch.note = rawNote;
  if (rawSr !== saved.support_reference) patch.support_reference = rawSr;
  if ("quote" in patch && snap.occurrence != null) patch.occurrence = snap.occurrence;
  return patch;
}
