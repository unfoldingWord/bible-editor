// Smoke test for verseRange.ts helpers. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/verseRange.test.mjs

import {
  verseSpan,
  isRangeRow,
  formatVerseLabel,
  buildVerseIndex,
  isFirstOfRange,
  rangeSize,
  concatSourceRange,
  noteCoveredVerses,
  coveredVersesKey,
  versesFromKey,
  noteOverlapsRange,
  sourceForTargetRow,
  rowHighlightsFor,
} from "./verseRange.ts";
import usfm from "usfm-js";
import { verseHasUnalignedWork } from "./alignment.ts";
import { highlightsFor } from "./highlight.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function mkVerse(verse, verseEnd, voCount = 1) {
  return {
    book: "ISA",
    chapter: 7,
    verse,
    verse_end: verseEnd,
    bible_version: "UST",
    plain_text: `verse ${verse}`,
    version: 1,
    updated_by: null,
    updated_at: 0,
    content: {
      verseObjects: Array.from({ length: voCount }, (_, i) => ({
        type: "text",
        text: `v${verse}.${i} `,
      })),
    },
  };
}

// --- verseSpan / isRangeRow / rangeSize / isFirstOfRange ---
{
  const single = mkVerse(7, null);
  const range = mkVerse(6, 9);
  assert(verseSpan(single)[0] === 7 && verseSpan(single)[1] === 7, "singleton span is [n,n]");
  assert(verseSpan(range)[0] === 6 && verseSpan(range)[1] === 9, "range span is [6,9]");
  assert(!isRangeRow(single), "singleton is not a range row");
  assert(isRangeRow(range), "6-9 is a range row");
  assert(rangeSize(single) === 1, "singleton size is 1");
  assert(rangeSize(range) === 4, "6-9 size is 4");
  assert(isFirstOfRange(range, 6), "v=6 is first of 6-9");
  assert(!isFirstOfRange(range, 7), "v=7 is not first of 6-9");
}

// --- formatVerseLabel ---
{
  assert(formatVerseLabel(mkVerse(7, null)) === "7", "singleton label is '7'");
  assert(formatVerseLabel(mkVerse(6, 9)) === "6-9", "range label is '6-9'");
  // verse_end equal to verse (defensive) → treat as singleton
  assert(formatVerseLabel(mkVerse(7, 7)) === "7", "verse_end === verse → singleton label");
}

// --- buildVerseIndex ---
{
  const byStart = {
    1: mkVerse(1, null),
    6: mkVerse(6, 9),
    10: mkVerse(10, null),
  };
  const idx = buildVerseIndex(byStart);
  assert(idx[1]?.verse === 1, "singleton 1 indexed at key 1");
  assert(idx[6]?.verse === 6, "range start indexed at 6");
  assert(idx[7] === idx[6], "verse 7 inside 6-9 resolves to same DTO reference");
  assert(idx[8] === idx[6], "verse 8 inside 6-9 resolves to same DTO reference");
  assert(idx[9] === idx[6], "verse 9 inside 6-9 resolves to same DTO reference");
  assert(idx[10]?.verse === 10, "singleton 10 indexed at key 10");
  assert(idx[11] === undefined, "verse 11 not present");
}

// --- concatSourceRange ---
{
  // Singleton range → returns input unchanged
  const single = mkVerse(7, null);
  const out = concatSourceRange({ 7: single }, 7, 7);
  assert(out === single, "single-verse range returns the input row");
}
{
  // Multi-verse range → concatenates verseObjects with separators
  const byStart = {
    6: mkVerse(6, null, 2),
    7: mkVerse(7, null, 1),
    8: mkVerse(8, null, 1),
    9: mkVerse(9, null, 1),
  };
  const combined = concatSourceRange(byStart, 6, 9);
  assert(combined !== null, "combined range produces a DTO");
  assert(combined.verse === 6 && combined.verse_end === 9, "synthetic DTO carries span 6-9");
  const vos = combined.content.verseObjects;
  // 2 from v6 + 1 sep + 1 from v7 + 1 sep + 1 from v8 + 1 sep + 1 from v9 = 8
  assert(vos.length === 8, `combined has 8 verseObjects (got ${vos.length})`);
  assert(vos[0].text === "v6.0 ", "first vo is from v6");
  assert(vos[vos.length - 1].text === "v9.0 ", "last vo is from v9");
}
{
  // Missing rows in the range → skip silently
  const byStart = {
    6: mkVerse(6, null, 1),
    9: mkVerse(9, null, 1),
  };
  const combined = concatSourceRange(byStart, 6, 9);
  assert(combined !== null, "partial range still produces a DTO");
  const vos = combined.content.verseObjects;
  // 1 from v6 + 1 sep + 1 from v9 = 3
  assert(vos.length === 3, `partial combined has 3 verseObjects (got ${vos.length})`);
}
{
  // Memoized (#889): the same map + range returns the same object, so the
  // aligner's parseAlignment memo isn't busted by a props rebuild.
  const byStart = { 6: mkVerse(6, null), 7: mkVerse(7, null), 8: mkVerse(8, null) };
  const a = concatSourceRange(byStart, 6, 8);
  assert(concatSourceRange(byStart, 6, 8) === a, "repeat call on same map returns cached object");
  const b = concatSourceRange(byStart, 6, 7);
  assert(b !== a && b.verse_end === 7, "different range on same map is its own entry");
  // Same content in a fresh map (a refetch) → rebuilt, equal content.
  const copy = { ...byStart };
  const c = concatSourceRange(copy, 6, 8);
  assert(c !== a && JSON.stringify(c) === JSON.stringify(a), "new map identity rebuilds with equal content");
  // A row replaced IN PLACE under the same map must not serve the stale concat.
  byStart[7] = { ...mkVerse(7, null), content: { verseObjects: [{ type: "text", text: "NEW " }] } };
  const d = concatSourceRange(byStart, 6, 8);
  assert(d !== a, "in-place row replacement invalidates the cached entry");
  assert(d.content.verseObjects.some((o) => o.text === "NEW "), "rebuilt concat carries the replaced row");
  // A row added in place (previously missing) also invalidates.
  const sparse = { 6: mkVerse(6, null), 8: mkVerse(8, null) };
  const e = concatSourceRange(sparse, 6, 8);
  sparse[7] = mkVerse(7, null);
  const f = concatSourceRange(sparse, 6, 8);
  assert(f !== e && f.content.verseObjects.length === 5, "in-place row insertion invalidates the cached entry");
}

// --- noteCoveredVerses (tn/tq references, parsed from ref_raw) ---
{
  const cv = (verse, ref_raw) => JSON.stringify(noteCoveredVerses({ verse, ref_raw }));
  assert(cv(2, "1:2") === "[2]", "singleton ref → [2]");
  assert(cv(2, "1:2-3") === "[2,3]", "bridge 1:2-3 → [2,3]");
  assert(cv(2, "1:2-5") === "[2,3,4,5]", "bridge 1:2-5 expands → [2,3,4,5]");
  // Leading verse is authoritative for the start even if ref_raw drifts.
  assert(cv(2, "2-4") === "[2,3,4]", "colon-less range → [2,3,4]");
  // Comma-separated (discontinuous) references union each segment.
  assert(cv(2, "1:2,4") === "[2,4]", "comma list 1:2,4 → [2,4]");
  assert(cv(2, "1:2-3,5") === "[2,3,5]", "range+comma 1:2-3,5 → [2,3,5]");
  // Cross-chapter segment not supported → skipped, leading verse remains.
  assert(cv(2, "1:2-2:3") === "[2]", "cross-chapter end → leading only");
  // Descending / malformed range → leading verse only.
  assert(cv(3, "1:3-2") === "[3]", "descending range → leading only");
  assert(cv(5, null) === "[5]", "null ref → [5]");
  assert(cv(0, "1:intro") === "[0]", "intro ref → [0]");
  // Malformed huge range from free-text input is bounded (no runaway loop).
  assert(noteCoveredVerses({ verse: 1, ref_raw: "1:1-1000000000" }).length <= 402, "huge range is bounded");
}

// --- coveredVersesKey / versesFromKey ---
{
  const rows = [
    { verse: 5, ref_raw: "1:5" },
    { verse: 2, ref_raw: "1:2-3" },
    { verse: 5, ref_raw: "1:5" },
    { verse: 0, ref_raw: "1:intro" },
  ];
  assert(coveredVersesKey(rows) === "0,2,3,5", "key is sorted, unique, bridges expanded");
  // Row order / note text don't matter — only which verses are covered.
  assert(coveredVersesKey([...rows].reverse()) === coveredVersesKey(rows), "key ignores row order");
  assert(coveredVersesKey([]) === "", "no rows → empty key");
  assert(JSON.stringify([...versesFromKey("0,2,3,5")]) === "[0,2,3,5]", "versesFromKey round-trips");
  assert(versesFromKey("").size === 0, "empty key → empty set (not {0})");
}

// --- noteOverlapsRange ---
{
  const bridge = { verse: 2, ref_raw: "1:2-3" };
  assert(noteOverlapsRange(bridge, 2, 2), "bridge 2-3 shows on verse 2");
  assert(noteOverlapsRange(bridge, 3, 3), "bridge 2-3 shows on verse 3");
  assert(!noteOverlapsRange(bridge, 4, 4), "bridge 2-3 hidden on verse 4");
  assert(!noteOverlapsRange(bridge, 1, 1), "bridge 2-3 hidden on verse 1");
  // Discontinuous ref shows on its listed verses but not the gap between them.
  const gap = { verse: 2, ref_raw: "1:2,4" };
  assert(noteOverlapsRange(gap, 4, 4), "gap ref 2,4 shows on verse 4");
  assert(!noteOverlapsRange(gap, 3, 3), "gap ref 2,4 hidden on verse 3");
  const single = { verse: 5, ref_raw: "1:5" };
  assert(noteOverlapsRange(single, 5, 5), "singleton shows on its verse");
  assert(!noteOverlapsRange(single, 6, 6), "singleton hidden elsewhere");
}

// ─── #957: reading-column source for a bridged target row ────────────────
// A ULT/UST bridge (verse=1, verse_end=2) aligns against UHB 1 AND 2. The
// unaligned indicator used to be handed only UHB 1, so a source word from the
// LAST verse of the bridge that no target word aligned to went unflagged.
{
  console.log("\n[Case] sourceForTargetRow covers the whole bridge (#957)");
  const vo = (raw) => {
    const json = usfm.toJSON(raw);
    const ch = Object.keys(json.chapters)[0];
    return Object.fromEntries(
      Object.entries(json.chapters[ch]).filter(([k]) => /^\d/.test(k)).map(([k, v]) => [k, v.verseObjects]),
    );
  };
  const src = vo(String.raw`\id ZEC
\c 1
\v 1 \w דָּבָר|lemma="דָּבָר" strong="H1697" x-morph="He,Ncmsc"\w*
\v 2 \w יְהוָה|lemma="יְהוָה" strong="H3068" x-morph="He,Np"\w*
`);
  // Target aligns the verse-1 word only; UHB 2's יְהוָה has no target word.
  const tgt = vo(String.raw`\id ZEC
\c 1
\v 1-2 \zaln-s |x-strong="H1697" x-lemma="דָּבָר" x-morph="He,Ncmsc" x-occurrence="1" x-occurrences="1" x-content="דָּבָר"\*\w word|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
`);
  const mk = (verse, verseEnd, verseObjects, bv) => ({
    book: "ZEC", chapter: 1, verse, verse_end: verseEnd, bible_version: bv,
    plain_text: null, version: 1, updated_by: null, updated_at: 0, content: { verseObjects },
  });
  const uhb = { 1: mk(1, null, src["1"], "UHB"), 2: mk(2, null, src["2"], "UHB") };
  const bridgeVO = tgt["1-2"] ?? tgt["1"];
  const bridge = mk(1, 2, bridgeVO, "ULT");
  assert(Array.isArray(bridgeVO), "bridged target parsed");
  // Old call-site shape (first verse only) misses the unaligned verse-2 word.
  assert(!verseHasUnalignedWork(bridgeVO, uhb[1].content.verseObjects),
    "baseline: first-verse source alone reports the bridge as fully aligned");
  const combined = sourceForTargetRow(uhb, bridge);
  assert(combined?.verse === 1 && combined?.verse_end === 2, "combined source spans 1-2");
  assert(verseHasUnalignedWork(bridgeVO, combined?.content?.verseObjects),
    "bridge flags the unaligned UHB word from its LAST verse");
  // Singletons are unchanged: the source is the very same row object.
  const single = mk(1, null, bridgeVO, "ULT");
  assert(sourceForTargetRow(uhb, single) === uhb[1], "singleton target gets its own source row");
  assert(sourceForTargetRow(uhb, null) === null, "no target row: no source");

  // A note's occurrence counts within ITS OWN verse, but a bridged row's
  // milestones number source words across the whole span (the aligner counts
  // over concatSourceRange; Door43 bridges do the same, e.g. JER 9:25-26 UST
  // עַל 1/2 + 2/2). A TN on 1:2 with occurrence 1 must light the English
  // aligned to UHB 1:2's instance, not 1:1's.
  console.log("\n[Case] note inside a bridge resolves its own verse's instance (#957)");
  const src2 = vo(String.raw`\id ZEC
\c 1
\v 1 \w יְהוָה|lemma="יְהוָה" strong="H3068" x-morph="He,Np"\w*
\v 2 \w יְהוָה|lemma="יְהוָה" strong="H3068" x-morph="He,Np"\w*
`);
  const tgt2 = vo(String.raw`\id ZEC
\c 1
\v 1-2 \zaln-s |x-strong="H3068" x-lemma="יְהוָה" x-morph="He,Np" x-occurrence="1" x-occurrences="2" x-content="יְהוָה"\*\w Yahweh|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* spoke; \zaln-s |x-strong="H3068" x-lemma="יְהוָה" x-morph="He,Np" x-occurrence="2" x-occurrences="2" x-content="יְהוָה"\*\w LORD|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
`);
  const uhb2 = { 1: mk(1, null, src2["1"], "UHB"), 2: mk(2, null, src2["2"], "UHB") };
  const bridge2 = mk(1, 2, tgt2["1-2"] ?? tgt2["1"], "ULT");
  const quote = "יְהוָה";
  const hlV2 = rowHighlightsFor("ULT", bridge2, quote, 1, uhb2, 2);
  assert(hlV2.has("LORD|1") && !hlV2.has("Yahweh|1"), `TN on 1:2 occ 1 lights LORD only (got ${[...hlV2]})`);
  const hlV1 = rowHighlightsFor("ULT", bridge2, quote, 1, uhb2, 1);
  // A first-verse note joins exactly as on main (that verse's source alone),
  // where the appears-once collapse folds 1/2 and 2/2 together, so both copies
  // light. Kept on purpose: it keeps main's milestone repairs (#957 review 2).
  const mainV1 = highlightsFor("ULT", bridge2.content, quote, 1, uhb2[1].content);
  assert(hlV1.has("Yahweh|1") && [...hlV1].join() === [...mainV1].join(), `TN on 1:1 occ 1 lights Yahweh, same as main (got ${[...hlV1]})`);
  const hlAll = rowHighlightsFor("ULT", bridge2, quote, -1, uhb2, 2);
  assert(hlAll.has("LORD|1") && !hlAll.has("Yahweh|1"), `occurrence -1 on 1:2 means every match in 1:2 only (got ${[...hlAll]})`);
  const single2 = mk(2, null, bridge2.content.verseObjects, "ULT");
  assert([...rowHighlightsFor("ULT", single2, quote, 1, uhb2, 2)].join() === [...highlightsFor("ULT", single2.content, quote, 1, uhb2[2].content)].join(),
    "singleton target: same as the ordinary join on its own source verse");

  // Not every bridge numbers across the span: a 2026-09-24 prod scan of the 83
  // UST bridges found 143 repeated-word milestones numbered PER VERSE (1/1 in
  // each verse, e.g. 1CH 4:17-18 אֶת) beside 71 numbered across it. Shifting a
  // per-verse row's occurrence points at an x-occurrence that doesn't exist and
  // lights nothing, so the shift must only apply when the row counts the word
  // across the span; otherwise keep main's behavior (both copies light).
  console.log("\n[Case] per-verse-numbered bridge keeps the unshifted occurrence (#957)");
  const tgt3 = vo(String.raw`\id ZEC
\c 1
\v 1-2 \zaln-s |x-strong="H3068" x-lemma="יְהוָה" x-morph="He,Np" x-occurrence="1" x-occurrences="1" x-content="יְהוָה"\*\w Yahweh|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* spoke; \zaln-s |x-strong="H3068" x-lemma="יְהוָה" x-morph="He,Np" x-occurrence="1" x-occurrences="1" x-content="יְהוָה"\*\w LORD|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
`);
  const bridge3 = mk(1, 2, tgt3["1-2"] ?? tgt3["1"], "ULT");
  const hlV2pv = rowHighlightsFor("ULT", bridge3, quote, 1, uhb2, 2);
  assert(hlV2pv.has("LORD|1"), `per-verse bridge: TN on 1:2 still lights LORD (got ${[...hlV2pv]})`);
}

// ─── #957 review: mixed numbering, unaligned first word, partial groups ──
// `rowHL` is the call-site shape every reading view uses for a bridged
// ULT/UST row: the row, the note's quote/occurrence/own verse, and the
// per-verse source map.
{
  const vo = (raw) => {
    const json = usfm.toJSON(raw);
    const ch = Object.keys(json.chapters)[0];
    return Object.fromEntries(
      Object.entries(json.chapters[ch]).filter(([k]) => /^\d/.test(k)).map(([k, v]) => [k, v.verseObjects]),
    );
  };
  const mk = (verse, verseEnd, verseObjects, bv) => ({
    book: "ZEC", chapter: 1, verse, verse_end: verseEnd, bible_version: bv,
    plain_text: null, version: 1, updated_by: null, updated_at: 0, content: { verseObjects },
  });
  const rowHL = (row, quote, occ, byVerse, noteVerse, partial = false) =>
    rowHighlightsFor("ULT", row, quote, occ, byVerse, noteVerse, partial);
  const W = (s) => String.raw`\w ${s}|lemma="${s}" strong="H1" x-morph="He,X"\w*`;
  const Z = (src, occ, occs, gloss) =>
    String.raw`\zaln-s |x-strong="H1" x-lemma="${src}" x-morph="He,X" x-occurrence="${occ}" x-occurrences="${occs}" x-content="${src}"\*\w ${gloss}|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*`;
  const A = "אֶת", B = "יְהוָה", C = "דָּבָר", P = "קָצַף", X = "עַל", Q = "שָׁלוֹם";
  const src = (verses) => {
    const parsed = vo(`\\id ZEC\n\\c 1\n${verses.map((ws, i) => `\\v ${i + 1} ${ws.map(W).join(" ")}`).join("\n")}\n`);
    return Object.fromEntries(verses.map((_, i) => [i + 1, mk(i + 1, null, parsed[String(i + 1)], "UHB")]));
  };
  const bridge = (end, body) => {
    const parsed = vo(`\\id ZEC\n\\c 1\n\\v 1-${end} ${body}\n`);
    return mk(1, end, parsed[`1-${end}`] ?? parsed["1"], "ULT");
  };
  const show = (hl) => [...hl].join(",");

  console.log("\n[Case] per-verse bridge whose first quote word is unaligned (#957 review)");
  {
    const uhb = src([[A, B], [A, B]]);
    // A has no marker in the target; B is numbered per verse (1/1 in each).
    const row = bridge(2, [String.raw`\w a1|x-occurrence="1" x-occurrences="2"\w*`, Z(B, 1, 1, "b1"),
      String.raw`\w a2|x-occurrence="2" x-occurrences="2"\w*`, Z(B, 1, 1, "b2")].join(" "));
    const hl = rowHL(row, `${A} ${B}`, 1, uhb, 2);
    assert(hl.has("b2|1"), `TN on 1:2 still lights the English for B (got ${show(hl)})`);
  }

  console.log("\n[Case] mixed numbering in one row: first word across the span, second per verse (#957 review)");
  {
    const uhb = src([[B, C], [B, C]]);
    const row = bridge(2, [Z(B, 1, 2, "b1"), Z(C, 1, 1, "c1"), Z(B, 2, 2, "b2"), Z(C, 1, 1, "c2")].join(" "));
    const hl = rowHL(row, `${B} ${C}`, 1, uhb, 2);
    assert(hl.has("b2|1") && hl.has("c2|1") && !hl.has("b1|1"), `TN on 1:2 lights b2 and c2, not b1 (got ${show(hl)})`);
  }

  console.log("\n[Case] mixed numbering in one row: first word per verse, second across the span (#957 review)");
  {
    const uhb = src([[B, C], [B, C]]);
    const row = bridge(2, [Z(B, 1, 1, "b1"), Z(C, 1, 2, "c1"), Z(B, 1, 1, "b2"), Z(C, 2, 2, "c2")].join(" "));
    const hl = rowHL(row, `${B} ${C}`, 1, uhb, 2);
    assert(hl.has("c2|1") && !hl.has("c1|1"), `TN on 1:2 lights c2, not c1 (got ${show(hl)})`);
  }

  console.log("\n[Case] multi-verse note on a bridge: a later group never lands in an earlier verse (#957 review)");
  {
    // Bridge 1-3. The note is 1:2-4 ("P & X & Q"): P in v2, X in v3, Q in v4,
    // which is outside this row, so the strict match fails and each group
    // is matched on its own. X also occurs in v1.
    const uhb = src([[X], [P], [X]]);
    const row = bridge(3, [Z(X, 1, 2, "x1"), Z(P, 1, 1, "p2"), Z(X, 2, 2, "x3")].join(" "));
    const hl = rowHL(row, `${P} & ${X} & ${Q}`, 1, uhb, 2, true);
    assert(hl.has("p2|1") && hl.has("x3|1") && !hl.has("x1|1"), `partial note lights p2 and x3, not x1 (got ${show(hl)})`);
  }

  console.log("\n[Case] note on a bridge's FIRST verse keeps main's single-verse join (#957 review 2)");
  {
    // v1 holds B once, v2 once; the row numbers B across the span.
    const uhb = src([[B], [B]]);
    const row = bridge(2, [Z(B, 1, 2, "b1"), Z(B, 2, 2, "b2")].join(" "));
    const hl = rowHL(row, B, 2, uhb, 1);
    const main = highlightsFor("ULT", row.content, B, 2, uhb[1].content);
    assert(!hl.has("b2|1") && show(hl) === show(main), `TN on 1:1 occ 2 (v1 has one copy) does not light v2's copy (got ${show(hl)}, main ${show(main)})`);
  }
  {
    // v1 holds B twice, v2 once; occurrence -1 on 1:1 means v1's copies only.
    const uhb = src([[B, B], [B]]);
    const row = bridge(2, [Z(B, 1, 3, "b1a"), Z(B, 2, 3, "b1b"), Z(B, 3, 3, "b2")].join(" "));
    const hl = rowHL(row, B, -1, uhb, 1);
    assert(hl.has("b1a|1") && hl.has("b1b|1") && !hl.has("b2|1"), `TN on 1:1 occ -1 lights v1's English only (got ${show(hl)})`);
  }

  console.log("\n[Case] later-verse note whose quote does not resolve from its verse falls back to that verse alone (#957 review 2)");
  {
    // The source map lacks v2; the quote C exists only in v1.
    const uhb = src([[C], [B]]);
    delete uhb[2];
    const row = bridge(2, [Z(C, 1, 1, "c1"), Z(B, 1, 1, "b2")].join(" "));
    const hl = rowHL(row, C, 1, uhb, 2);
    assert(hl.size === 0, `no source for 1:2: nothing lights (got ${show(hl)})`);
  }
  {
    const uhb = src([[C, C], [B]]);
    const row = bridge(2, [Z(C, 1, 2, "c1a"), Z(C, 2, 2, "c1b"), Z(B, 1, 1, "b2")].join(" "));
    const hl = rowHL(row, C, 1, uhb, 2);
    const main = highlightsFor("ULT", row.content, C, 1, uhb[2].content);
    assert(show(hl) === show(main), `unresolved later-verse quote matches main's rows view on 1:2 (got ${show(hl)}, main ${show(main)})`);
  }
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll verseRange smoke checks passed.");
