// Regression tests for the OL-anchored ULT/UST highlight join in highlight.ts.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/highlight.test.mjs
//
// Both cases below come from ZEC 11:16 (issue #371), where the figs-litany note
// quoting the whole second sentence left "the meat of" and "their hooves" dark
// in the UST and the 2nd/4th "not" dark in the ULT.

import usfm from "usfm-js";
import {
  findTargetHighlights,
  findSourceHighlights,
  findSourceForTargetText,
  matchSourceTokens,
  extractTargetSelectionText,
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

// --- 21. overlayFindMarks (#646 review F2): `activeRange` arrives in
// marker-free plain_text coordinates, but the chip render carries the
// literal "\q1 " label — 4 characters that exist in no plain_text. Without
// translating between the two, `be-find-active` lands on the wrong
// occurrence (or, as here, on none at all) in every marker-bearing verse.
{
  const verseObjects = [
    { type: "paragraph", tag: "q1" },
    { type: "text", text: "good news, very good." },
  ];
  const chipHtml = renderEditableHTML(verseObjects, new Set());
  // plain_text for this verse is "good news, very good." — the second "good"
  // sits at 16 there, and at 20 in the chip render.
  const painted = overlayFindMarks(chipHtml, /good/gi, { start: 16, end: 20 });
  const actives = painted.match(/<mark class="be-find be-find-active">good<\/mark>/g) || [];
  assert(actives.length === 1, `exactly one occurrence is flagged active (got ${actives.length} in ${JSON.stringify(painted)})`);
  // The active one must be the SECOND — assert on position, not just count.
  const activeAt = painted.indexOf('<mark class="be-find be-find-active">');
  const plainAt = painted.indexOf('<mark class="be-find">');
  assert(
    plainAt !== -1 && plainAt < activeAt,
    `the ACTIVE mark is the second occurrence, not the first (got ${JSON.stringify(painted)})`,
  );
  assert(
    painted.replace(/<[^>]*>/g, "").includes("\\q1"),
    `the \\q1 chip survives the paint (got ${JSON.stringify(painted.replace(/<[^>]*>/g, ""))})`,
  );
}

// --- 22. overlayFindMarks (#646 review F3): a query that matches inside a
// chip's own literal label ("q" in "\q1") must not paint there. The chip is
// editor chrome, not verse text; the Find overlay counted no such match, so
// decorating one shows a hit the results list does not have.
{
  const verseObjects = [
    { type: "paragraph", tag: "q1" },
    { type: "text", text: "quiet waters" },
  ];
  const chipHtml = renderEditableHTML(verseObjects, new Set());
  const painted = overlayFindMarks(chipHtml, /q/gi, null);
  const marks = painted.match(/<mark class="be-find[^"]*">/g) || [];
  assert(marks.length === 1, `only the verse-text hit is painted, not the chip label (got ${marks.length} in ${JSON.stringify(painted)})`);
  assert(
    painted.includes('<span class="be-tok be-tok-q1" data-tag="q1">\\q1</span>'),
    `the chip label is left byte-for-byte alone (got ${JSON.stringify(painted)})`,
  );
}

// --- 23. overlayFindMarks (#646 review F1): note highlights split the chip
// render into separate text runs, and a find hit crossing a run boundary is
// deliberately skipped (see 19). So a multi-word query spanning a
// note-highlighted word paints NOTHING unless the editable cell renders with
// an empty highlight set while Find is open. This pins both halves: the
// highlighted render drops the phrase, the find-open render keeps it.
{
  const verseObjects = [
    { type: "text", text: "hold " },
    tgt("fast", 1),
    { type: "text", text: " to hope" },
  ];
  const withNoteHl = renderEditableHTML(verseObjects, new Set(["fast|1"]));
  assert(
    withNoteHl.includes('<mark class="be-hl">fast</mark>'),
    `sanity: the note highlight splits the run (got ${JSON.stringify(withNoteHl)})`,
  );
  const paintedOverHl = overlayFindMarks(withNoteHl, /hold fast/gi, null);
  assert(
    !paintedOverHl.includes("be-find"),
    `a phrase crossing a note highlight cannot be painted — which is why the cell must drop note highlights while Find is open (got ${JSON.stringify(paintedOverHl)})`,
  );

  const findOpen = renderEditableHTML(verseObjects, new Set());
  const painted = overlayFindMarks(findOpen, /hold fast/gi, null);
  assert(
    painted.includes('<mark class="be-find">hold fast</mark>'),
    `with no note highlights in the way the phrase paints (got ${JSON.stringify(painted)})`,
  );
}

// --- 24. isPaintableHtml (#646 review F5, #568 trap): a literal zero-width
// space must classify exactly like the `&#8203;` entity it decodes from.
// overlayFindMarks re-escapes the runs it touches, turning entities into
// literal characters — if only the entity form counted as invisible, a
// painted render could be judged "paintable" where its unpainted twin is not,
// and the pane would paint text-free markup.
{
  assert(
    isPaintableHtml('<div class="be-q-1">&#8203;</div>') === false,
    "the entity form of a caret-filler-only render is not paintable",
  );
  assert(
    isPaintableHtml('<div class="be-q-1">​</div>') === false,
    "the literal-character form classifies identically",
  );
  assert(
    isPaintableHtml('<div class="be-q-1">​word</div>') === true,
    "a filler next to real text is still paintable",
  );
}

// --- 25. Edge-punctuation quote matching (issue #322, ported from downstream
// fork commit 7e73e7e). en_tn quotes are cut straight out of the verse, so
// they carry sentence punctuation the OL `\w` token does not — MRK 13:2's
// figs-activepassive quote ends "… ἐπὶ λίθον, ὃς …" while the UGNT `\w` is a
// bare "λίθον" (the comma lives in a sibling text node). matchNorm now strips
// a conservative edge-punctuation class from both sides of every quote↔token
// equality; gap markers ("&", "…", "...") and the maqqef still split BEFORE
// any stripping, so they are untouched.
{
  const gw = (text, occurrence = 1, occurrences = 1) => ({
    type: "word", tag: "w", text,
    occurrence: String(occurrence), occurrences: String(occurrences),
  });
  const gt = (text) => ({ type: "text", text });
  const ugnt = [
    gw("καὶ"), gt(" "), gw("ὁ"), gt(" "), gw("Ἰησοῦς"), gt(" "),
    gw("εἶπεν"), gt(" "), gw("αὐτῷ"), gt(", "),
    gw("βλέπεις"), gt(" "), gw("ταύτας"), gt(" "), gw("τὰς"), gt(" "),
    gw("μεγάλας"), gt(" "), gw("οἰκοδομάς"), gt("? "),
    gw("οὐ", 1, 2), gt(" "), gw("μὴ", 1, 2), gt(" "), gw("ἀφεθῇ"), gt(" "),
    gw("ὧδε"), gt(" "), gw("λίθος"), gt(" "), gw("ἐπὶ"), gt(" "),
    gw("λίθον"), gt(", "), gw("ὃς"), gt(" "),
    gw("οὐ", 2, 2), gt(" "), gw("μὴ", 2, 2), gt(" "), gw("καταλυθῇ"), gt("."),
  ];

  const quoted = "οὐ μὴ ἀφεθῇ ὧδε λίθος ἐπὶ λίθον, ὃς οὐ μὴ καταλυθῇ";
  const bare = "οὐ μὴ ἀφεθῇ ὧδε λίθος ἐπὶ λίθον ὃς οὐ μὴ καταλυθῇ";
  const matched = matchSourceTokens(ugnt, quoted, 1);
  assert(matched.length === 11, `comma-bearing quote resolves all 11 source words (got ${matched.length})`);
  assert(
    matched.map((t) => t.text).join(" ") === bare,
    `matched tokens are the phrase in document order (got ${JSON.stringify(matched.map((t) => t.text).join(" "))})`,
  );
  assert(
    JSON.stringify(matchSourceTokens(ugnt, bare, 1)) === JSON.stringify(matched),
    "comma-bearing and comma-free quotes resolve identically",
  );
  const hlSrc = findSourceHighlights(ugnt, quoted, 1);
  assert(hlSrc.has("λίθον|1"), `λίθον lights from the comma-bearing quote (got ${[...hlSrc].join(",")})`);
  assert(!hlSrc.has("βλέπεις|1"), `quote must NOT bleed onto βλέπεις (got ${[...hlSrc].join(",")})`);
  assert(
    matchSourceTokens(ugnt, "μεγάλας οἰκοδομάς?", 1).length === 2,
    "trailing Greek question mark strips (μεγάλας οἰκοδομάς?)",
  );
  assert(
    matchSourceTokens(ugnt, "«καταλυθῇ.»", 1).length === 1,
    "surrounding guillemets + full stop strip («καταλυθῇ.»)",
  );
  // A token that is nothing but punctuation is dropped, not matched as "".
  assert(matchSourceTokens(ugnt, ",", 1).length === 0, "a punctuation-only quote matches nothing");
  assert(
    matchSourceTokens(ugnt, "οὐ μὴ , ἀφεθῇ", 1).length === 3,
    "an orphan comma token is dropped without breaking adjacency",
  );
  // Gap markers still split FIRST — punctuation stripping must never eat one.
  for (const [label, gapQuote, expect] of [
    ["&", "ἐπὶ λίθον, & καταλυθῇ", ["ἐπὶ", "λίθον", "καταλυθῇ"]],
    ["...", "λίθον...καταλυθῇ", ["λίθον", "καταλυθῇ"]],
  ]) {
    const got = matchSourceTokens(ugnt, gapQuote, 1).map((t) => t.text);
    assert(got.join(" ") === expect.join(" "), `gap marker ${label} still resolves (got ${JSON.stringify(got.join(" "))})`);
  }
  // Occurrence selection is unaffected by stripping.
  const occ2 = matchSourceTokens(ugnt, "οὐ μὴ", 2);
  assert(
    occ2.map((t) => t.occurrence).join(",") === "2,2",
    `οὐ μὴ occ 2 picks the second instance (got ${occ2.map((t) => t.occurrence).join(",")})`,
  );
  assert(
    JSON.stringify(matchSourceTokens(ugnt, "οὐ μὴ,", 2)) === JSON.stringify(occ2),
    "a trailing comma does not shift which occurrence is chosen",
  );
  // Hebrew side: sof pasuq / paseq / a trailing comma all strip too; maqqef
  // is still a SEPARATOR, not stripped punctuation.
  const hw = (text) => ({ type: "word", tag: "w", text });
  const hebVo = [hw("דָּבָר"), hw("יְהוָ֑ה"), hw("צְבָאֽוֹת")];
  for (const [label, hebQuote] of [
    ["sof pasuq", "יְהוָ֑ה צְבָאֽוֹת׃"],
    ["paseq", "יְהוָ֑ה ׀ צְבָאֽוֹת"],
    ["comma", "יְהוָ֑ה צְבָאֽוֹת,"],
  ]) {
    const hlHeb = findSourceHighlights(hebVo, hebQuote, 1);
    assert(
      hlHeb.has("יְהוָ֑ה|1") && hlHeb.has("צְבָאֽוֹת|1") && hlHeb.size === 2,
      `Hebrew quote with ${label} lights both words, raw keys (got ${[...hlHeb].join(",")})`,
    );
  }
  const maqqefHl = findSourceHighlights(hebVo, "דָּבָר־יְהוָ֑ה", 1);
  assert(
    maqqefHl.has("דָּבָר|1") && maqqefHl.has("יְהוָ֑ה|1"),
    `maqqef still splits a quote into adjacent tokens (got ${[...maqqefHl].join(",")})`,
  );
}

// --- 26. \qs (Selah) character-wrapper descent when collecting milestone
// target words (issue #331, ported from downstream fork commits fab1e6b +
// c0fbeaf). A `\w` aligned inside a `\qs` wrapper must still highlight,
// regardless of whether the wrapper sits INSIDE the milestone
// (`zaln → qs → w`, synthetic) or OUTSIDE it (`qs → zaln → w`, the real
// production ULT shape), and regardless of whether the wrapper sits between
// two nested milestone levels of a merge group.
{
  // (a) wrapper INSIDE the milestone — synthetic shape.
  const insideVo = [
    zaln("ס", 1, 1, [
      { type: "quote", tag: "qs", endTag: "\\qs*", children: [tgt("Selah")] },
    ]),
  ];
  const hlInside = findTargetHighlights(insideVo, "ס", 1);
  assert(
    hlInside.has("Selah|1"),
    `#331: quote "ס" highlights the \\qs-wrapped word Selah (got ${[...hlInside].join(",") || "<empty>"})`,
  );
  const selInside = extractTargetSelectionText(insideVo, "ס", 1);
  assert(selInside === "Selah", `#331: extractTargetSelectionText resolves the wrapped selection (got ${JSON.stringify(selInside)})`);

  // (b) wrapper OUTSIDE the milestone — the real production ULT shape, parsed
  // from actual USFM (never hand-built — that is how the inverted nesting hid).
  const target = String.raw`\id PSA
\c 3
\p
\v 8 \q1 \zaln-s |x-strong="H3068" x-content="יְהוָה"\*\w Salvation belongs to Yahweh|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*. \qs \zaln-s |x-strong="H5542" x-lemma="סֶלָה" x-content="סֶלָה"\*\w Selah|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\qs*
`;
  const source = String.raw`\id PSA
\c 3
\v 8 \w יְהוָה|x-strong="H3068" x-occurrence="1"\w* \w סֶלָה|x-strong="H5542" x-occurrence="1"\w*
`;
  const tvo = usfm.toJSON(target).chapters["3"]["8"].verseObjects;
  const svo = usfm.toJSON(source).chapters["3"]["8"].verseObjects;
  const qsNode = tvo.find((n) => n.tag === "qs");
  assert(!!qsNode && (qsNode.children ?? []).some((c) => c.tag === "zaln"), "premise: the fixture really parses as qs → zaln → w");
  const hlOl = findTargetHighlights(tvo, "סֶלָה", 1, svo);
  assert(hlOl.has("Selah|1"), `#331: OL-anchored highlight finds the wrapper-outside Selah (got ${[...hlOl].join(",") || "<empty>"})`);
  const hlGl = findTargetHighlights(tvo, "סֶלָה", 1);
  assert(hlGl.has("Selah|1"), `#331: GL-only degradation highlight finds it too (got ${[...hlGl].join(",") || "<empty>"})`);
  const sel = extractTargetSelectionText(tvo, "סֶלָה", 1, svo);
  assert(sel === "Selah", `#331: extractTargetSelectionText returns "Selah" on the production shape (got ${JSON.stringify(sel)})`);
  const src2 = findSourceForTargetText(tvo, "Selah");
  assert(src2 === "סֶלָה", `#331: findSourceForTargetText resolves the wrapped word back to its source (got ${JSON.stringify(src2)})`);
  const hlSibling = findTargetHighlights(tvo, "יְהוָה", 1, svo);
  assert(
    hlSibling.has("Salvation belongs to Yahweh|1") && hlSibling.size === 1,
    `#331 control: the unwrapped sibling milestone still highlights alone (got ${[...hlSibling].join(",") || "<empty>"})`,
  );

  // (c) wrapper BETWEEN two nested milestone levels of a merge group.
  const nestedTarget = String.raw`\id PSA
\c 3
\v 9 \zaln-s |x-strong="H5921" x-content="עַל"\*\qs \zaln-s |x-strong="H5542" x-content="סֶלָה"\*\w Selah|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\qs*\zaln-e\*
`;
  const nvo = usfm.toJSON(nestedTarget).chapters["3"]["9"].verseObjects;
  const inner = findTargetHighlights(nvo, "סֶלָה", 1);
  assert(inner.has("Selah|1"), `#331: the INNER milestone inside a \\qs wrapper keeps its run (got ${[...inner].join(",") || "<empty>"})`);
  const outer = findTargetHighlights(nvo, "עַל", 1);
  assert(outer.has("Selah|1"), `#331: the OUTER milestone still lights the whole merge group (got ${[...outer].join(",") || "<empty>"})`);
}

// --- 27. source-side (UHB/UGNT) \qs wrapper descent (issue #331, ported from
// downstream fork commit c0fbeaf). collectSourceWords / collectBareWords must
// descend a source-side character wrapper too, or a \qs-wrapped source word
// can neither highlight in UHB/UGNT nor anchor a ULT/UST match.
{
  const source = String.raw`\id PSA
\c 3
\v 8 \w יְהוָה|x-strong="H3068" x-occurrence="1"\w* \qs \w סֶלָה|x-strong="H5542" x-occurrence="1"\w*\qs*
`;
  const svo = usfm.toJSON(source).chapters["3"]["8"].verseObjects;
  const toks = matchSourceTokens(svo, "סֶלָה", 1);
  assert(
    toks.length === 1 && toks[0].text === "סֶלָה",
    `#331: matchSourceTokens finds the \\qs-wrapped source word (got ${JSON.stringify(toks.map((t) => t.text))})`,
  );
  const hl = findSourceHighlights(svo, "סֶלָה", 1);
  assert(hl.has("סֶלָה|1"), `#331: findSourceHighlights lights the \\qs-wrapped source word (got ${[...hl].join(",")})`);
  assert(findSourceHighlights(svo, "יְהוָה", 1).has("יְהוָה|1"), "#331 control: unwrapped source word still highlights");
}

// --- 28. render/matcher agreement on a real `\d` (Psalm superscription)
// shape (F1 follow-up to #666). usfm-js 3.5.0 parses `\d` as `{tag:"d",
// text/children}` with NO `type` field. The renderer walks any `tag:"d"`
// node regardless of `type` (see the `o["tag"] === "d"` gate in highlight.ts),
// but nodeIsPsalmTitle used to also require `type === "section"`, which this
// shape never carries — so findTargetHighlights/extractTargetSelectionText
// returned nothing for a word the renderer painted. Pin that they agree.
{
  const dNode = {
    tag: "d",
    children: [zaln("סֶלָה", 1, 1, [tgt("Selah")])],
  };
  const dVo = [dNode];
  const html = renderHighlightedHTML(dVo, new Set());
  assert(html.includes("Selah"), `#666 F1 premise: renderer paints the \\d-wrapped word (got ${JSON.stringify(html)})`);
  const hl = findTargetHighlights(dVo, "סֶלָה", 1);
  assert(hl.has("Selah|1"), `#666 F1: findTargetHighlights finds the \\d-wrapped word the renderer paints (got ${[...hl].join(",") || "<empty>"})`);
  const sel = extractTargetSelectionText(dVo, "סֶלָה", 1);
  assert(sel === "Selah", `#666 F1: extractTargetSelectionText resolves the \\d-wrapped selection (got ${JSON.stringify(sel)})`);
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll highlight tests passed.");
