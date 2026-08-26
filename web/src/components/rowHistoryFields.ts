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
// "Live" is read off the FETCHED list — the last entry, since the endpoint
// orders ascending by version and always keeps the current row's own entry —
// and never off a caller-supplied version. The caller's is the client's cached
// row.version, which lags the server whenever another translator's write has
// landed but its fanout has not been applied yet (and briefly on this client's
// own restore, which sets restored_from_version optimistically without bumping
// the version). Keying on that lagging number leaves the real live restore
// eligible, so the dialog opens on it, calls it "Switch to vN", and a click
// PATCHes with a stale If-Match — a 409 and a merge prompt over content that
// never differed. The fetched list cannot disagree with itself that way.
export function defaultPreviousHistoryVersion(
  versions: HistoryVersionCandidate[],
  effectiveVersion: number,
): number | null {
  const live = versions.at(-1);
  const candidates =
    live && live.restored_from_version != null ? versions.slice(0, -1) : versions;
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
