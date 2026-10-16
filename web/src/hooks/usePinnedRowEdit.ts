import { useEffect, useMemo, useState } from "react";
import { drafts, rowKey } from "../sync/drafts";
import type { RowKind } from "../sync/api";
import { onOutboxDiscard, onOutboxResult, type OutboxOp } from "../sync/outbox";
import {
  rebaseRowPin,
  rowPinBaseline,
  rowPinDiff,
  rowSaveInFlight,
  type RowFields,
  type RowPin,
  type RowSubmission,
} from "../sync/rowEditPin";

// What a tq/twl row passes to its save callback (#1115): the pin's version as
// If-Match and the pin's raw values as the conflict baseline.
export interface PinnedSaveOpts {
  expectedVersion: number;
  baseline: Record<string, unknown>;
  restoredFromVersion?: number;
}

type RowLike = {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  version: number;
};

// Local edit state of one tq/twl row, compared against a pin (see
// rowEditPin.ts) instead of the optimistic cached row, and kept in the draft
// store with that pin so a remount restores both the typing and the version
// it was typed against.
export function usePinnedRowEdit<R extends RowLike, F extends RowFields>(args: {
  kind: Extract<RowKind, "tq" | "twl">;
  row: R;
  keys: readonly (keyof F & string)[];
  shownOf: (raw: Record<string, unknown>) => F;
  locked: boolean;
  onSave: (patch: Partial<F>, opts: PinnedSaveOpts) => void;
}) {
  const { kind, row, keys, shownOf, locked, onSave } = args;
  const rowRecord = row as unknown as Record<string, unknown>;
  const pinOfRow = (): RowPin<F> => {
    const raw: Record<string, unknown> = {};
    for (const k of keys) raw[k] = rowRecord[k];
    return { version: row.version, shown: shownOf(raw), raw };
  };
  const rowPin = pinOfRow();

  const [pin, setPin] = useState<RowPin<F>>(rowPin);
  const [local, setLocal] = useState<F>(rowPin.shown);
  const [submitted, setSubmitted] = useState<RowSubmission | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // A save of this row refused (chapter locked) or discarded is no longer in
  // flight, whether or not Shell's cache rollback lands (offline, navigated
  // away, another save queued, or the server already holds the text).
  useEffect(() => {
    const mine = (op: OutboxOp) =>
      op.action === "patch" &&
      op.target.kind === "row" &&
      op.target.rowKind === kind &&
      op.target.id === row.id &&
      op.target.book === row.book;
    const settle = () => setSubmitted((s) => (s && !s.settled ? { ...s, settled: true } : s));
    const offResult = onOutboxResult((op, result) => {
      if (result.kind === "locked" && mine(op)) settle();
    });
    const offDiscard = onOutboxDiscard((op) => {
      if (mine(op)) settle();
    });
    return () => {
      offResult();
      offDiscard();
    };
  }, [kind, row.id, row.book]);

  // Follow the server when the cached row's version moves, but only where it
  // cannot overwrite kept typing (rebaseRowPin). Adjusted during render so no
  // frame diffs against a stale pin.
  if (hydrated) {
    const next = rebaseRowPin({ pin, row: rowPin, local, submitted, keys });
    if (next) {
      setPin(next.pin);
      setLocal(next.local);
    }
  }

  const draftKey = useMemo(() => rowKey(kind, row.book, row.id), [kind, row.book, row.id]);

  // Restore unsaved typing and the pin it was typed against. Draft writes wait
  // for this, so a write can never persist a baseline taken from a cache that
  // still holds refused text.
  useEffect(() => {
    let live = true;
    drafts
      .get(draftKey)
      .then((rec) => {
        if (!live) return;
        const payload = rec?.payload as
          | { patch?: Partial<F>; baseline?: Record<string, unknown> }
          | undefined;
        const patch = payload?.patch;
        if (patch) {
          // Drafts written before #1115 carry no baseline: pin to the row.
          const base = payload?.baseline && rec ? payload.baseline : null;
          const nextPin = base
            ? { version: rec!.expectedVersion, raw: base, shown: shownOf(base) }
            : pinOfRow();
          setPin(nextPin);
          setLocal({ ...nextPin.shown, ...patch });
        }
        setHydrated(true);
      })
      .catch(() => {
        if (live) setHydrated(true);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const diff = useMemo(() => rowPinDiff(pin, local, keys), [pin, local, keys]);
  const isDirty = Object.keys(diff).length > 0;
  const saving = rowSaveInFlight({ pin, row: rowPin, local, submitted, keys });

  useEffect(() => {
    if (!hydrated || locked) return;
    if (isDirty) {
      void drafts.set(draftKey, { patch: diff, baseline: pin.raw }, pin.version, {
        kind: "row",
        rowKind: kind,
        id: row.id,
        book: row.book,
        chapter: row.chapter,
        verse: row.verse,
      });
    } else {
      void drafts.clear(draftKey);
    }
  }, [hydrated, locked, isDirty, diff, pin, draftKey, kind, row.id, row.book, row.chapter, row.verse]);

  // The one way this row sends a PATCH (Save button, history restore).
  // `next` replaces local fields first; `only` limits the patch to some keys.
  const submit = (
    next?: Partial<F>,
    opts?: { only?: readonly (keyof F & string)[]; restoredFromVersion?: number },
  ) => {
    if (saving || locked) return;
    const nextLocal = next ? { ...local, ...next } : local;
    if (next) setLocal(nextLocal);
    const all = rowPinDiff(pin, nextLocal, keys);
    const patch: Partial<F> = {};
    for (const k of opts?.only ?? keys) if (k in all) patch[k] = all[k];
    if (Object.keys(patch).length === 0) return;
    setSubmitted({ version: pin.version, rowVersion: row.version, shown: patch as RowFields });
    onSave(patch, {
      expectedVersion: pin.version,
      baseline: rowPinBaseline(pin, patch),
      ...(opts?.restoredFromVersion !== undefined
        ? { restoredFromVersion: opts.restoredFromVersion }
        : {}),
    });
  };

  // Discard unsaved typing: back to the server text the pin holds. The draft
  // effect clears the draft once nothing differs. Forgetting the submission
  // lets a pin older than the cached row follow it on the next render.
  const undo = () => {
    if (saving) return;
    setSubmitted(null);
    setLocal(pin.shown);
  };

  const setField = <K extends keyof F & string>(k: K, v: F[K]) =>
    setLocal((prev) => ({ ...prev, [k]: v }));

  return { local, setField, diff, isDirty, saving, submit, undo, pin, hydrated };
}
