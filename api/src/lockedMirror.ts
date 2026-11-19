// Issue #1418 (Benjamin's option A): for a LOCKED book, Door43 master is the
// master. The nightly sync makes the book's tn/tq/twl rows in D1 an exact copy
// of master's file (text, order, additions, deletions), with one exception: a
// row a person changed in Bible Editor after the last confirmed push (an
// unlock -> edit -> lock & push still waiting to merge) is kept and flagged
// `mirror_kept`, so a pending fix is never wiped.
//
// This module is the pure plan: master's whole file and every D1 row for the
// (book, kind), tombstones included, in; the writes that make D1 equal master
// out. bookReimport.ts (mirrorLockedTsv) reads D1, decides which rows are
// pending, and applies the plan. Keeping the decision pure keeps it testable
// without a database, the same split as tsvVerseOrder.ts.
//
// Why a separate pass instead of more branches in applyTsvRows: the ordinary
// three-way merge (and its gates) runs first and stays exactly as it was for
// every book. The mirror only reconciles what that merge leaves different on a
// locked book: chapters the diff gate skipped because only order changed
// (#1411), rows Door43 deleted that the prune will not touch because a person
// once edited them (#1415), and edited rows the merge kept or flagged.

export const MIRROR_KEPT = "mirror_kept";

/** One row of master's file, in file order. `sig` is tsvRowSignature. */
export interface MirrorMasterRow {
  id: string;
  chapter: number;
  verse: number;
  sig: string;
}

/** One D1 row (any state) for the same (book, kind). */
export interface MirrorStoredRow {
  id: string;
  chapter: number;
  verse: number;
  sig: string;
  sort_order: number | null;
  /** deleted_at set, or (tn) trashed_at set: not exported. */
  removed: boolean;
  /** A person (or the AI) changed this row in Bible Editor after the last confirmed push. */
  pending: boolean;
  review_kind: string | null;
}

export type MirrorKeepReason = "edited" | "not_on_door43" | "deleted_in_app";

export interface LockedMirrorPlan {
  /** Existing ids to set to master's content (live or tombstoned). */
  write: string[];
  /** Master ids D1 has no row for. */
  insert: string[];
  /** Live, not-pending ids master no longer carries. */
  remove: string[];
  /** Pending rows that differ from master: kept as they are. */
  keep: Array<{ id: string; reason: MirrorKeepReason }>;
  /** Rows carrying a mirror_kept flag that now agree with master (or are being written). */
  clearFlag: string[];
  /** Final sort_order for every id whose number changes, inserts included. */
  sortOrder: Map<string, number>;
}

const verseKey = (chapter: number, verse: number) => `${chapter}:${verse}`;

function byStoredOrder(a: { sort_order: number | null; id: string }, b: { sort_order: number | null; id: string }): number {
  const an = a.sort_order == null;
  const bn = b.sort_order == null;
  if (an !== bn) return an ? 1 : -1;
  if (!an && a.sort_order !== b.sort_order) return (a.sort_order as number) - (b.sort_order as number);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * `mirrorOrder`: tn and tq take master's file order. twl does not: its order is
 * owned by canonicalizeTwlOrder (computed from the ULT alignment), and copying
 * master's order would only make the two writers undo each other every night.
 * A twl row master adds is numbered after its verse's last row.
 */
export function planLockedMirror(
  master: MirrorMasterRow[],
  stored: MirrorStoredRow[],
  mirrorOrder: boolean,
): LockedMirrorPlan {
  const plan: LockedMirrorPlan = { write: [], insert: [], remove: [], keep: [], clearFlag: [], sortOrder: new Map() };

  // Master's own file can carry an id twice; the first occurrence wins, as in
  // applyTsvRows (insertedThisPass).
  const masterById = new Map<string, MirrorMasterRow>();
  const masterRows: MirrorMasterRow[] = [];
  for (const m of master) {
    if (masterById.has(m.id)) continue;
    masterById.set(m.id, m);
    masterRows.push(m);
  }
  const storedById = new Map(stored.map((s) => [s.id, s]));

  for (const m of masterRows) {
    const s = storedById.get(m.id);
    if (!s) {
      plan.insert.push(m.id);
      continue;
    }
    if (s.pending) {
      if (s.removed) plan.keep.push({ id: s.id, reason: "deleted_in_app" });
      else if (s.sig !== m.sig) plan.keep.push({ id: s.id, reason: "edited" });
      else if (s.review_kind === MIRROR_KEPT) plan.clearFlag.push(s.id);
      continue;
    }
    if (s.removed || s.sig !== m.sig) plan.write.push(s.id);
    else if (s.review_kind === MIRROR_KEPT) plan.clearFlag.push(s.id);
  }
  for (const s of stored) {
    if (masterById.has(s.id) || s.removed) continue;
    if (s.pending) plan.keep.push({ id: s.id, reason: "not_on_door43" });
    else plan.remove.push(s.id);
  }

  // Where each surviving row sits once the plan lands: master's verse for a
  // row master owns, D1's own verse for a kept pending row.
  const keptIds = new Set(plan.keep.filter((k) => k.reason !== "deleted_in_app").map((k) => k.id));
  const removedIds = new Set(plan.remove);
  const groups = new Map<string, { ids: string[]; pending: boolean }>();
  const place = (key: string, id: string, pending: boolean) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { ids: [], pending: false }));
    g.ids.push(id);
    if (pending) g.pending = true;
  };
  for (const m of masterRows) {
    const s = storedById.get(m.id);
    if (s && s.pending) {
      if (!s.removed) place(verseKey(s.chapter, s.verse), s.id, true);
      continue;
    }
    place(verseKey(m.chapter, m.verse), m.id, false);
  }
  for (const s of stored) {
    if (keptIds.has(s.id) && !masterById.has(s.id)) place(verseKey(s.chapter, s.verse), s.id, true);
  }

  const currentSort = (id: string): number | null => storedById.get(id)?.sort_order ?? null;
  const inserted = new Set(plan.insert);
  for (const g of groups.values()) {
    const ids = g.ids.filter((id) => !removedIds.has(id));
    if (!mirrorOrder || g.pending) {
      // Order is left as D1 has it: twl always (see above), and a verse holding
      // a pending row (a person's in-app order may be part of the pending fix).
      // A row master adds still needs a number: after the verse's last one.
      let next = Math.max(0, ...ids.filter((id) => !inserted.has(id)).map((id) => currentSort(id) ?? 0));
      for (const id of ids) {
        if (!inserted.has(id)) continue;
        next = (Math.floor(next / 100) + 1) * 100;
        plan.sortOrder.set(id, next);
      }
      continue;
    }
    // Master's file order for this verse (ids are already in file order).
    const current = ids
      .map((id) => ({ id, sort_order: inserted.has(id) ? null : currentSort(id) }))
      .sort(byStoredOrder)
      .map((r) => r.id);
    const sameOrder = current.every((id, i) => id === ids[i]);
    const allNumbered = ids.every((id) => !inserted.has(id) && currentSort(id) != null);
    const distinct = new Set(ids.map((id) => currentSort(id))).size === ids.length;
    if (sameOrder && allNumbered && distinct) continue;
    ids.forEach((id, i) => {
      const n = (i + 1) * 100;
      if (inserted.has(id) || currentSort(id) !== n) plan.sortOrder.set(id, n);
    });
  }
  return plan;
}
