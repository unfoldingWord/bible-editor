// Canonical TWL ordering: sequence translationWord links by the position of the
// Hebrew/Greek word they point at in the aligned ULT verse. A pure leaf module
// (no D1 / Workflow deps) so it's unit-testable under the strip-types runner,
// like sortOrder.ts. The nightly export (export.ts buildTwlTsv) and the reimport
// canonicalization post-pass (bookReimport.ts) BOTH order rows through the shared
// `orderTwlRows` helper here, so the two agree exactly on canonical order.
//
// ANCHOR SELECTION (which English word a link sorts at). Hebrew glues particles
// onto the noun — וְ־ "and", הַ־ "the", the construct "of" — so one alignment span
// legitimately covers an English run like "and the house of". Sorting on that
// span's FIRST English word orders links by their leading function words instead
// of by their subject. Per the translation team's direction, order on the word
// that carries the TW article's HEADWORD ("house"), ignoring the attached words.
// Three tiers, first hit wins (see `selectAnchor`):
//   1. the English word matching the TW article headword;
//   2. else, when the span has more than one word, the first word that is not a
//      conjunction / preposition / article;
//   3. else the span's first English word.
// Tier 3 is exactly the pre-headword behaviour (the lowest English index in the
// span), so any row we cannot headword-match keeps the position it has today.

import type { TwlRow, VerseRow } from "./types";
import { parseVerseContentJson } from "./contentJson.ts";
import { sortRowsByReference } from "./tsvFormat.ts";
import { headwordTermsFromTitle, isFunctionWord, matchesHeadword } from "./twHeadword.ts";

// Sequence TWLs by position of Hebrew word in aligned ULT.
export function normalizeWordText(s: string | null | undefined): string {
  if (s == null) return "";
  return s.normalize("NFC").toLowerCase().trim().replace(/[\s\p{P}\p{S}]+/gu, " ");
}

// One English `\w` word of the ULT: its 0-based reading-order index, and its
// surface text (needed to test it against the TW headword and the function-word
// list — the pre-headword code only ever needed the index).
export interface WordRef {
  index: number;
  text: string;
}

// One `\zaln` alignment milestone, in the order it is ENTERED (pre-order —
// matches ULT English reading order). `words` collects EVERY English `\w` under
// it (direct or nested), in reading order, as the walk reaches them. The anchor
// can no longer be chosen while walking — which word wins depends on the TW
// article of the row doing the lookup — so the whole span is kept and the choice
// is deferred to `selectAnchor` at lookup time.
interface MilestoneEntry {
  content: string;
  words: WordRef[];
}

// Merge two spans' word lists into one ascending, index-deduped list. Nested
// milestones share words with their parent, so a phrase window that spans an
// outer and an inner milestone would otherwise double-count them.
function mergeWordRefs(a: WordRef[], b: WordRef[]): WordRef[] {
  if (b.length === 0) return a;
  const byIndex = new Map<number, WordRef>();
  for (const w of a) byIndex.set(w.index, w);
  for (const w of b) byIndex.set(w.index, w);
  return [...byIndex.values()].sort((x, y) => x.index - y.index);
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

export function buildUltSequenceMap(verse: VerseRow | null | undefined): Map<string, WordRef[]> {
  const sequenceMap = new Map<string, WordRef[]>();
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
        const entry: MilestoneEntry = { content: normalizeWordText(o["content"] as string), words: [] };
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

      // English word. Record it against EVERY currently-open milestone (all
      // nesting levels) — so an OUTER word of a nested alignment resolves
      // (ZEC 3:1 "high priest" = הַכֹּהֵן wrapping הַגָּדוֹל). Every word is kept,
      // not just the first, because the headword may sit anywhere in the span.
      if (o["type"] === "word" && o["tag"] === "w") {
        const text = typeof o["text"] === "string" ? (o["text"] as string) : "";
        for (const entry of stack) {
          entry.words.push({ index: englishIndex, text });
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
  // start-position order, not window-length order. The window's stored value is
  // the UNION of its entries' English words (ascending, deduped) — a phrase can
  // start with a word that has no aligned English target at all (e.g. a dropped
  // connective), so the span simply contributes nothing and the following
  // entries carry it. The occurrence counter advances for EVERY window
  // regardless of whether it resolved — even a fully unaligned instance still
  // "consumes" an occurrence slot (mirrors the old per-milestone counter, which
  // incremented at push time before knowing whether that milestone would ever
  // get a \w) — only the sequenceMap WRITE is skipped when the window has no
  // words at all. Otherwise a later, aligned instance of the same phrase would
  // be miscounted as occurrence #1 instead of #2.
  const phraseOccurrenceCount = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    let phrase = entries[i].content;
    let windowWords = entries[i].words;
    for (let len = 1; i + len <= entries.length; len++) {
      if (len > 1) {
        const entry = entries[i + len - 1];
        phrase += ` ${entry.content}`;
        windowWords = mergeWordRefs(windowWords, entry.words);
      }
      const occurrence = (phraseOccurrenceCount.get(phrase) ?? 0) + 1;
      phraseOccurrenceCount.set(phrase, occurrence);
      if (windowWords.length > 0) sequenceMap.set(`${phrase}#${occurrence}`, windowWords.slice());
    }
  }

  return sequenceMap;
}

// What a row needs in order to prefer its headword: the TW article's terms (a
// title may list synonyms, "God, gods") and whether it is a names/ article,
// which suppresses morphological variants when matching.
export interface TwlAnchorContext {
  terms: string[];
  isName: boolean;
}

// Look up a row's TW article title and reduce it to match terms. Returns null
// when there is no link, no title map, no article for the link, or no usable
// term — every one of which simply drops the row to tier 2/3.
export function twlAnchorContext(
  twLink: string | null | undefined,
  twTitles: Map<string, string> | null | undefined,
): TwlAnchorContext | null {
  if (!twLink || !twTitles) return null;
  const title = twTitles.get(twLink);
  if (!title) return null;
  const terms = headwordTermsFromTitle(title);
  if (terms.length === 0) return null;
  return { terms, isName: twLink.includes("/names/") };
}

// Pick the English word a span sorts at. Tiers documented at the top of the
// file. `words` is ascending by index, so tier 3 returns the lowest index —
// byte-for-byte the value the pre-headword implementation stored.
export function selectAnchor(
  words: WordRef[],
  context: TwlAnchorContext | null,
): number | null {
  if (words.length === 0) return null;

  // 1. the word carrying the TW headword.
  if (context && context.terms.length > 0) {
    for (const w of words) {
      if (matchesHeadword(w.text, context.terms, context.isName)) return w.index;
    }
  }

  // 2. the first word that is not a conjunction / preposition / article. Only
  //    when the span has more than one word: for a single-word span there is
  //    nothing to skip TO, and skipping it would strand the row as unresolved.
  if (words.length > 1) {
    for (const w of words) {
      if (!isFunctionWord(w.text)) return w.index;
    }
  }

  // 3. first word (pre-headword behaviour).
  return words[0].index;
}

export function twlSortPosition(
  row: TwlRow,
  sequenceMap: Map<string, WordRef[]>,
  context: TwlAnchorContext | null = null,
): number | null {
  const key =
    `${normalizeWordText(row.orig_words)}#${row.occurrence}`;
  const words = sequenceMap.get(key);
  if (!words) return null;
  return selectAnchor(words, context);
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
export function orderTwlRows(
  rows: TwlRow[],
  ultVerses: VerseRow[],
  twTitles?: Map<string, string> | null,
): TwlOrdering {
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

    // Resolve each row's position ONCE (decorate-sort), not inside the
    // comparator: headword matching runs morphological variants, so paying for
    // it O(n log n) times per verse instead of O(n) would be wasteful.
    const positions = new Map<string, number | null>();
    for (const { row } of bucket) {
      positions.set(
        row.id,
        twlSortPosition(row, sequenceMap, twlAnchorContext(row.tw_link, twTitles)),
      );
    }

    bucket.sort((a, b) => {
      const aPos = positions.get(a.row.id) ?? null;
      const bPos = positions.get(b.row.id) ?? null;

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
  twTitles?: Map<string, string> | null,
): Array<{ id: string; sort_order: number }> {
  return orderTwlRows(rows, ultVerses, twTitles).sortOrderUpdates;
}
