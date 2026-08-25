// Field specs for RowHistoryDialog, kept in their own module so a caller can
// name the fields it wants without statically importing the dialog — which
// would defeat the lazy() split and pull the dialog into the initial chunk.

// A snapshot is just the subset of row columns the dialog shows and can
// restore — keyed by column name so the dialog stays kind-agnostic.
export type RowSnapshot = Record<string, string | null>;

export interface HistoryFieldSpec {
  // Row column name; must be one of the server's HISTORY_FIELDS for the kind
  // (see api/src/rows.ts) or the snapshot will always read empty.
  key: string;
  label: string;
  // Hebrew/Greek quote lanes render right-to-left in a serif Hebrew stack.
  rtl?: boolean;
  // Skip the TSV `\n` → newline unescape on display. Set for fields that are
  // single-line identifiers (rc:// links), where a literal backslash-n is part
  // of the value rather than an escaped break.
  raw?: boolean;
  // Draws a rule above this field, separating the short metadata lanes from
  // the long prose ones.
  dividerBefore?: boolean;
}

// Field sets mirror what each editor actually lets a user change, so a
// restore never resurrects a column the UI can't otherwise touch.
export const TN_HISTORY_FIELDS: HistoryFieldSpec[] = [
  { key: "support_reference", label: "Support ref", raw: true },
  { key: "quote", label: "Quote", rtl: true },
  { key: "note", label: "Note", dividerBefore: true },
];

export const TQ_HISTORY_FIELDS: HistoryFieldSpec[] = [
  { key: "question", label: "Question" },
  { key: "response", label: "Response", dividerBefore: true },
];

// Minimal shape for picking the history dialog's default "previous" version.
// Kept here (not in the dialog) so the selection rule can be unit-tested
// without pulling React/MUI into the strip-types runner (issue #623).
export interface HistoryVersionCandidate {
  version: number;
  restored_from_version: number | null;
}

// Default selection: the most recent entry that answers "what was here before
// this one". The live restore entry is excluded from THIS choice only — its
// snapshot is by definition the content the row already holds, so opening on
// it shows an empty diff. Older restores stay eligible: after restore-then-
// edit, the state immediately before the edit IS that restore entry, and
// excluding every restore (the pre-#623 rule) skipped it and landed on a
// baseline the row never held as its prior content.
export function defaultPreviousHistoryVersion(
  versions: HistoryVersionCandidate[],
  currentVersion: number,
  effectiveVersion: number,
): number | null {
  const candidates = versions.filter(
    (v) => v.restored_from_version == null || v.version !== currentVersion,
  );
  const previous = [...candidates]
    .reverse()
    .find((v) => v.version !== effectiveVersion);
  return (
    previous?.version ??
    candidates.at(-1)?.version ??
    versions.at(-1)?.version ??
    null
  );
}
