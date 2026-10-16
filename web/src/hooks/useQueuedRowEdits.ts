import { useEffect, useState } from "react";
import { outbox } from "../sync/outbox";
import { queuedKeptEditIds } from "../sync/rowEditBaseline";

// #1115: which rows of `rowKind` have an edit save still in the outbox, and a
// count of outbox snapshots seen, for the Save/Undo gate (saveGateClosed in
// rowEditBaseline.ts). The outbox notifies only its own tab, but a tab whose
// ops another tab is draining retries the drain lock every 3 s and notifies
// after each try, so a save drained elsewhere still releases the gate.
export function useQueuedRowEdits(rowKind: "tq" | "twl"): { ids: ReadonlySet<string>; seq: number } {
  const [state, setState] = useState<{ key: string; ids: ReadonlySet<string>; seq: number }>(() => ({
    key: "",
    ids: new Set(),
    seq: 0,
  }));
  useEffect(
    () =>
      outbox.subscribe((ops) => {
        const ids = queuedKeptEditIds(ops, rowKind);
        const key = ids.join(",");
        setState((prev) => ({ key, ids: key === prev.key ? prev.ids : new Set(ids), seq: prev.seq + 1 }));
      }),
    [rowKind],
  );
  return state;
}
