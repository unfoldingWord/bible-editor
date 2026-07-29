// Regression tests for the OL-anchored ULT/UST highlight join in highlight.ts.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/highlight.test.mjs
//
// Both cases below come from ZEC 11:16 (issue #371), where the figs-litany note
// quoting the whole second sentence left "the meat of" and "their hooves" dark
// in the UST and the 2nd/4th "not" dark in the ULT.

import { findTargetHighlights, leadingBreakClass } from "./highlight.ts";
import { extractTrailingMarkers } from "./usfm.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// UHB/UGNT `\w` as imported: NO x-occurrence attribute (hbo_uhb master has none).
const src = (text) => ({ type: "word", tag: "w", text });
// GL `\w` inside an alignment span.
const tgt = (text, occurrence = 1) => ({
  type: "word",
  tag: "w",
  text,
  occurrence: String(occurrence),
});
const zaln = (content, occurrence, occurrences, children) => ({
  type: "milestone",
  tag: "zaln",
  content,
  occurrence: String(occurrence),
  occurrences: String(occurrences),
  children,
});

const lit = (vo, quote, occurrence, source) =>
  [...findTargetHighlights(vo, quote, occurrence, source)].map((k) => k.split("|")[0]).sort();

// --- 1. Repeated source word: the join must use the COUNTED surface
// occurrence, because the OL tokens carry no x-occurrence of their own.
{
  const source = [
    src("הַ⁠נַּ֣עַר"),
    src("לֹֽא"),
    src("יִפְקֹד֙"),
    src("לֹֽא"),
    src("יְבַקֵּ֔שׁ"),
  ];
  const target = [
    zaln("לֹֽא", 1, 2, [tgt("attend-not")]),
    zaln("לֹֽא", 2, 2, [tgt("seek-not")]),
    zaln("יְבַקֵּ֔שׁ", 1, 1, [tgt("seek")]),
  ];
  const got = lit(target, "לֹֽא יְבַקֵּ֔שׁ", 1, source);
  assert(
    JSON.stringify(got) === JSON.stringify(["seek", "seek-not"]),
    `2nd לֹֽא lights only its own span, got ${JSON.stringify(got)}`,
  );
}

// --- 2. Impossible x-occurrence on a once-occurring source word. ZEC 11:16 UST
// stamps וּבְשַׂר as BOTH 1/2 and 2/2, so clamping into [1, occurrences] is a
// no-op and the continuation span never joins. The OL verse says the word
// occurs once, so both spans are the same logical token.
{
  const source = [src("וּ⁠בְשַׂ֤ר"), src("הַ⁠בְּרִיאָה֙")];
  const target = [
    zaln("וּ⁠בְשַׂ֤ר", 1, 2, [tgt("Instead")]),
    zaln("וּ⁠בְשַׂ֤ר", 2, 2, [tgt("meat")]),
    zaln("הַ⁠בְּרִיאָה֙", 1, 1, [tgt("fattest")]),
  ];
  const got = lit(target, "וּ⁠בְשַׂ֤ר", 1, source);
  assert(
    JSON.stringify(got) === JSON.stringify(["Instead", "meat"]),
    `split gloss stamped 1/2 + 2/2 lights both halves, got ${JSON.stringify(got)}`,
  );
}

// --- 3. Guard: a GENUINE repeat must still resolve per-instance. Same 1/2 +
// 2/2 stamping, but the source really does carry the word twice, so the clamp
// must NOT fold them together.
{
  const source = [src("לֹ֣א"), src("יְרַפֵּ֑א"), src("לֹ֣א"), src("יְכַלְכֵּ֔ל")];
  const target = [
    zaln("לֹ֣א", 1, 2, [tgt("heal-not")]),
    zaln("לֹ֣א", 2, 2, [tgt("sustain-not")]),
    zaln("יְכַלְכֵּ֔ל", 1, 1, [tgt("sustain")]),
  ];
  const got = lit(target, "לֹ֣א יְכַלְכֵּ֔ל", 1, source);
  assert(
    JSON.stringify(got) === JSON.stringify(["sustain", "sustain-not"]),
    `genuine repeat stays per-instance, got ${JSON.stringify(got)}`,
  );
}

// --- 4. Guard: with no OL verse the degraded GL-only set match is unchanged —
// no true source count is knowable, so nothing is clamped or renumbered.
{
  const target = [
    zaln("וּ⁠בְשַׂ֤ר", 1, 2, [tgt("Instead")]),
    zaln("וּ⁠בְשַׂ֤ר", 2, 2, [tgt("meat")]),
  ];
  const got = lit(target, "וּ⁠בְשַׂ֤ר", 1, undefined);
  assert(
    JSON.stringify(got) === JSON.stringify(["Instead"]),
    `no source verse degrades to the GL-only match, got ${JSON.stringify(got)}`,
  );
}

// --- 5. Guard: an AMBIGUOUS over-claim must not drag in a neighbour span. The
// source holds לֹ֣א twice but the GL stamps three spans (1/3, 2/3, 3/3). Which
// physical token span 3 meant is unknowable, so it must NOT be clamped onto
// span 2 — same restraint lib/sourceOccurrences.ts shows for trueTotal > 1.
{
  const source = [src("לֹ֣א"), src("יְרַפֵּ֑א"), src("לֹ֣א"), src("יְכַלְכֵּ֔ל")];
  const target = [
    zaln("לֹ֣א", 1, 3, [tgt("a")]),
    zaln("לֹ֣א", 2, 3, [tgt("b")]),
    zaln("לֹ֣א", 3, 3, [tgt("c")]),
    zaln("יְכַלְכֵּ֔ל", 1, 1, [tgt("sustain")]),
  ];
  const got = lit(target, "לֹ֣א יְכַלְכֵּ֔ל", 1, source);
  assert(
    JSON.stringify(got) === JSON.stringify(["b", "sustain"]),
    `ambiguous over-claim doesn't merge onto a neighbour, got ${JSON.stringify(got)}`,
  );
}

// --- 6. Guard: quoting an instance the GL never aligned must light NOTHING,
// not the other instance's words. The OL holds לֹֽא twice but only the first is
// aligned; lighting "not-one" for a quote on the second would be a confidently
// wrong highlight (and a wrong AI selection payload via
// extractTargetSelectionText). Silence is the honest answer.
{
  const source = [src("לֹֽא"), src("יִפְקֹד֙"), src("לֹֽא"), src("יְבַקֵּ֔שׁ")];
  const target = [zaln("לֹֽא", 1, 1, [tgt("not-one")]), zaln("יִפְקֹד֙", 1, 1, [tgt("attend")])];
  const got = lit(target, "לֹֽא", 2, source);
  assert(
    JSON.stringify(got) === JSON.stringify([]),
    `unaligned 2nd instance lights nothing, not the 1st, got ${JSON.stringify(got)}`,
  );
}

// --- 3. leadingBreakClass and `\ts\*` chunk dividers.
//
// The old implementation tested `tag === "ts"`, which cannot match usfm-js
// 3.5.0's real shape `{tag:"ts\\*"}` (the Micah 4 bug class). These cases pin
// both the marker-shape handling and — more importantly — the upstream contract
// that keeps the divider branch unreachable in the first place.
{
  // Every `\ts\*` shape usfm-js has produced.
  const shapes = [
    ["usfm-js 3.5.0", { tag: "ts\\*" }],
    ["editor-written", { tag: "ts*" }],
    ["legacy", { tag: "ts", content: "\\*" }],
  ];

  for (const [label, ts] of shapes) {
    assert(
      leadingBreakClass([ts]) === "be-line",
      `${label} \\ts\\* alone → plain block break, not be-ts / be-para (got ${JSON.stringify(leadingBreakClass([ts]))})`,
    );
    // A real line marker behind the divider still wins: it is the marker that
    // determines the verse's indent, and be-ts must never reach the span.
    assert(
      leadingBreakClass([{ type: "quote", tag: "q1" }, ts]) === "be-q be-q-1",
      `${label}: \\q1 then \\ts\\* → q1 indent wins`,
    );
  }

  // The contract that makes the divider branch dead code from DocColumn's one
  // call site: `\ts\*` marks a boundary AT the point it sits, so it never drifts
  // onto the next verse. This is the prod Micah 4 tail shape (`\q1` `\ts\*`).
  const drift = extractTrailingMarkers([
    { type: "text", text: "word" },
    { type: "quote", tag: "q1" },
    { tag: "ts\\*" },
  ]);
  assert(
    JSON.stringify(drift) === JSON.stringify([{ type: "quote", tag: "q1" }]),
    `extractTrailingMarkers drifts the \\q1 behind a \\ts\\* but not the divider (got ${JSON.stringify(drift)})`,
  );
  assert(
    leadingBreakClass(drift) === "be-q be-q-1",
    "Micah 4 tail: active verse keeps its \\q1 poetry indent",
  );

  assert(leadingBreakClass([]) === "", "no drifted markers → no class");
  assert(leadingBreakClass(null) === "", "null markers → no class");
  assert(
    leadingBreakClass([{ type: "paragraph", tag: "b" }]) === "be-line",
    "\\b blank marker → be-line, not be-blank",
  );
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll highlight tests passed.");
