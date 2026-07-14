// VERBATIM MIRROR of api/src/twlCanonicalOrder.ts — keep the shared functions
// (normalizeWordText, buildUltSequenceMap, twlSortPosition) byte-identical with
// the server so the nightly export, the reimport canonicalization post-pass, and
// this live client all agree on canonical TWL order. The ONLY intentional
// difference: the web verse `content` is ALREADY a parsed object, so
// buildUltSequenceMap here takes `verseObjects` directly instead of a VerseRow +
// parseVerseContentJson. Precedent for an api↔web verbatim mirror:
// web/src/lib/usfmFormat.ts.
//
// Canonical order = sequence TWL links by the position of the Hebrew/Greek word
// they point at in the aligned ULT verse.

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
// sliding-window search over one flat list, not a nesting-aware walk.
const MAX_PHRASE_WORDS = 6;

export function buildUltSequenceMap(
  verseObjects: unknown[] | null | undefined,
): Map<string, number> {
  const sequenceMap = new Map<string, number>();
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
      // the children walk: push, recurse, pop. A childless milestone is
      // sibling-structured — left for a milestoneEnd below.
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

  // Sliding window over the flat pre-order entry list: every contiguous run of
  // 1..MAX_PHRASE_WORDS entries is a candidate OrigWords phrase, keyed by its
  // joined content with its own per-phrase occurrence counter (same "which
  // source instance" semantics as the single-word case — K=1 is just this
  // with one entry per window, so single-word rows are unaffected).
  const phraseOccurrenceCount = new Map<string, number>();
  for (let len = 1; len <= MAX_PHRASE_WORDS && len <= entries.length; len++) {
    for (let i = 0; i + len <= entries.length; i++) {
      const window = entries.slice(i, i + len);
      const anchor = window[0].englishIndex;
      if (anchor == null) continue; // shouldn't happen for well-formed alignment
      const phrase = window.map((e) => e.content).join(" ");
      const occurrence = (phraseOccurrenceCount.get(phrase) ?? 0) + 1;
      phraseOccurrenceCount.set(phrase, occurrence);
      sequenceMap.set(`${phrase}#${occurrence}`, anchor);
    }
  }

  return sequenceMap;
}

export function twlSortPosition(
  row: { orig_words: string | null; occurrence: number | null },
  sequenceMap: Map<string, number>,
): number | null {
  const key = `${normalizeWordText(row.orig_words)}#${row.occurrence}`;
  return sequenceMap.get(key) ?? null;
}

// Return a NEW array of a verse's TWL rows in canonical order: ULT word position
// asc; a row with a resolved position before one without; then stored sort_order
// (null → +Infinity); then original index (stable). Mirrors the per-verse
// comparator in api/src/twlCanonicalOrder.ts `orderTwlRows`. Does not mutate the
// input. Callers pass the ULT verse's verseObjects (or null when unavailable, in
// which case every row is "unresolved" and order falls back to sort_order).
export function canonicalTwlOrder<
  T extends { orig_words: string | null; occurrence: number | null; sort_order: number | null },
>(rows: T[], verseObjects: unknown[] | null | undefined): T[] {
  const sequenceMap = buildUltSequenceMap(verseObjects);
  return rows
    .map((row, originalIndex) => ({ row, originalIndex }))
    .sort((a, b) => {
      const aPos = twlSortPosition(a.row, sequenceMap);
      const bPos = twlSortPosition(b.row, sequenceMap);
      if (aPos != null && bPos != null && aPos !== bPos) return aPos - bPos;
      if (aPos != null && bPos == null) return -1;
      if (aPos == null && bPos != null) return 1;
      const aSort = a.row.sort_order ?? Number.POSITIVE_INFINITY;
      const bSort = b.row.sort_order ?? Number.POSITIVE_INFINITY;
      if (aSort !== bSort) return aSort - bSort;
      return a.originalIndex - b.originalIndex;
    })
    .map((x) => x.row);
}
