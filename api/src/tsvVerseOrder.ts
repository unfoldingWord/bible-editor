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
// should carry, so every write path and one final sort-only batch agree:
//
//  - Who owns the verse's order. A person's in-app reorder (rows.ts's
//    reorder fast path stamps `last_change_action='reorder'`,
//    `last_change_source='user'`) newer than the last export master is
//    confirmed to hold has not reached master yet, so D1's order wins (the
//    HOS 11 reorder-revert fix, kept). Otherwise master owns the order. tq
//    has no in-app reorder, so master always owns a tq verse.
//
//  - Master-owned verse. If D1's current order already equals master's (with
//    D1-only rows, such as unexported in-app notes, kept after the row they
//    follow now), every row keeps its current number: no churn on a clean
//    verse, and a content rewrite no longer moves the row. Otherwise the
//    whole verse is renumbered 100, 200, ... in that order, so written and
//    unwritten rows never mix scales.
//
//  - Locally-owned verse. Existing rows keep their numbers, including a row
//    whose content master rewrote. A row entering the verse from master gets
//    a number between its master predecessor and the next local row when the
//    gap allows; otherwise it falls back to master position x 100 (the old
//    behavior), and the caller handles that.
//
// Known limit: there is no stored "order at last export" to compare with, so
// when BOTH a person and master reordered the same verse since that export,
// the person's order wins and the next export carries it to master.
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
  /** Verses whose order a pending in-app reorder owns (kept as D1 has them). */
  localOwnedVerses: number;
  /** Master-owned verses whose order disagreed with master and are renumbered. */
  renumberedVerses: number;
}

/** A person's in-app reorder that master has not yet been confirmed to hold. */
export function isPendingUserReorder(r: LiveOrderRow, confirmedAt: number | null): boolean {
  if (r.last_change_action !== "reorder" || r.last_change_source !== "user") return false;
  return confirmedAt == null || (r.updated_at ?? 0) > confirmedAt;
}

// The export's order: sort_order ascending with NULLs last, then id.
function compareLive(a: LiveOrderRow, b: LiveOrderRow): number {
  const an = a.sort_order == null;
  const bn = b.sort_order == null;
  if (an !== bn) return an ? 1 : -1;
  if (!an && a.sort_order !== b.sort_order) return (a.sort_order as number) - (b.sort_order as number);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
    const key = (id: string) => verseOrderKey(id, chapter, verse);

    if (kind === "tn" && local.some((r) => isPendingUserReorder(r, confirmedAt))) {
      localOwnedVerses++;
      planLocalOwned(masterIds, local, key, planned);
      continue;
    }

    // Master-owned: master's order, with each D1-only row kept right after
    // the row it follows in D1 now (or at the front when nothing precedes it).
    const masterSet = new Set(masterIds);
    const target = [...masterIds];
    let lastPlaced: string | null = null;
    let front = 0;
    for (const r of local) {
      if (masterSet.has(r.id)) {
        lastPlaced = r.id;
        continue;
      }
      if (lastPlaced == null) target.splice(front++, 0, r.id);
      else target.splice(target.indexOf(lastPlaced) + 1, 0, r.id);
      lastPlaced = r.id;
    }
    const localIds = new Set(local.map((r) => r.id));
    const targetLocal = target.filter((id) => localIds.has(id));
    const sameOrder =
      targetLocal.length === local.length && targetLocal.every((id, i) => id === local[i].id);
    const entering = masterIds.some((id) => !localIds.has(id));
    // A NULL number has no scale to keep, so it forces a renumber too.
    const allNumbered = local.every((r) => r.sort_order != null);
    if (sameOrder && !entering && allNumbered) {
      for (const r of local) planned.set(key(r.id), r.sort_order as number);
      continue;
    }
    renumberedVerses++;
    target.forEach((id, i) => planned.set(key(id), (i + 1) * 100));
  }
  return { planned, localOwnedVerses, renumberedVerses };
}

// Locally-owned verse: existing rows keep their numbers; each run of rows
// entering from master is slotted between its master predecessor and the
// next local row when there is room for it.
function planLocalOwned(
  masterIds: string[],
  local: LiveOrderRow[],
  key: (id: string) => string,
  planned: Map<string, number>,
): void {
  const numbered = local.filter((r) => r.sort_order != null);
  for (const r of numbered) planned.set(key(r.id), r.sort_order as number);
  if (numbered.length === 0) return;
  const localIds = new Set(local.map((r) => r.id));
  const posOf = new Map(numbered.map((r, i) => [r.id, i]));

  let i = 0;
  while (i < masterIds.length) {
    if (localIds.has(masterIds[i])) {
      i++;
      continue;
    }
    // A run of entering rows; its anchor is the nearest numbered local row
    // before it in master's order.
    const run: string[] = [];
    let j = i;
    while (j < masterIds.length && !localIds.has(masterIds[j])) run.push(masterIds[j++]);
    let anchor = -1;
    for (let p = i - 1; p >= 0; p--) {
      const pos = posOf.get(masterIds[p]);
      if (pos != null) {
        anchor = pos;
        break;
      }
    }
    const prev = anchor >= 0 ? (numbered[anchor].sort_order as number) : 0;
    const nextRow = numbered[anchor + 1];
    if (nextRow == null) {
      run.forEach((id, n) => planned.set(key(id), prev + (n + 1) * 100));
    } else {
      const next = nextRow.sort_order as number;
      const step = (next - prev) / (run.length + 1);
      const values = run.map((_, n) => Math.floor(prev + step * (n + 1)));
      const fits = values.every((v, n) => v > prev && v < next && (n === 0 || v > values[n - 1]));
      // No room: leave these unplanned so the caller keeps master position x 100.
      if (fits) run.forEach((id, n) => planned.set(key(id), values[n]));
    }
    i = j;
  }
}
