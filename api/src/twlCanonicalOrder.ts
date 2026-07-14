// Canonical TWL ordering: sequence translationWord links by the position of the
// Hebrew/Greek word they point at in the aligned ULT verse. A pure leaf module
// (no D1 / Workflow deps) so it's unit-testable under the strip-types runner,
// like sortOrder.ts. The nightly export (export.ts buildTwlTsv) and the reimport
// canonicalization post-pass (bookReimport.ts) BOTH order rows through the shared
// `orderTwlRows` helper here, so the two agree exactly on canonical order.

import type { TwlRow, VerseRow } from "./types";
import { parseVerseContentJson } from "./contentJson.ts";
import { sortRowsByReference } from "./tsvFormat.ts";

// Sequence TWLs by position of Hebrew word in aligned ULT.
export function normalizeWordText(s: string | null | undefined): string {
  if (s == null) return "";
  return s.normalize("NFC").toLowerCase().trim().replace(/[\s\p{P}\p{S}]+/gu, " ");
}

// One `\zaln` alignment milestone, in the order it is ENTERED (pre-order —
// matches ULT English reading order). `englishIndex` is the index of the
// first English `\w` under it (direct or nested), filled in once the walk
// reaches that word.
interface MilestoneEntry {
  content: string;
  englishIndex: number | null;
}

// A TWL row's OrigWords can be a multi-word source PHRASE, and that phrase can
// span milestones two different ways: (1) NESTED — an outer milestone wraps an
// inner one (e.g. Greek "τὸν Θεόν" = article milestone wrapping a noun
// milestone; JHN 1:1 gj8t), or (2) SIBLING — separate, adjacent top-level
// milestones (e.g. "Βασιλεία τοῦ Θεοῦ" = a standalone "Βασιλεία" milestone
// immediately followed by a "τοῦ" milestone that itself nests "Θεοῦ"; LUK
// 17:20). Both are just a CONTIGUOUS RUN in the pre-order milestone-entry
// sequence — nesting only affects whether the next entry came from `children`
// or from the next sibling in the same array. So resolving a phrase is a
// sliding-window search over one flat list, not a nesting-aware walk. No
// fixed max phrase length: the window grows up to the full entry list, so a
// legitimately long OrigWords phrase can't silently fail to resolve the way a
// hardcoded cap would (a verse only ever has a handful of milestones, so this
// costs nothing).

export function buildUltSequenceMap(verse: VerseRow | null | undefined): Map<string, number> {
  const sequenceMap = new Map<string, number>();
  if (!verse) return sequenceMap;

  const parsed = parseVerseContentJson(verse);
  const verseObjects = parsed && typeof parsed === "object"
    ? (parsed as { verseObjects?: unknown[] }).verseObjects
    : null;

  if (!Array.isArray(verseObjects)) return sequenceMap;

  let englishIndex = 0;
  const entries: MilestoneEntry[] = [];
  const stack: MilestoneEntry[] = []; // currently-open milestones, for marking englishIndex

  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;

      // Start of an alignment milestone. usfm-js nests alignment via `children`
      // (real ULT data carries NO milestoneEnd nodes), so scope the entry to
      // the children walk: push, recurse, pop. A milestone with no children is
      // sibling-structured — leave it on the stack for a milestoneEnd below.
      if (o["type"] === "milestone" && o["tag"] === "zaln" && typeof o["content"] === "string") {
        const entry: MilestoneEntry = { content: normalizeWordText(o["content"] as string), englishIndex: null };
        entries.push(entry);
        stack.push(entry);
        const children = o["children"];
        if (Array.isArray(children)) {
          walk(children);
          stack.pop();
        }
        continue;
      }

      // End of a sibling-structured alignment milestone.
      if (o["type"] === "milestoneEnd" && o["tag"] === "zaln") {
        if (stack.length > 0) stack.pop();
        continue;
      }

      // English word. Mark EVERY currently-open milestone (all nesting levels)
      // with its FIRST English index — so an OUTER word of a nested alignment
      // resolves (ZEC 3:1 "high priest" = הַכֹּהֵן wrapping הַגָּדוֹל).
      if (o["type"] === "word" && o["tag"] === "w") {
        for (const entry of stack) {
          if (entry.englishIndex == null) entry.englishIndex = englishIndex;
        }
        englishIndex++;
        continue;
      }

      const children = o["children"];
      if (Array.isArray(children)) walk(children);
    }
  };

  walk(verseObjects);

  // Sliding window over the flat pre-order entry list, POSITION-MAJOR (outer
  // loop over start index, inner loop growing the length): every contiguous
  // run starting at `i` is a candidate OrigWords phrase, its content built up
  // incrementally (no re-slicing/re-joining per window) and keyed with its own
  // per-phrase occurrence counter. Position-major order matters: counting
  // length-major (every 1-word window before any 2-word window) numbers
  // occurrences out of document order whenever the SAME phrase text arises via
  // two different groupings at different verse positions — e.g. one instance
  // is a single glued milestone, another is two separate sibling milestones
  // for the identical underlying words. TWL occurrence is a structure-
  // independent left-to-right scan over the source text (same convention
  // quoteBuilder.ts's buildQuoteFromSelection uses), so counting must follow
  // start-position order, not window-length order. The anchor is the FIRST
  // entry in the window with a resolved englishIndex, not strictly the
  // window's own first entry — a phrase can start with a word that has no
  // aligned English target at all (e.g. a dropped connective).
  const phraseOccurrenceCount = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    let phrase = entries[i].content;
    let anchor = entries[i].englishIndex;
    for (let len = 1; i + len <= entries.length; len++) {
      if (len > 1) {
        const entry = entries[i + len - 1];
        phrase += ` ${entry.content}`;
        if (anchor == null) anchor = entry.englishIndex;
      }
      if (anchor == null) continue; // no aligned English word anywhere in the run yet
      const occurrence = (phraseOccurrenceCount.get(phrase) ?? 0) + 1;
      phraseOccurrenceCount.set(phrase, occurrence);
      sequenceMap.set(`${phrase}#${occurrence}`, anchor);
    }
  }

  return sequenceMap;
}

export function twlSortPosition(
  row: TwlRow,
  sequenceMap: Map<string, number>,
): number | null {
  const key =
    `${normalizeWordText(row.orig_words)}#${row.occurrence}`;
  return sequenceMap.get(key) ?? null;
}

export interface TwlOrdering {
  // rows in DCS reference order (the stable order the TSV body is rendered in,
  // with per-verse buckets re-sequenced into canonical order).
  referenceOrdered: TwlRow[];
  // row id → its 0-based canonical index WITHIN its verse bucket.
  versePositions: Map<string, number>;
  // sort_order diffs: for every verse where any row's computed (i+1)*100 differs
  // from its stored sort_order, one entry per differing row. This is the exact
  // set of D1 updates the export applies and the reimport post-pass adopts.
  sortOrderUpdates: Array<{ id: string; sort_order: number }>;
}

// Shared per-verse ordering. Groups rows by chapter:verse (after
// sortRowsByReference), finds the matching ULT verse, builds its sequence map,
// and sorts each bucket by (ULT position asc; resolved-position before null;
// stored sort_order nulls-last; original index). Then diffs each verse's
// computed (i+1)*100 positions against stored sort_order. Kept byte-identical to
// the logic that used to live inline in export.ts buildTwlTsv.
export function orderTwlRows(rows: TwlRow[], ultVerses: VerseRow[]): TwlOrdering {
  const referenceOrdered = sortRowsByReference(rows);

  const versePositions = new Map<string, number>();
  const verseRows = new Map<string, Array<{ row: TwlRow; originalIndex: number }>>();

  // Group rows by verse
  for (const [originalIndex, row] of referenceOrdered.entries()) {
    const key = `${row.chapter}:${row.verse}`;
    const bucket = verseRows.get(key) ?? [];
    bucket.push({ row, originalIndex });
    verseRows.set(key, bucket);
  }

  // Compute the desired order within each verse
  for (const bucket of verseRows.values()) {
    const verse =
      ultVerses.find(
        (v) =>
          v.bible_version === "ULT" &&
          v.chapter === bucket[0].row.chapter &&
          v.verse === bucket[0].row.verse,
      ) ?? null;

    const sequenceMap = buildUltSequenceMap(verse);

    bucket.sort((a, b) => {
      const aPos = twlSortPosition(a.row, sequenceMap);
      const bPos = twlSortPosition(b.row, sequenceMap);

      if (aPos != null && bPos != null && aPos !== bPos) {
        return aPos - bPos;
      }

      if (aPos != null && bPos == null) return -1;
      if (aPos == null && bPos != null) return 1;

      if (
        (a.row.sort_order ?? Number.POSITIVE_INFINITY) !==
        (b.row.sort_order ?? Number.POSITIVE_INFINITY)
      ) {
        return (
          (a.row.sort_order ?? Number.POSITIVE_INFINITY) -
          (b.row.sort_order ?? Number.POSITIVE_INFINITY)
        );
      }

      return a.originalIndex - b.originalIndex;
    });

    bucket.forEach(({ row }, index) => {
      versePositions.set(row.id, index);
    });
  }

  // Track sort_order updates: only rows in verses where reordering happened
  const sortOrderUpdates: Array<{ id: string; sort_order: number }> = [];
  for (const bucket of verseRows.values()) {
    // Check if this verse's rows were reordered from their stored sort_order
    let verseReordered = false;
    for (let i = 0; i < bucket.length; i++) {
      const computedPos = (i + 1) * 100;
      const storedPos = bucket[i].row.sort_order ?? Number.POSITIVE_INFINITY;
      if (computedPos !== storedPos) {
        verseReordered = true;
        break;
      }
    }

    // If reordered, record updates for all rows in this verse that differ
    if (verseReordered) {
      for (let i = 0; i < bucket.length; i++) {
        const row = bucket[i].row;
        const computedPos = (i + 1) * 100;
        const storedPos = row.sort_order ?? Number.POSITIVE_INFINITY;
        if (computedPos !== storedPos) {
          sortOrderUpdates.push({ id: row.id, sort_order: computedPos });
        }
      }
    }
  }

  return { referenceOrdered, versePositions, sortOrderUpdates };
}

// Pure canonical-order diff for the reimport post-pass: given the book's live
// twl rows and its ULT verses, return the sort_order updates that would bring D1
// into canonical (ULT-position) order. Identical semantics to the export's
// sortOrderUpdates — same code path (orderTwlRows).
export function computeTwlSortOrderUpdates(
  rows: TwlRow[],
  ultVerses: VerseRow[],
): Array<{ id: string; sort_order: number }> {
  return orderTwlRows(rows, ultVerses).sortOrderUpdates;
}
