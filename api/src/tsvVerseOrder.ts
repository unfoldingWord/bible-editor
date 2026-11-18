// Whole-verse sort_order plan for the tn/tq reimport (issue #1404).
//
// The export renders a verse's rows in `sort_order` order (exportWorkflow.ts:
// `ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`), so within one
// verse every row's number has to be on one scale. The reimport used to number
// rows one at a time: a row master rewrote got master position x 100, while a
// row it left alone (content already matched, or a person had edited it) kept
// whatever number an older import gave it. When an older import numbered the
// verse differently (it held more notes, say), the two scales interleaved and
// the next export wrote a scrambled order to master. NUM 1:2 on 2026-11-13:
// seven rows renumbered 100..1000, m53p kept 1300, d3n2/zwf2 kept 1500/1600,
// so m53p moved from 5th to 8th.
//
// This module decides, per verse and BEFORE any write, which number each row
// should carry, so every write path and one final sort-only batch agree.
//
//  1. Who owns the verse's order. If a person changed anything in the verse
//     in-app since the last export master is confirmed to hold (a live row
//     with `last_change_source='user'` and `updated_at` after
//     `master_confirmed_at`), D1's order stands: that person's reorder (the
//     HOS 11 reorder-revert fix) may not have reached master yet. Any user
//     action counts, not only `reorder`, because a later edit, preserve or
//     trash on a dragged row replaces its `reorder` stamp. With no confirmed
//     export at all, only a `reorder` stamp counts (otherwise every verse a
//     person ever touched would hold master's order back forever). Otherwise
//     master owns the order. tq has no in-app reorder, so master always owns
//     a tq verse.
//
//  2. The target order. Master-owned: master's order, with each D1-only row
//     (an unexported in-app note, say) kept right after the row it follows in
//     D1 now. D1-owned: D1's order, with each row entering from master placed
//     right after its master predecessor.
//
//  3. The numbers. If the existing rows' numbers already rise along the
//     target order, they are kept (no churn on a clean verse, and a content
//     rewrite no longer moves its row), and each run of entering rows gets
//     numbers between its neighbours. If they do not rise, a number is NULL,
//     or an entering run has no room, the whole verse is renumbered 100, 200,
//     ... along the target order, so written and unwritten rows never mix
//     scales.
//
// Known limits: there is no stored "order at last export" to compare with, so
// when both a person and master reordered the same verse since that export,
// the person's order wins and the next export carries it to master. And if
// master rewrites every row a person touched AND that night's export is held,
// the user-change evidence is gone the night after.
//
// Pure: no D1, no clock. bookReimport.ts reads the rows and applies the plan.

export interface LiveOrderRow {
  id: string;
  chapter: number;
  verse: number;
  sort_order: number | null;
  last_change_action: string | null;
  last_change_source: string | null;
  updated_at: number | null;
}

export interface IncomingOrderRow {
  id: string;
  chapter: number;
  verse: number;
}

/** Key for a planned number: the same id can be planned in two verses when master moved it. */
export function verseOrderKey(id: string, chapter: number, verse: number): string {
  return `${id}@${chapter}:${verse}`;
}

export interface VerseOrderPlan {
  /** verseOrderKey -> planned sort_order. Absent = no plan (caller keeps its old numbering). */
  planned: Map<string, number>;
  /** Verses whose order D1 keeps because a person changed the verse since the last confirmed export. */
  localOwnedVerses: number;
  /** Verses renumbered as a whole. */
  renumberedVerses: number;
}

/** A person's in-app change that master has not yet been confirmed to hold. */
export function isPendingUserChange(r: LiveOrderRow, confirmedAt: number | null): boolean {
  if (r.last_change_source !== "user") return false;
  if (confirmedAt == null) return r.last_change_action === "reorder";
  return (r.updated_at ?? 0) > confirmedAt;
}

// The export's order: sort_order ascending with NULLs last, then id.
function compareLive(a: LiveOrderRow, b: LiveOrderRow): number {
  const an = a.sort_order == null;
  const bn = b.sort_order == null;
  if (an !== bn) return an ? 1 : -1;
  if (!an && a.sort_order !== b.sort_order) return (a.sort_order as number) - (b.sort_order as number);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Insert each `others` id (in its given order) right after the nearest
// preceding id from `order` that is already in `base`; at the front when
// nothing precedes it. `order` is the sequence the anchors are read from.
function anchorInto(base: string[], order: string[], others: Set<string>): string[] {
  const target = [...base];
  let lastPlaced: string | null = null;
  let front = 0;
  for (const id of order) {
    if (!others.has(id)) {
      if (target.includes(id)) lastPlaced = id;
      continue;
    }
    if (lastPlaced == null) target.splice(front++, 0, id);
    else target.splice(target.indexOf(lastPlaced) + 1, 0, id);
    lastPlaced = id;
  }
  return target;
}

export function planVerseSortOrders(
  kind: "tn" | "tq",
  incoming: IncomingOrderRow[],
  live: LiveOrderRow[],
  confirmedAt: number | null,
): VerseOrderPlan {
  const planned = new Map<string, number>();
  let localOwnedVerses = 0;
  let renumberedVerses = 0;

  // Master's ids per verse, in file order (a duplicated id keeps its first slot).
  const masterByVerse = new Map<string, { chapter: number; verse: number; ids: string[] }>();
  for (const r of incoming) {
    const k = `${r.chapter}:${r.verse}`;
    let v = masterByVerse.get(k);
    if (!v) masterByVerse.set(k, (v = { chapter: r.chapter, verse: r.verse, ids: [] }));
    if (!v.ids.includes(r.id)) v.ids.push(r.id);
  }
  const liveByVerse = new Map<string, LiveOrderRow[]>();
  for (const r of live) {
    const k = `${r.chapter}:${r.verse}`;
    let v = liveByVerse.get(k);
    if (!v) liveByVerse.set(k, (v = []));
    v.push(r);
  }

  for (const [k, { chapter, verse, ids: masterIds }] of masterByVerse) {
    const local = (liveByVerse.get(k) ?? []).slice().sort(compareLive);
    const localIds = local.map((r) => r.id);
    const localSet = new Set(localIds);
    const masterSet = new Set(masterIds);

    let target: string[];
    if (kind === "tn" && local.some((r) => isPendingUserChange(r, confirmedAt))) {
      localOwnedVerses++;
      // D1's order; rows entering from master go after their master predecessor.
      target = anchorInto(localIds, masterIds, new Set(masterIds.filter((id) => !localSet.has(id))));
    } else {
      // Master's order; D1-only rows stay after the row they follow in D1.
      target = anchorInto(masterIds, localIds, new Set(localIds.filter((id) => !masterSet.has(id))));
    }

    const numbers = keepNumbers(target, new Map(local.map((r) => [r.id, r.sort_order])));
    const key = (id: string) => verseOrderKey(id, chapter, verse);
    if (numbers) {
      for (const [id, n] of numbers) planned.set(key(id), n);
    } else {
      renumberedVerses++;
      target.forEach((id, i) => planned.set(key(id), (i + 1) * 100));
    }
  }
  return { planned, localOwnedVerses, renumberedVerses };
}

// Keep every existing row's number and slot the rest between their
// neighbours, or return null when that cannot give a strictly rising
// sequence along `target` (existing numbers out of order, a NULL number, or
// no integer room for an entering run).
function keepNumbers(target: string[], current: Map<string, number | null>): Map<string, number> | null {
  const out = new Map<string, number>();
  let prev: number | null = null;
  let run: string[] = [];
  const flush = (next: number | null): boolean => {
    if (run.length === 0) return true;
    const lo = prev ?? 0;
    if (next == null) {
      run.forEach((id, n) => out.set(id, lo + (n + 1) * 100));
    } else {
      const step = (next - lo) / (run.length + 1);
      const values = run.map((_, n) => Math.floor(lo + step * (n + 1)));
      if (!values.every((v, n) => v > lo && v < next && (n === 0 || v > values[n - 1]))) return false;
      run.forEach((id, n) => out.set(id, values[n]));
    }
    run = [];
    return true;
  };
  for (const id of target) {
    if (!current.has(id)) {
      run.push(id);
      continue;
    }
    const n = current.get(id);
    if (n == null || (prev != null && n <= prev)) return null;
    if (!flush(n)) return null;
    out.set(id, n);
    prev = n;
  }
  return flush(null) ? out : null;
}
