// VERBATIM MIRROR of api/src/twlCanonicalOrder.ts — keep the shared functions
// (normalizeWordText, mergeWordRefs, buildUltSequenceMap, twlAnchorContext,
// selectAnchor, twlSortPosition) byte-identical with the server so the nightly
// export, the reimport canonicalization post-pass, and this live client all
// agree on canonical TWL order. The ONLY intentional difference: the web verse
// `content` is ALREADY a parsed object, so buildUltSequenceMap here takes
// `verseObjects` directly instead of a VerseRow + parseVerseContentJson.
// Precedent for an api↔web verbatim mirror: web/src/lib/usfmFormat.ts.
//
// Canonical order = sequence TWL links by the position of the Hebrew/Greek word
// they point at in the aligned ULT verse.
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

export function buildUltSequenceMap(
  verseObjects: unknown[] | null | undefined,
): Map<string, WordRef[]> {
  const sequenceMap = new Map<string, WordRef[]>();
  if (!Array.isArray(verseObjects)) return sequenceMap;

  let englishIndex = 0;
  const entries: MilestoneEntry[] = [];
  const stack: MilestoneEntry[] = []; // currently-open milestones, for marking englishIndex
  // One SOURCE WORD can be aligned to NON-CONTIGUOUS English words, which USFM
  // expresses as two `\zaln` milestones with the same content AND the same
  // x-occurrence, split around whatever sits between them. ISA 60:6: וּתְהִלֹּת
  // (occ 1/1) wraps "and", then יְבַשֵּׂרוּ wraps "they will proclaim", then
  // וּתְהִלֹּת (occ 1/1 again) wraps "the praises of" — one Hebrew word rendered
  // "and … the praises of". Treating those as two entries made them look like
  // occurrence 1 and 2, so the TWL row (occurrence 1) resolved to just "and" and
  // sorted ahead of "proclaim". Keyed by content + the milestone's OWN
  // x-occurrence, both chunks reunite into a single span.
  const entriesByInstance = new Map<string, MilestoneEntry>();

  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;

      // Start of an alignment milestone. usfm-js nests alignment via `children`
      // (real ULT data carries NO milestoneEnd nodes), so scope the entry to
      // the children walk: push, recurse, pop. A childless milestone is
      // sibling-structured — left for a milestoneEnd below.
      if (o["type"] === "milestone" && o["tag"] === "zaln" && typeof o["content"] === "string") {
        const content = normalizeWordText(o["content"] as string);
        // The milestone's own x-occurrence identifies the source instance. When
        // absent (older/hand-built data) fall back to one entry per milestone,
        // which is the pre-fix behaviour.
        const rawOcc = o["occurrence"];
        const occ =
          typeof rawOcc === "number" ? rawOcc
          : typeof rawOcc === "string" && rawOcc.trim() !== "" ? Number(rawOcc)
          : null;
        const instanceKey = occ != null && Number.isFinite(occ) ? `${content}#${occ}` : null;

        let entry = instanceKey != null ? entriesByInstance.get(instanceKey) : undefined;
        // Merge SIBLINGS only. A same-content/same-occurrence milestone that is
        // still OPEN (on the stack) is the outer half of a NESTED pair, which is
        // the doubled-source-milestone defect (JER 31:33 class: one \zaln-s
        // wrapping the same token twice), not a split alignment. Those must stay
        // two entries so their occurrence numbering is unchanged — merging them
        // would delete the #2 slot and strand any TWL row carrying Occurrence=2
        // at the tail of the verse. Not registered either, so a genuine later
        // sibling still reunites with the OUTER entry.
        if (entry && stack.includes(entry)) entry = undefined;
        if (!entry) {
          const fresh: MilestoneEntry = { content, words: [] };
          entries.push(fresh);
          if (instanceKey != null && !entriesByInstance.has(instanceKey)) {
            entriesByInstance.set(instanceKey, fresh);
          }
          entry = fresh;
        }
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
  row: { orig_words: string | null; occurrence: number | null },
  sequenceMap: Map<string, WordRef[]>,
  context: TwlAnchorContext | null = null,
): number | null {
  const key = `${normalizeWordText(row.orig_words)}#${row.occurrence}`;
  const words = sequenceMap.get(key);
  if (!words) return null;
  return selectAnchor(words, context);
}

// Return a NEW array of a verse's TWL rows in canonical order: ULT word position
// asc; a row with a resolved position before one without; then stored sort_order
// (null → +Infinity); then original index (stable). Mirrors the per-verse
// comparator in api/src/twlCanonicalOrder.ts `orderTwlRows`. Does not mutate the
// input. Callers pass the ULT verse's verseObjects (or null when unavailable, in
// which case every row is "unresolved" and order falls back to sort_order), and
// the tw_link → article-title map (or null, which drops every row to tier 2/3 —
// the order this produced before headword anchoring).
export function canonicalTwlOrder<
  T extends {
    orig_words: string | null;
    occurrence: number | null;
    sort_order: number | null;
    tw_link?: string | null;
  },
>(
  rows: T[],
  verseObjects: unknown[] | null | undefined,
  twTitles?: Map<string, string> | null,
): T[] {
  const sequenceMap = buildUltSequenceMap(verseObjects);
  // Resolve each row's position ONCE (decorate-sort), not inside the comparator:
  // headword matching runs morphological variants, so paying for it O(n log n)
  // times per verse instead of O(n) would be wasteful.
  return rows
    .map((row, originalIndex) => ({
      row,
      originalIndex,
      pos: twlSortPosition(row, sequenceMap, twlAnchorContext(row.tw_link, twTitles)),
    }))
    .sort((a, b) => {
      const aPos = a.pos;
      const bPos = b.pos;
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
