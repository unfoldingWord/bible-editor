// The PATCH a tn note's "Switch to vN" (NoteHistoryDialog) sends. Kept out of
// NoteCard so the rule can be unit-tested in the strip-types runner.

import type { TnRow } from "../sync/api.ts";
import { nfc } from "./hebrew.ts";

// The fields of the chosen history version, as raw TSV-escaped strings.
export interface TnRestoreSnapshot {
  quote: string | null;
  note: string | null;
  support_reference: string | null;
  // The version's Occurrence, or null when its snapshot holds none.
  occurrence: number | null;
}

// The last server-confirmed values (NoteCard's savedRef).
export interface TnRestoreSaved {
  quote: string | null;
  note: string | null;
  support_reference: string | null;
}

// Only the fields that differ from the saved server state, so picking the
// current version somehow does not bump the version.
//
// Occurrence (#1330) is sent only when the restore also changes the quote, the
// version carries a non-null Occurrence, and it differs from the row's current
// one. Clearing a quote stores Occurrence 0 (#1329), so without it a restored
// Hebrew/Greek quote would be healed to 1 by the server's requiredOccurrence
// and anchor to the wrong copy of the word. A restore that leaves the quote
// alone must not touch Occurrence: it would undo a re-anchor by the quote
// builder (Shell.tsx, the "build from source" save), which can move only the
// occurrence. "Changes the quote" is judged on NFC with whitespace collapsed,
// because the builder writes UHB legacy combining-mark order while a stored
// quote may be NFC. Whether `quote` itself goes in the patch stays a raw-byte
// compare. The server's requiredOccurrence still has the final word if the
// pair is illegal.
export function buildTnRestorePatch(
  snap: TnRestoreSnapshot,
  saved: TnRestoreSaved,
  currentOccurrence: number | null,
): Partial<TnRow> {
  const rawQuote = snap.quote ?? "";
  const rawNote = snap.note ?? "";
  const rawSr = snap.support_reference ?? null;
  const patch: Partial<TnRow> = {};
  if (rawQuote !== (saved.quote ?? "")) patch.quote = rawQuote;
  if (rawNote !== (saved.note ?? "")) patch.note = rawNote;
  if (rawSr !== saved.support_reference) patch.support_reference = rawSr;
  if (
    "quote" in patch &&
    quoteKey(rawQuote) !== quoteKey(saved.quote ?? "") &&
    snap.occurrence != null &&
    snap.occurrence !== currentOccurrence
  ) {
    patch.occurrence = snap.occurrence;
  }
  return patch;
}

const quoteKey = (q: string) => nfc(q).replace(/\s+/g, " ").trim();
