// Regression tests for the OL-anchored ULT/UST highlight join in highlight.ts.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/highlight.test.mjs
//
// Both cases below come from ZEC 11:16 (issue #371), where the figs-litany note
// quoting the whole second sentence left "the meat of" and "their hooves" dark
// in the UST and the 2nd/4th "not" dark in the ULT.

import {
  findTargetHighlights,
  isPaintableHtml,
  leadingBreakClass,
  overlayFindMarks,
  pinSourceOccurrences,
  renderEditableHTML,
  renderHighlightedHTML,
  surfaceTotalsFromTokens,
} from "./highlight.ts";
import { extractEditableText, extractTrailingMarkers } from "./usfm.ts";
import { buildQuoteFromSelection, selectionFromQuote, tokenKey, collectTargetTokens } from "./quoteBuilder.ts";

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

// --- 7-11. DAN 6:3 (issue: note `fhez`). כָּל appears twice: כָּ⁠ל (with
// U+2060 WORD JOINER) then bare כָּל. matchNorm strips the joiner, so both
// UHB tokens — and both ULT `\zaln-s` milestones, each legitimately stamped
// occurrence="1"/occurrences="1" before folding — collapse to the same
// (content, occurrence) key. Without pinning, quoting the FIRST instance lit
// BOTH milestones' targets ("all before that" AND "all of"); picking the
// first three source words phantom-selected the second כָּל too, producing
// "כָּ⁠ל־קֳבֵ֗ל דִּ֣י & כָּל". nfc() (which preserves the joiner, unlike
// matchNorm) tells the two apart.
const JOIN = "⁠";
{
  const source = [
    src("א"),
    src(`כ${JOIN}ל`), // 1st כל — WITH word joiner
    src("ב"),
    src("כל"), // 2nd כל — WITHOUT word joiner
    src("ג"),
  ];
  const target = [
    zaln(`כ${JOIN}ל`, 1, 1, [tgt("all")]),
    zaln("כל", 1, 1, [tgt("every")]),
  ];

  // --- 7. Quote resolving to the FIRST instance highlights only the first
  // milestone's target words.
  {
    const got = lit(target, "כל", 1, source);
    assert(JSON.stringify(got) === JSON.stringify(["all"]), `1st כל lights only "all", got ${JSON.stringify(got)}`);
  }

  // --- 8. Quote resolving to the SECOND instance highlights only the
  // second's.
  {
    const got = lit(target, "כל", 2, source);
    assert(
      JSON.stringify(got) === JSON.stringify(["every"]),
      `2nd כל lights only "every", got ${JSON.stringify(got)}`,
    );
  }

  // --- 9. Guard: a genuine split gloss (two milestones with IDENTICAL raw
  // content for one source token) must still MERGE and light both fragments
  // — pinning must not fire when the milestones' nfc(content) aren't
  // pairwise distinct, even though the source holds the surface twice.
  {
    const splitTarget = [zaln("כל", 1, 1, [tgt("partA")]), zaln("כל", 1, 1, [tgt("partB")])];
    const got = lit(splitTarget, "כל", 1, source);
    assert(
      JSON.stringify(got) === JSON.stringify(["partA", "partB"]),
      `identical-content split gloss still merges, got ${JSON.stringify(got)}`,
    );
  }

  // --- 10. collectUhbWords / buildQuoteFromSelection: selecting the first
  // three words yields a quote with occurrence 1 and NO "& כל" tail (the old
  // bug: reading the always-1 x-occurrence attribute keyed both כל tokens
  // identically, so the phantom 2nd instance always tagged along).
  {
    const wordSep = (t) => ({ type: "text", text: t });
    const verseObjects = [
      src("א"),
      wordSep(" "),
      src(`כ${JOIN}ל`),
      wordSep(" "),
      src("ב"),
      wordSep(" "),
      src("כל"),
      wordSep(" "),
      src("ג"),
    ];
    const selectedKeys = new Set([tokenKey("א", 1), tokenKey(`כ${JOIN}ל`, 1), tokenKey("ב", 1)]);
    const built = buildQuoteFromSelection(verseObjects, selectedKeys);
    assert(built?.occurrence === 1, `built occurrence is 1, got ${JSON.stringify(built)}`);
    assert(
      built?.quote === `א ${`כ${JOIN}ל`} ב`,
      `built quote has no phantom "& כל" tail, got ${JSON.stringify(built?.quote)}`,
    );
    assert(!built?.quote.includes("&"), `built quote has no gap marker, got ${JSON.stringify(built?.quote)}`);

    // --- 11. selectionFromQuote on that stored quote pre-seeds exactly the
    // 3 ORIGINAL keys, not 4 (the old bug: the picker opening on this quote
    // would pre-select both כל tokens) — and not merely 3 of ANY keys, which
    // would still pass if the WRONG כל (the bare one, "ב"'s neighbour "כל")
    // were seeded instead of the joined כ⁠ל.
    const reseeded = selectionFromQuote(verseObjects, built.quote, built.occurrence);
    const expectedKeys = new Set([tokenKey("א", 1), tokenKey(`כ${JOIN}ל`, 1), tokenKey("ב", 1)]);
    assert(
      reseeded.size === expectedKeys.size &&
        [...expectedKeys].every((k) => reseeded.has(k)),
      `selectionFromQuote pre-seeds exactly {${[...expectedKeys].join(", ")}}, got {${[...reseeded].join(", ")}}`,
    );
  }
}

// --- 12. pinSourceOccurrences corroboration guard: a LONE milestone for an
// ambiguous (2-occurrence) source surface must NOT be pinned — one raw
// x-content match is an unverified claim (AI mangling can drop a word's
// joiner, e.g. writing כ⁠ל bare as כל, which would then nfc-match the WRONG
// token). Two competing milestones for the same surface corroborate each
// other (each nfc-matches a distinct token) and still pin, exactly as before
// this guard existed.
{
  const sourceTokens = [
    { text: `כ${JOIN}ל`, occurrence: 1, surfaceOccurrence: 1 },
    { text: "כל", occurrence: 1, surfaceOccurrence: 2 },
  ];
  const sourceTotals = surfaceTotalsFromTokens(sourceTokens);

  const lonePins = pinSourceOccurrences(["כל"], sourceTotals, sourceTokens);
  assert(
    lonePins.size === 0,
    `lone milestone for an ambiguous surface is not pinned, got ${JSON.stringify([...lonePins])}`,
  );

  const corroboratedPins = pinSourceOccurrences([`כ${JOIN}ל`, "כל"], sourceTotals, sourceTokens);
  assert(
    corroboratedPins.get(0) === 1 && corroboratedPins.get(1) === 2,
    `two corroborating milestones still pin to their distinct tokens, got ${JSON.stringify([...corroboratedPins])}`,
  );
}

// --- 13. collectTargetTokens (picker) applies the SAME appears-once
// collapse as collectMilestoneRuns' Pass 3 (ZEC 11:16 shape): the source
// holds וּ⁠בְשַׂר exactly once, but the UST stamps two milestones for it
// (occurrence="1"/occurrences="2" and "2"/"2" — both fields inflated). Both
// picker tokens must key to `…|1`, matching what the highlighter lights, so
// clicking either English word in the picker selects the one real UHB token.
{
  const sourceVerseObjects = [src("וּ⁠בְשַׂ֤ר")];
  const verseObjects = [
    zaln("וּ⁠בְשַׂ֤ר", 1, 2, [tgt("Instead")]),
    zaln("וּ⁠בְשַׂ֤ר", 2, 2, [tgt("meat")]),
  ];
  const tokens = collectTargetTokens(verseObjects, sourceVerseObjects);
  const expectedKey = tokenKey("וּ⁠בְשַׂ֤ר", 1);
  assert(
    tokens.length === 2 && tokens.every((t) => t.sources[0]?.key === expectedKey),
    `picker keys both split-gloss words to the same appears-once collapsed key, got ${JSON.stringify(
      tokens.map((t) => t.sources[0]?.key),
    )}`,
  );
}

// --- 14. isPaintableHtml (#529): an empty-string render must not be
// mistaken for real paintable content, or the paint effects in
// ScriptureColumn/DocColumn/BookView write it into the DOM and blank the
// pane with no way to type the text back.
{
  assert(isPaintableHtml("<div>hi</div>") === true, "non-empty HTML is paintable");
  assert(isPaintableHtml("") === false, "empty string is not paintable");
  assert(isPaintableHtml("   ") === false, "whitespace-only string is not paintable");
  assert(isPaintableHtml(null) === false, "null is not paintable");
  assert(isPaintableHtml(undefined) === false, "undefined is not paintable");
}

// --- 15. renderHighlightedHTML / renderEditableHTML on an empty verseObjects
// tree both render to "" (#529's source of the empty-string bug) — callers
// must treat that as isPaintableHtml(...) === false and fall back to
// plain_text rather than paint it.
{
  assert(renderHighlightedHTML([], new Set()) === "", "renderHighlightedHTML([]) is empty");
  assert(renderEditableHTML([], new Set()) === "", "renderEditableHTML([]) is empty");
  assert(extractEditableText([]) === "", "extractEditableText([]) is empty");
  assert(
    !isPaintableHtml(renderHighlightedHTML([], new Set())),
    "empty-tree render is correctly classified as not paintable",
  );
}

// --- 16. isPaintableHtml (#568): a marker-only tree (e.g. a lone \q1 with
// no following text) does NOT render to "" — segmentsToHtml fills the empty
// block with a zero-width space so contenteditable has a caret slot,
// producing non-empty-but-invisible markup. That must still count as not
// paintable so read-only paths fall back to plain_text instead of painting
// a text-free pane.
{
  const markerOnly = [{ type: "paragraph", tag: "q1" }];
  const rendered = renderHighlightedHTML(markerOnly, new Set());
  assert(rendered !== "", "marker-only render is non-empty markup (the #568 trap)");
  assert(
    !isPaintableHtml(rendered),
    `marker-only render with no visible text is correctly classified as not paintable, got ${JSON.stringify(rendered)}`,
  );
  assert(isPaintableHtml("<div>&nbsp;</div>") === false, "nbsp-only markup is not paintable");
  assert(isPaintableHtml("<div>hi</div>") === true, "markup with real text is still paintable");
}

// --- 17. overlayFindMarks (#642): the Find overlay must paint match marks
// onto the chip-bearing render, not substitute marker-free plain text for
// it — the editable cell stays contentEditable throughout, so whatever HTML
// lands here is exactly what a keystroke's save capture reads back. A
// marker-free substitute would delete every `\q`/`\p` chip from that
// capture the moment Find is open.
{
  const verseObjects = [
    { type: "paragraph", tag: "q1" },
    { type: "text", text: "For the LORD is good to those who wait." },
  ];
  const chipHtml = renderEditableHTML(verseObjects, new Set());
  const stripped = chipHtml.replace(/<[^>]*>/g, "");
  assert(
    stripped.includes("\\q1"),
    `sanity: the chip render's own textContent carries the \\q1 chip (got ${JSON.stringify(stripped)})`,
  );

  const painted = overlayFindMarks(chipHtml, /good/gi, null);
  const paintedText = painted.replace(/<[^>]*>/g, "");
  assert(
    paintedText.includes("\\q1"),
    `painted HTML's textContent still carries the \\q1 chip (got ${JSON.stringify(paintedText)})`,
  );
  assert(
    paintedText === stripped,
    `painting find marks changes only markup, never the underlying textContent a save capture reads (before=${JSON.stringify(stripped)}, after=${JSON.stringify(paintedText)})`,
  );
  assert(
    painted.includes('<mark class="be-find">good</mark>'),
    `the match is wrapped in a be-find mark (got ${JSON.stringify(painted)})`,
  );
}

// --- 18. overlayFindMarks: activeRange still flags the right occurrence as
// `be-find-active` when the run has no leading markers (the common case —
// verses with markers are documented as a known coordinate-mismatch, since
// activeRange is computed against marker-free plain_text).
{
  const verseObjects = [{ type: "text", text: "good news, very good." }];
  const chipHtml = renderEditableHTML(verseObjects, new Set());
  const painted = overlayFindMarks(chipHtml, /good/gi, { start: 16, end: 20 });
  const activeMarks = (painted.match(/<mark class="be-find be-find-active">good<\/mark>/g) || []).length;
  const plainMarks = (painted.match(/<mark class="be-find">good<\/mark>/g) || []).length;
  assert(activeMarks === 1, `exactly one occurrence is flagged active (got ${activeMarks} in ${JSON.stringify(painted)})`);
  assert(plainMarks === 1, `the other occurrence is flagged non-active (got ${plainMarks} in ${JSON.stringify(painted)})`);
}

// --- 19. overlayFindMarks: a match that would span two text runs (crossing
// a chip's own tag markup) is left undecorated rather than force-split —
// decoration only, and a botched split risks corrupting the markup a save
// capture reads.
{
  const html = '<span class="be-tok" data-tag="p">a</span>bc';
  const painted = overlayFindMarks(html, /ab/, null);
  assert(
    painted.replace(/<[^>]*>/g, "") === "abc",
    `textContent is unchanged when a match is skipped (got ${JSON.stringify(painted)})`,
  );
  assert(
    !painted.includes("<mark"),
    `no mark is inserted when the match would split a chip's markup (got ${JSON.stringify(painted)})`,
  );
}

// --- 20. overlayFindMarks: escaped punctuation round-trips through the
// decode/re-escape untouched (the entity decoder only understands this
// module's own fixed escaping, so a mismatch here would corrupt text).
{
  const verseObjects = [{ type: "text", text: `A & "B" good` }];
  const chipHtml = renderEditableHTML(verseObjects, new Set());
  const painted = overlayFindMarks(chipHtml, /good/, null);
  const strippedBefore = chipHtml.replace(/<[^>]*>/g, "");
  const strippedAfter = painted.replace(/<[^>]*>/g, "");
  assert(
    strippedAfter === strippedBefore,
    `textContent is byte-identical before/after painting (before=${JSON.stringify(strippedBefore)}, after=${JSON.stringify(strippedAfter)})`,
  );
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll highlight tests passed.");
