// Tests for quoteBuilder.ts — the quote-picker token walk and the
// selection <-> quote round trip.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/quoteBuilder.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors src/lib/replace.test.mjs.

import {
  collectTargetTokens,
  buildQuoteFromSelection,
  selectionFromQuote,
  tokenKey,
} from "./quoteBuilder.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const w = (text, occ = "1", occs = "1") => ({ text, tag: "w", type: "word", occurrence: occ, occurrences: occs });
const t = (text) => ({ type: "text", text });
const zaln = (content, children) => ({
  tag: "zaln", type: "milestone", content, occurrence: "1", occurrences: "1", children, endTag: "zaln-e\\*",
});
// Real ULT/UST shape (HAB 3:3/3:9/3:13): `\qs Selah\zaln-s ...\*\w Selah\w*\zaln-e\*\qs*`
// parses to a `type:"quote"` wrapper (`isCharacterWrapper` in usfm.ts) whose
// children hold the aligned \zaln milestone. Mirrors replace.test.mjs's `qsWrap`.
const qsWrap = (selahContent, children) => ({
  tag: "qs", type: "quote", nextChar: "\n", endTag: "qs*",
  children: [zaln(selahContent, children), t("\n")],
});
const sourceWord = (text) => ({ type: "word", tag: "w", text });

// ─── Case: qs -> zaln -> w is not silently skipped ────────────────────────
// Bug (#673): collectTargetTokens' walk only recognized "milestone"/"zaln"
// and "word"/"w" node types (plus the \d section special-case). A \qs
// wrapper is type:"quote", tag:"qs" — none of those branches matched, so the
// walk fell through and never descended into it, dropping the milestone AND
// the word beneath it entirely. A translator could see Selah highlighted
// (highlight.ts's matcher already descends \qs) but the picker offered no
// token to select it with.
{
  console.log("\n[qs descent] Selah nested in a \\qs wrapper is collected");
  const verseObjects = [
    zaln("Praise", [w("Praise")]),
    t(" "),
    qsWrap("Selah", [w("Selah")]),
  ];
  const sourceVerseObjects = [sourceWord("Praise"), sourceWord("Selah")];

  const tokens = collectTargetTokens(verseObjects, sourceVerseObjects);
  const texts = tokens.map((tk) => tk.text);
  assert(texts.includes("Praise"), `outer (non-qs) word still collected (got ${JSON.stringify(texts)})`);

  const selah = tokens.find((tk) => tk.text === "Selah");
  assert(!!selah, `Selah nested inside \\qs is collected (got ${JSON.stringify(texts)})`);
  assert(
    !!selah && selah.sources.length === 1 && selah.sources[0].key === tokenKey("Selah", 1),
    `Selah's source ancestor is the \\zaln milestone inside \\qs (got ${JSON.stringify(selah?.sources)})`,
  );
}

// ─── Case: unaligned same-line \qs (no children) is still a no-op ────────
// `\qs Selah\qs*` with the text parked on the node itself (no \zaln/\w
// children) has nothing to descend into — must not throw, must contribute
// no phantom token.
{
  console.log("\n[qs descent] unaligned same-line \\qs (no children) is a no-op, not a crash");
  const verseObjects = [zaln("Praise", [w("Praise")]), { tag: "qs", type: "quote", text: "Selah", endTag: "qs*" }];
  const tokens = collectTargetTokens(verseObjects, [sourceWord("Praise")]);
  assert(tokens.length === 1 && tokens[0].text === "Praise", `no phantom token from the childless \\qs (got ${JSON.stringify(tokens)})`);
}

// ─── Case: picker selection of the qs-nested word round-trips through
// buildQuoteFromSelection to the same quote/occurrence the source side sees ─
// Ties collectTargetTokens' picker-side key to the source-side (UHB/UGNT)
// selection path used to actually build the saved quote.
{
  console.log("\n[qs descent] selecting the qs-nested source key builds the right quote");
  const verseObjects = [zaln("Praise", [w("Praise")]), t(" "), qsWrap("Selah", [w("Selah")])];
  const sourceVerseObjects = [sourceWord("Praise"), sourceWord("Selah")];

  const tokens = collectTargetTokens(verseObjects, sourceVerseObjects);
  const selah = tokens.find((tk) => tk.text === "Selah");
  const selectedKeys = new Set(selah.sources.map((s) => s.key));

  const built = buildQuoteFromSelection(sourceVerseObjects, selectedKeys);
  assert(!!built && built.quote === "Selah" && built.occurrence === 1, `built quote from qs-nested selection (got ${JSON.stringify(built)})`);

  // And the reverse: a stored quote/occurrence for the qs-nested word
  // pre-seeds the same key the picker exposes on that token.
  const preseeded = selectionFromQuote(sourceVerseObjects, "Selah", 1);
  assert(
    preseeded.size === 1 && preseeded.has(selah.sources[0].key),
    `selectionFromQuote pre-seeds the qs-nested word's key (got ${JSON.stringify([...preseeded])})`,
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll quoteBuilder tests passed.");
