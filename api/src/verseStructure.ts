// Issue #728 — verse-bridge STRUCTURE reconciled against Door43 master as its
// own dimension, before any content write.
//
// A verse bridge (`\v a-b`) is ONE `verses` row: the start verse carries
// `verse_end`, the absorbed rows are deleted (verseBridge.ts). The nightly
// pre-export reimport (applyVerseRows, bookReimport.ts) reconciles D1 against
// master verse by verse, and until #728 it treated structure as a side effect
// of content: every content write copied `verse_end` from master and the
// reimport never deleted a verse row. That left four structural shapes of which
// only one was handled (PR #721's `bridgeCover` skip):
//
//   D1     master   D1's structure is                  correct outcome
//   1-2    1, 2     local (not yet exported)            keep D1, skip master's rows
//   1-2    1, 2     exported; a human un-bridged it     adopt master: split D1
//   1, 2   1-2      local (a split after the export)    keep D1, skip master's bridge row
//   1, 2   1-2      exported; a human bridged on Door43  adopt master: absorb D1's 2
//
// Design (decided in #726). Two questions, asked per CONNECTED COMPONENT of
// intersecting [verse, verse_end] ranges taken from BOTH sides, so D1 never ends
// a run with two rows covering one verse:
//
//  1. Did we publish this structure? `book_resource_syncs.master_confirmed_
//     edit_id` is MAX(edit_log.id) at the D1 read of the render Door43 is
//     confirmed to hold (`cutoff.editId`). A D1 structure is LOCAL when the
//     newest edit_log row with action IN ('bridge','split') on any of its start
//     keys has id > cutoff.editId (timestamp fallback: created_at >=
//     cutoff.confirmedAt — the same dual pattern as base_payload). It is
//     EXPORTED when that row is at/below the boundary, or when no structural
//     row exists at all (imported structure — e.g. a `\v a-b` that arrived in
//     the USFM; ULT has no bridge route, so every ULT bridge is this). No
//     watermark at all → cannot classify → keep D1, skip master's rows, count
//     `unclassified` (the pre-#728 behaviour, now counted).
//  2. If master diverged from an EXPORTED structure, did a human on Door43 do
//     it? masterMayHoldHumanEditForVerse over the component's whole range:
//     true (a human commit touched it, or the walk was incomplete) → adopt
//     Door43's structure; false (provably non-human) → keep D1, flag
//     keep_local_structure / master_moved_non_human. This is rule 6 of
//     computeVerseMerge applied to structure.
//
// WHAT "ADOPT" MEANS HERE, and the one shape restriction. An adoption is
// expressed relative to an ANCHOR: the single D1 row whose start verse is also
// the start of a master range. The anchor's content and `verse_end` flow through
// the caller's ordinary content path (pristine / AI-reseed / computeVerseMerge —
// so an un-bridge with unchanged words is a clean `adopt`, and an app edit since
// the export still gets its `adopt_conflict` recovery pointer); the OTHER rows
// of the component are then purely structural:
//   - kind 'split'  (anchor shrinks): master ranges strictly inside the anchor's
//                    old range are `recreated` (INSERT from master's content);
//   - kind 'bridge' (anchor widens): D1 rows strictly inside master's range are
//                    `absorbed` (DELETE, content preserved in an edit_log 'delete'
//                    row, mirroring the bridge route).
// A component that is not one of those two pure shapes — two anchors, an anchor
// that both shrinks and absorbs, no anchor at all, or more rows than one D1
// batch can carry — is REFUSED (keep D1, flag master_structure_complex). Those
// shapes would need several independently-guarded writes whose partial landing
// could leave an overlap, and nothing a human does on Door43 in one edit produces
// them; refusing keeps the invariant cheap to prove and leaves a flag a human
// can act on.
//
// INTERACTION WITH `human_edit_after_export` (the caller's per-row probe: any
// edit_log row with source IS NULL above the boundary). A 'bridge'/'split' row
// is human-authored and has NULL source, so a LOCAL structure always trips that
// probe on its start row. That is correct and needs no special casing: a local
// structure is never adopted here — its master rows are skipped — so the probe
// never reaches computeVerseMerge for it. For an EXPORTED structure the
// structural row sits at/below the boundary, so the probe sees only genuine
// later app edits, which is exactly what rule 5 of computeVerseMerge wants to
// know. The two dimensions therefore compose without either lying to the other.
//
// PURE (no hono, no Env, no D1) so verseStructure.test.mjs can drive every
// shape under plain `node --experimental-strip-types`; the same split as
// verseBridge.ts / verseMerge.ts. masterLineage.ts is import-free, so pulling
// the real masterMayHoldHumanEditForVerse in keeps the caller honest ("always
// the helper, never a boolean" — see verseMerge.ts's input contract).
import { masterMayHoldHumanEditForVerse, type MasterLineage, type MasterLineageSummary } from "./masterLineage.ts";
import { verseRangeEnd } from "./verseBridge.ts";

/** The minimal D1 verse-row shape the planner reads; the caller's fuller row type flows through the generics. */
export interface StructureD1Row {
  chapter: number;
  verse: number;
  verse_end: number | null;
  version: number;
}

/** The minimal master-side shape (importParsers.ts's VerseExtract satisfies it). */
export interface StructureMasterVerse {
  chapter: number;
  verse: number;
  verseEnd: number | null;
}

/** The newest edit_log row with action IN ('bridge','split') on a D1 start key. */
export interface StructuralEdit {
  id: number;
  createdAt: number;
}

/** bookReimport.ts's MergeCutoff, structurally. `confirmedAt == null` means no watermark. */
export interface StructureCutoff {
  confirmedAt: number | null;
  editId: number | null;
  lineage?: MasterLineage | MasterLineageSummary | null;
}

// Upper bound on the non-anchor rows of one adoptable component. Each costs two
// statements (write + audit) in the caller's structure batch, which must hold a
// whole component in ONE batch() call (audit rows chain on changes()), under
// the same ≤90-statement cap every batch in bookReimport.ts observes; the
// anchor's own pair plus 2 × 40 fits. Wider components are refused as complex.
export const MAX_STRUCTURE_COMPONENT_ROWS = 40;

export type StructureAdoptionKind = "bridge" | "split";

export interface StructureAdoption<R extends StructureD1Row, M extends StructureMasterVerse> {
  chapter: number;
  kind: StructureAdoptionKind;
  /** The D1 row master's range starts at. Its content + verse_end flow through the caller's content path. */
  anchor: R;
  /** Master's range for the anchor (its verseEnd is what the anchor's verse_end becomes). */
  anchorMaster: M;
  /** kind 'bridge': D1 rows inside master's range, to be deleted. Sorted by verse. Empty for 'split'. */
  absorbed: R[];
  /** kind 'split': master ranges inside the anchor's old range, to be inserted. Sorted by verse. Empty for 'bridge'. */
  recreated: M[];
}

export type StructureConflictReason = "master_moved_non_human" | "master_structure_complex";

export interface StructureConflict {
  chapter: number;
  /** The component's first D1 row (a bridge's start) — where the keep_local_structure flag lands. */
  verse: number;
  verseEnd: number | null;
  reason: StructureConflictReason;
  /** The D1 row's version at the read, for the flag's observedVersion. */
  observedVersion: number;
}

export interface StructureKeptLocal<R extends StructureD1Row, M extends StructureMasterVerse> {
  chapter: number;
  d1Rows: R[];
  masterVerses: M[];
}

export interface StructurePlan<R extends StructureD1Row, M extends StructureMasterVerse> {
  /**
   * Master verses (`chapter:verse`) the content loop must NOT touch: every
   * master range of a kept-local, unclassified or refused component, plus the
   * `recreated` ranges of an adoption (the structure batch inserts those).
   * An adoption's anchor is deliberately absent — the content loop writes it.
   */
  skipMasterKeys: Set<string>;
  adoptions: Array<StructureAdoption<R, M>>;
  conflicts: StructureConflict[];
  /** Components whose D1 structure is local (unexported) and therefore kept. */
  keptLocal: Array<StructureKeptLocal<R, M>>;
  /** Components that diverged but could not be classified — no watermark. */
  unclassified: number;
}

export function structureKey(chapter: number, verse: number): string {
  return `${chapter}:${verse}`;
}

interface Range<R, M> {
  start: number;
  end: number;
  d1?: R;
  master?: M;
}

function rangeSignature(rs: Array<{ start: number; end: number }>): string {
  return rs
    .map((r) => `${r.start}-${r.end}`)
    .sort()
    .join(",");
}

// Is this D1 structural edit newer than what master is confirmed to hold?
function isAboveBoundary(edit: StructuralEdit, cutoff: StructureCutoff): boolean {
  if (cutoff.editId != null) return edit.id > cutoff.editId;
  return cutoff.confirmedAt != null && edit.createdAt >= cutoff.confirmedAt;
}

export function planStructure<R extends StructureD1Row, M extends StructureMasterVerse>(
  existingRows: R[],
  masterVerses: M[],
  cutoff: StructureCutoff | null,
  structuralEdits: Map<string, StructuralEdit>,
): StructurePlan<R, M> {
  const plan: StructurePlan<R, M> = {
    skipMasterKeys: new Set<string>(),
    adoptions: [],
    conflicts: [],
    keptLocal: [],
    unclassified: 0,
  };
  const hasWatermark = cutoff != null && cutoff.confirmedAt != null;

  // Group both sides by chapter. Verse 0 is the chapter-front pseudo-verse: it
  // never bridges (the routes refuse it) and is left to the content path.
  const chapters = new Map<number, Range<R, M>[]>();
  const push = (chapter: number, r: Range<R, M>) => {
    let list = chapters.get(chapter);
    if (!list) chapters.set(chapter, (list = []));
    list.push(r);
  };
  for (const row of existingRows) {
    if (!(row.verse > 0)) continue;
    push(row.chapter, { start: row.verse, end: Math.max(row.verse, verseRangeEnd(row)), d1: row });
  }
  for (const m of masterVerses) {
    if (!(m.verse > 0)) continue;
    push(m.chapter, { start: m.verse, end: Math.max(m.verse, m.verseEnd ?? m.verse), master: m });
  }

  for (const [chapter, ranges] of chapters) {
    // Connected components of intersecting ranges: after sorting by start, a
    // range joins the open component iff it starts at or before the furthest
    // end seen so far (findOverlappingRanges's sweep, applied to both sides at
    // once). Merely adjacent ranges (1-2 then 3) do not intersect and never
    // join — a bridge and its neighbour are independent decisions.
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    const components: Range<R, M>[][] = [];
    let open: Range<R, M>[] = [];
    let reach = -1;
    for (const r of ranges) {
      if (open.length > 0 && r.start <= reach) {
        open.push(r);
      } else {
        if (open.length > 0) components.push(open);
        open = [r];
      }
      if (r.end > reach) reach = r.end;
    }
    if (open.length > 0) components.push(open);

    for (const comp of components) {
      const d1 = comp.filter((r) => r.d1 != null);
      const master = comp.filter((r) => r.master != null);
      // One-sided components are not a structural question: a master-only range
      // is a plain insert, a D1-only range is a verse master lacks (the reimport
      // never deletes those). Identical signatures agree — the content path
      // handles them verse by verse as before.
      if (d1.length === 0 || master.length === 0) continue;
      if (rangeSignature(d1) === rangeSignature(master)) continue;
      // One row on each side, same start, different end, and NOTHING else in
      // the component: master's range widened over verses D1 has no rows for
      // (or narrowed away from verses master no longer carries). No row is
      // absorbed or recreated, so no write can overlap — this is the plain
      // `verse_end` change the content path has always carried from master (the
      // #609 verse_end case), and it stays there: not a structural question.
      if (d1.length === 1 && master.length === 1 && d1[0].start === master[0].start) continue;

      const d1Rows = d1.map((r) => r.d1 as R);
      const masterRows = master.map((r) => r.master as M);
      const skipAllMaster = () => {
        for (const m of masterRows) plan.skipMasterKeys.add(structureKey(chapter, m.verse));
      };
      const first = d1Rows[0];

      if (!hasWatermark) {
        plan.unclassified++;
        skipAllMaster();
        continue;
      }
      const c = cutoff as StructureCutoff;

      // 1. Did we publish D1's structure? Local iff ANY D1 row of the component
      // carries a structural edit above the boundary. A split leaves its 'split'
      // row on the surviving start key and 'create' rows on the freed keys; a
      // bridge leaves 'bridge' on the start and 'delete' on the absorbed key
      // (whose row no longer exists, so only the start key is consulted).
      const local = d1Rows.some((row) => {
        const e = structuralEdits.get(structureKey(chapter, row.verse));
        return e != null && isAboveBoundary(e, c);
      });
      if (local) {
        plan.keptLocal.push({ chapter, d1Rows, masterVerses: masterRows });
        skipAllMaster();
        continue;
      }

      // 2. Exported, and master moved away from it. Only a human on Door43 may
      // re-structure what we published; a provably non-human divergence keeps
      // D1 and is flagged for a human to look at.
      const compStart = Math.min(...comp.map((r) => r.start));
      const compEnd = Math.max(...comp.map((r) => r.end));
      const human = masterMayHoldHumanEditForVerse(c.lineage, chapter, compStart, compEnd > compStart ? compEnd : null);
      if (!human) {
        plan.conflicts.push({
          chapter, verse: first.verse, verseEnd: first.verse_end ?? null, reason: "master_moved_non_human",
          observedVersion: first.version,
        });
        skipAllMaster();
        continue;
      }

      const adoption = classifyShape(chapter, d1, master);
      if (adoption === null) {
        plan.conflicts.push({
          chapter, verse: first.verse, verseEnd: first.verse_end ?? null, reason: "master_structure_complex",
          observedVersion: first.version,
        });
        skipAllMaster();
        continue;
      }
      for (const m of adoption.recreated) plan.skipMasterKeys.add(structureKey(chapter, m.verse));
      plan.adoptions.push(adoption);
    }
  }
  return plan;
}

// The pure-shape test described in the header. Returns null for anything that
// is not exactly one anchor widening over absorbed D1 rows, or exactly one
// anchor shrinking over recreated master ranges.
function classifyShape<R extends StructureD1Row, M extends StructureMasterVerse>(
  chapter: number,
  d1: Range<R, M>[],
  master: Range<R, M>[],
): StructureAdoption<R, M> | null {
  const anchors: Array<{ d: Range<R, M>; m: Range<R, M> }> = [];
  for (const m of master) {
    const d = d1.find((x) => x.start === m.start);
    if (d) anchors.push({ d, m });
  }
  if (anchors.length !== 1) return null;
  const { d, m } = anchors[0];
  const others = d1.filter((x) => x !== d);
  const recreated = master.filter((x) => x !== m);
  if (others.length + recreated.length > MAX_STRUCTURE_COMPONENT_ROWS) return null;

  if (m.end > d.end) {
    // Anchor widens: every other D1 row must lie strictly inside master's new
    // range, and master must have no other range (nothing to recreate).
    if (recreated.length > 0) return null;
    if (others.length === 0) return null;
    if (!others.every((x) => x.start > d.end && x.end <= m.end)) return null;
    return {
      chapter, kind: "bridge", anchor: d.d1 as R, anchorMaster: m.master as M,
      absorbed: others.map((x) => x.d1 as R).sort((a, b) => a.verse - b.verse), recreated: [],
    };
  }
  if (m.end < d.end) {
    // Anchor shrinks: every other master range must lie strictly inside the
    // anchor's old range, and D1 must have no other row (nothing to absorb).
    if (others.length > 0) return null;
    if (recreated.length === 0) return null;
    if (!recreated.every((x) => x.start > m.end && x.end <= d.end)) return null;
    return {
      chapter, kind: "split", anchor: d.d1 as R, anchorMaster: m.master as M,
      absorbed: [], recreated: recreated.map((x) => x.master as M).sort((a, b) => a.verse - b.verse),
    };
  }
  // Same anchor range on both sides but the component still diverged: the extra
  // rows are an overlap already present on one side. Not ours to guess at.
  return null;
}
