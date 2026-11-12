import { RowHistoryDialog } from "./RowHistoryDialog";
import { TN_HISTORY_FIELDS, type RowSnapshot } from "./rowHistoryFields";

interface NoteSnapshot {
  quote: string | null;
  note: string | null;
  support_reference: string | null;
  // Not a history lane: carried so restoring a quote can bring back its
  // Occurrence (#1330). Null when the snapshot holds no integer.
  occurrence: number | null;
}

interface Props {
  open: boolean;
  noteId: string;
  book: string;
  currentVersion: number;
  effectiveVersion: number;
  onClose: () => void;
  onUseVersion: (snapshot: NoteSnapshot, fromVersion: number) => void;
}

// tn preset over the kind-agnostic dialog. The fields it shows are exactly
// the three a NoteCard can edit — see RowHistoryDialog for the mechanics.
// Occurrence rides along unshown; buildTnRestorePatch decides when it is sent.
export function NoteHistoryDialog({
  open,
  noteId,
  book,
  currentVersion,
  effectiveVersion,
  onClose,
  onUseVersion,
}: Props) {
  return (
    <RowHistoryDialog
      open={open}
      kind="tn"
      rowId={noteId}
      book={book}
      fields={TN_HISTORY_FIELDS}
      title="Note history"
      currentVersion={currentVersion}
      effectiveVersion={effectiveVersion}
      onClose={onClose}
      onUseVersion={(snapshot: RowSnapshot, fromVersion, fullSnapshot) =>
        onUseVersion(
          {
            quote: snapshot.quote ?? null,
            note: snapshot.note ?? null,
            support_reference: snapshot.support_reference ?? null,
            occurrence: Number.isInteger(fullSnapshot.occurrence)
              ? (fullSnapshot.occurrence as number)
              : null,
          },
          fromVersion,
        )
      }
    />
  );
}
