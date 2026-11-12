// The PATCH a tn note's "Switch to vN" (NoteHistoryDialog) sends. Kept out of
// NoteCard so the rule can be unit-tested in the strip-types runner.

import type { TnRow } from "../sync/api.ts";

// The fields of the chosen history version, as raw TSV-escaped strings.
export interface TnRestoreSnapshot {
  quote: string | null;
  note: string | null;
  support_reference: string | null;
}

// The last server-confirmed values (NoteCard's savedRef).
export interface TnRestoreSaved {
  quote: string | null;
  note: string | null;
  support_reference: string | null;
}

// Only the fields that differ from the saved server state, so picking the
// current version somehow does not bump the version.
export function buildTnRestorePatch(
  snap: TnRestoreSnapshot,
  saved: TnRestoreSaved,
): Partial<TnRow> {
  const rawQuote = snap.quote ?? "";
  const rawNote = snap.note ?? "";
  const rawSr = snap.support_reference ?? null;
  const patch: Partial<TnRow> = {};
  if (rawQuote !== (saved.quote ?? "")) patch.quote = rawQuote;
  if (rawNote !== (saved.note ?? "")) patch.note = rawNote;
  if (rawSr !== saved.support_reference) patch.support_reference = rawSr;
  return patch;
}
