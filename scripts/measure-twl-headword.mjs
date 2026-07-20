// Throwaway measurement script: compares the OLD (first-English-word) TWL
// canonical ordering against the NEW (headword-anchor, 3-tier) ordering across
// real production data for 7 books. Does not modify production code.
//
// Run with: node --experimental-strip-types --no-warnings scripts/measure-twl-headword.mjs

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEASURE_DIR = path.join(__dirname, "out", "measure");
const BOOKS = ["RUT", "OBA", "MIC", "ZEC", "HOS", "EST", "JHN"];

const { orderTwlRows: orderOld } = await import(
  "../api/src/twlCanonicalOrderBaseline.ts"
);
const {
  orderTwlRows: orderNew,
  buildUltSequenceMap,
  twlAnchorContext,
  selectAnchor,
  normalizeWordText,
} = await import("../api/src/twlCanonicalOrder.ts");
const { headwordTermsFromTitle, isFunctionWord, matchesHeadword } = await import(
  "../api/src/twHeadword.ts"
);

function loadRows(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return data[0]?.results ?? [];
}

function buildTwlRows(rawRows) {
  return rawRows.map((r) => ({
    id: r.id,
    book: r.book,
    chapter: r.chapter,
    verse: r.verse,
    ref_raw: r.ref_raw,
    tags: r.tags ?? null,
    orig_words: r.orig_words ?? null,
    occurrence: r.occurrence ?? null,
    tw_link: r.tw_link ?? null,
    sort_order: r.sort_order ?? null,
    version: 1,
    restored_from_version: null,
    updated_by: null,
    updated_at: 0,
    deleted_at: null,
  }));
}

function buildVerseRows(rawVerses, book) {
  return rawVerses.map((v) => ({
    book,
    chapter: v.chapter,
    verse: v.verse,
    verse_end: null,
    bible_version: "ULT",
    content_json: v.content_json,
    plain_text: null,
    version: 1,
    updated_by: null,
    updated_at: 0,
  }));
}

const twArticlesRaw = loadRows(path.join(MEASURE_DIR, "tw_articles.json"));
const twTitles = new Map();
for (const r of twArticlesRaw) {
  if (r.tw_link) twTitles.set(r.tw_link, r.title ?? "");
}

// Replicate the tier logic from selectAnchor so we can classify WHICH tier
// fired for each row, without modifying production code.
function classifyTier(words, context) {
  if (words.length === 0) return "unresolved";
  if (context && context.terms.length > 0) {
    for (const w of words) {
      if (matchesHeadword(w.text, context.terms, context.isName)) return "tier1_headword";
    }
  }
  if (words.length > 1) {
    for (const w of words) {
      if (!isFunctionWord(w.text)) return "tier2_skip_function";
    }
  }
  return "tier3_fallback";
}

const perBook = [];
const allExamples = [];
const allAnchorShiftExamples = [];

for (const book of BOOKS) {
  const twlRaw = loadRows(path.join(MEASURE_DIR, `${book}.twl.json`));
  const versesRaw = loadRows(path.join(MEASURE_DIR, `${book}.verses.json`));

  const twlRows = buildTwlRows(twlRaw);
  const verseRows = buildVerseRows(versesRaw, book);

  const oldOrder = orderOld(twlRows, verseRows);
  const newOrder = orderNew(twlRows, verseRows, twTitles);

  // Build per-verse ULT sequence maps once per book (keyed by chapter:verse)
  // so we can classify tiers and produce examples.
  const verseByKey = new Map();
  for (const v of verseRows) verseByKey.set(`${v.chapter}:${v.verse}`, v);
  const seqMapByKey = new Map();
  const getSeqMap = (chapter, verse) => {
    const key = `${chapter}:${verse}`;
    if (!seqMapByKey.has(key)) {
      seqMapByKey.set(key, buildUltSequenceMap(verseByKey.get(key) ?? null));
    }
    return seqMapByKey.get(key);
  };

  const tierCounts = {
    tier1_headword: 0,
    tier2_skip_function: 0,
    tier3_fallback: 0,
    unresolved: 0,
  };

  const rowById = new Map(twlRows.map((r) => [r.id, r]));

  // Anchor-shift: did selectAnchor land on a DIFFERENT English word than the
  // span's first word (index 0), independent of whether that flipped the
  // row's visible position within the verse? This is the qualitative
  // "and/the/of" effect — many spans have only one TWL row nearby, so shifting
  // the anchor internally doesn't change relative row order, but it IS the
  // headword fix doing its job.
  let anchorShiftedRows = 0;
  let multiWordSpanRows = 0;
  const anchorShiftExamples = [];

  for (const row of twlRows) {
    const seqMap = getSeqMap(row.chapter, row.verse);
    const key = `${normalizeWordText(row.orig_words)}#${row.occurrence}`;
    const words = seqMap.get(key) ?? [];
    const context = twlAnchorContext(row.tw_link, twTitles);
    const tier = classifyTier(words, context);
    tierCounts[tier]++;

    if (words.length > 1) {
      multiWordSpanRows++;
      const anchorIdx = selectAnchor(words, context);
      const firstIdx = words[0].index;
      if (anchorIdx !== firstIdx) {
        anchorShiftedRows++;
        if (anchorShiftExamples.length < 40) {
          anchorShiftExamples.push({
            book,
            ref: `${book} ${row.chapter}:${row.verse}`,
            id: row.id,
            tw_link: row.tw_link,
            orig_words: row.orig_words,
            tier,
            spanWords: words.map((w) => w.text),
            oldAnchor: words.find((w) => w.index === firstIdx)?.text,
            newAnchor: words.find((w) => w.index === anchorIdx)?.text,
          });
        }
      }
    }
  }

  // Group rows by verse to know per-verse row counts & compute changed rows.
  const verseGroups = new Map(); // key -> [rowIds] in ref order (from oldOrder.referenceOrdered)
  for (const row of oldOrder.referenceOrdered) {
    const key = `${row.chapter}:${row.verse}`;
    const arr = verseGroups.get(key) ?? [];
    arr.push(row.id);
    verseGroups.set(key, arr);
  }

  let totalRows = twlRows.length;
  let changedRows = 0;
  let versesWithChange = 0;
  let multiRowVerses = 0;

  const bookExamples = [];

  for (const [key, rowIds] of verseGroups.entries()) {
    if (rowIds.length > 1) multiRowVerses++;
    let verseChanged = false;
    for (const id of rowIds) {
      const oldPos = oldOrder.versePositions.get(id);
      const newPos = newOrder.versePositions.get(id);
      if (oldPos !== newPos) {
        changedRows++;
        verseChanged = true;
      }
    }
    if (verseChanged) versesWithChange++;

    if (verseChanged && bookExamples.length < 5) {
      const [chapter, verse] = key.split(":").map(Number);
      // Build before/after ordered orig_words lists.
      const beforeOrdered = [...rowIds].sort(
        (a, b) => oldOrder.versePositions.get(a) - oldOrder.versePositions.get(b),
      );
      const afterOrdered = [...rowIds].sort(
        (a, b) => newOrder.versePositions.get(a) - newOrder.versePositions.get(b),
      );
      const beforeWords = beforeOrdered.map((id) => rowById.get(id).orig_words);
      const afterWords = afterOrdered.map((id) => rowById.get(id).orig_words);

      // For each row that moved, note its span + anchor choice.
      const movedDetails = [];
      for (const id of rowIds) {
        const oldPos = oldOrder.versePositions.get(id);
        const newPos = newOrder.versePositions.get(id);
        if (oldPos === newPos) continue;
        const row = rowById.get(id);
        const seqMap = getSeqMap(chapter, verse);
        const wkey = `${normalizeWordText(row.orig_words)}#${row.occurrence}`;
        const words = seqMap.get(wkey) ?? [];
        const context = twlAnchorContext(row.tw_link, twTitles);
        const anchorIdx = selectAnchor(words, context);
        const spanText = words.map((w) => w.text).join(" ");
        const anchorText = words.find((w) => w.index === anchorIdx)?.text ?? null;
        movedDetails.push({
          id,
          orig_words: row.orig_words,
          tw_link: row.tw_link,
          oldPos,
          newPos,
          spanWords: words.map((w) => w.text),
          anchor: anchorText,
        });
      }

      bookExamples.push({
        book,
        chapter,
        verse,
        ref: `${book} ${chapter}:${verse}`,
        before: beforeWords,
        after: afterWords,
        moved: movedDetails,
      });
    }
  }

  perBook.push({
    book,
    totalRows,
    changedRows,
    versesWithChange,
    multiRowVerses,
    totalVerseGroups: verseGroups.size,
    tierCounts,
    multiWordSpanRows,
    anchorShiftedRows,
  });

  allExamples.push(...bookExamples);
  allAnchorShiftExamples.push(...anchorShiftExamples);
}

console.log("=== PER-BOOK SUMMARY ===");
let grandTotalRows = 0;
let grandChangedRows = 0;
let grandVersesWithChange = 0;
let grandMultiRowVerses = 0;
const grandTiers = { tier1_headword: 0, tier2_skip_function: 0, tier3_fallback: 0, unresolved: 0 };

for (const b of perBook) {
  grandTotalRows += b.totalRows;
  grandChangedRows += b.changedRows;
  grandVersesWithChange += b.versesWithChange;
  grandMultiRowVerses += b.multiRowVerses;
  for (const t of Object.keys(grandTiers)) grandTiers[t] += b.tierCounts[t];

  const pctRows = ((b.changedRows / b.totalRows) * 100).toFixed(2);
  const pctVerses =
    b.multiRowVerses > 0 ? ((b.versesWithChange / b.multiRowVerses) * 100).toFixed(2) : "N/A";
  const pctAnchorShift =
    b.multiWordSpanRows > 0 ? ((b.anchorShiftedRows / b.multiWordSpanRows) * 100).toFixed(2) : "N/A";
  console.log(
    `${b.book}: rows=${b.totalRows} changed=${b.changedRows} (${pctRows}%) | ` +
      `verseGroups=${b.totalVerseGroups} multiRowVerses=${b.multiRowVerses} versesWithChange=${b.versesWithChange} (${pctVerses}% of multi-row verses) | ` +
      `tiers: t1=${b.tierCounts.tier1_headword} t2=${b.tierCounts.tier2_skip_function} t3=${b.tierCounts.tier3_fallback} unresolved=${b.tierCounts.unresolved} | ` +
      `anchorShifted=${b.anchorShiftedRows}/${b.multiWordSpanRows} multi-word spans (${pctAnchorShift}%)`,
  );
  if (b.totalRows > 0 && b.changedRows / b.totalRows > 0.25) {
    console.log(`  *** FLAG: ${b.book} has >25% of rows changed ***`);
  }
}

console.log("\n=== GRAND TOTAL ===");
console.log(`totalRows=${grandTotalRows}`);
console.log(
  `changedRows=${grandChangedRows} (${((grandChangedRows / grandTotalRows) * 100).toFixed(2)}%)`,
);
console.log(
  `versesWithChange=${grandVersesWithChange} / multiRowVerses=${grandMultiRowVerses} (${
    grandMultiRowVerses > 0
      ? ((grandVersesWithChange / grandMultiRowVerses) * 100).toFixed(2)
      : "N/A"
  }%)`,
);
console.log(
  `tiers: tier1_headword=${grandTiers.tier1_headword} tier2_skip_function=${grandTiers.tier2_skip_function} tier3_fallback=${grandTiers.tier3_fallback} unresolved=${grandTiers.unresolved}`,
);

let grandMultiWordSpanRows = 0;
let grandAnchorShiftedRows = 0;
for (const b of perBook) {
  grandMultiWordSpanRows += b.multiWordSpanRows;
  grandAnchorShiftedRows += b.anchorShiftedRows;
}
console.log(
  `anchorShiftedRows (multi-word span, anchor != first word) = ${grandAnchorShiftedRows} / ${grandMultiWordSpanRows} multi-word-span rows (${(
    (grandAnchorShiftedRows / grandMultiWordSpanRows) *
    100
  ).toFixed(2)}%); out of ${grandTotalRows} total rows that's ${(
    (grandAnchorShiftedRows / grandTotalRows) *
    100
  ).toFixed(2)}%`,
);

console.log("\n=== VERSE-ORDER-CHANGE EXAMPLES (rows whose position within the verse actually flipped) ===");
console.log(JSON.stringify(allExamples, null, 2));

console.log("\n=== ANCHOR-SHIFT EXAMPLES (up to 40, anchor moved off first word, may or may not have changed visible order) ===");
console.log(JSON.stringify(allAnchorShiftExamples, null, 2));
