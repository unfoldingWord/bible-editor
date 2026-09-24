// Regression tests for the alignment-source canonize repair (GitHub issue #945).
// Run from the repo root:
//   npm run test:scripts
//   node --experimental-strip-types --no-warnings scripts/lib/canonizeAlignment.test.mjs
//
// Not a test framework; a failed assert exits non-zero. Hebrew is written as
// \u escapes so a word joiner vs an accent is visible in the source.

import {
  buildSourceIndex,
  sourceWordsForRange,
  verifyOnlyZalnSourceChanged,
  repairVerse,
  classifyChange,
  uEscape,
} from "./canonizeAlignment.mjs";

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok: ${msg}`);
}

// ── fixture helpers ────────────────────────────────────────────────────────

const w = (text) => ({ text, tag: "w", type: "word", occurrence: "1", occurrences: "1" });
const t = (text) => ({ type: "text", text });
const zaln = (strong, lemma, content, children) => ({
  tag: "zaln", type: "milestone", strong, lemma, morph: "He,R",
  occurrence: "1", occurrences: "1", content, endTag: "zaln-e\\*", children,
});
const srcW = (text, strong, lemma) => ({ text, tag: "w", type: "word", lemma, strong, morph: "He,R" });
const uhbRow = (chapter, verse, words) => ({
  book: "JER", chapter, verse, bible_version: "UHB",
  content_json: JSON.stringify({ verseObjects: words }),
});

// JER 28:12 — the reported case, copied from the prod rows (2026-09-24).
const AFTER_ULT = "אַ⁠חֲרֵי"; // word joiner where the accent was
const AFTER_UHB = "אַ֠חֲרֵי"; // U+05A0 telisha gedola
const LEMMA = "אַחַר";
const HANANIAH = "חֲנַנְיָֽה";

const jerUlt = () =>
  JSON.stringify({
    verseObjects: [
      t("to Jeremiah "),
      zaln("H0310a", LEMMA, AFTER_ULT, [w("after")]),
      t(" "),
      zaln("H2608a", HANANIAH, HANANIAH, [w("Hananiah")]),
      t(" the prophet broke the yoke bar"),
    ],
  });
const jerUhb = () => [
  uhbRow(28, 12, [srcW(AFTER_UHB, "H0310a", LEMMA), t(" "), srcW(HANANIAH, "H2608a", HANANIAH)]),
];

// ── JER 28:12 ──────────────────────────────────────────────────────────────

console.log("JER 28:12 ULT — word joiner in place of telisha gedola");
{
  const index = buildSourceIndex(jerUhb());
  const words = sourceWordsForRange(index, 28, 12, null);
  assert(words.length === 2, "UHB source words collected from the UHB row");
  const before = jerUlt();
  const r = repairVerse(before, words);
  assert(r.status === "repaired", `status is repaired (got ${r.status})`);
  assert(r.changes.length === 1, "exactly one milestone changed");
  assert(r.changes[0].content.after === AFTER_UHB, `milestone content becomes the UHB bytes (${uEscape(r.changes[0].content.after)})`);
  assert(r.changes[0].content.before === AFTER_ULT, "the report carries the old bytes");
  assert(!r.changes[0].lemma, "lemma already matched, so it is not reported as changed");
  assert(r.changes[0].kind === "visible", "classified visible (differs from the UHB under NFC)");

  // Nothing else in the tree moved: put the old content back and compare.
  const after = JSON.parse(r.newContentJson);
  assert(after.verseObjects[1].content === AFTER_UHB, "new content_json holds the UHB bytes");
  after.verseObjects[1].content = AFTER_ULT;
  assert(JSON.stringify(after) === before, "reverting that one attribute yields the original content_json byte-for-byte");

  const again = repairVerse(r.newContentJson, words);
  assert(again.status === "clean", "idempotent: re-running on the repaired verse changes nothing");
  assert(again.declined.length === 0, "and leaves no visible mismatch behind");
}

// ── verifier ───────────────────────────────────────────────────────────────

console.log("\nverifier — only zaln content/lemma may differ");
{
  const base = () => JSON.parse(jerUlt());
  const ok = base();
  ok.verseObjects[1].content = AFTER_UHB;
  ok.verseObjects[1].lemma = "x";
  const v = verifyOnlyZalnSourceChanged(base(), ok);
  assert(v.ok && v.changes.length === 1 && v.changes[0].content && v.changes[0].lemma, "zaln content + lemma change passes and is reported");

  const wordEdit = base();
  wordEdit.verseObjects[1].children[0].text = "afterwards";
  assert(!verifyOnlyZalnSourceChanged(base(), wordEdit).ok, "refuses a changed English \\w word");

  const textEdit = base();
  textEdit.verseObjects[0].text = "to Jeremiah, ";
  assert(!verifyOnlyZalnSourceChanged(base(), textEdit).ok, "refuses a changed text node");

  const strongEdit = base();
  strongEdit.verseObjects[1].strong = "H0310b";
  assert(!verifyOnlyZalnSourceChanged(base(), strongEdit).ok, "refuses a changed zaln strong (not a mutable attribute)");

  const nodeDrop = base();
  nodeDrop.verseObjects.splice(2, 1);
  assert(!verifyOnlyZalnSourceChanged(base(), nodeDrop).ok, "refuses a removed node");

  const addedKey = base();
  addedKey.verseObjects[3].lemma = undefined;
  delete addedKey.verseObjects[3].lemma;
  assert(!verifyOnlyZalnSourceChanged(base(), addedKey).ok, "refuses a removed attribute");

  // `content` on a non-zaln node is not in the allow-list.
  const a = { verseObjects: [{ type: "milestone", tag: "k", content: "x" }] };
  const b = { verseObjects: [{ type: "milestone", tag: "k", content: "y" }] };
  assert(!verifyOnlyZalnSourceChanged(a, b).ok, "refuses a content change on a non-zaln milestone");

  const top = base();
  top.extra = 1;
  assert(!verifyOnlyZalnSourceChanged(base(), top).ok, "refuses a top-level key change");
}

// ── verse bridges ──────────────────────────────────────────────────────────

console.log("\nverse bridge — source words come from every verse in the bridge");
{
  // v1 holds a same-skeleton, differently-pointed word; v2 holds the exact
  // bytes the UST milestone carries. Looking at v1 alone would "canonize" the
  // milestone onto the WRONG word — the false positive an unbridged scan made.
  const V1 = "אֵ֠לַ⁠י"; // אֵ֠לַ⁠י (telisha gedola)
  const V2 = "אֵלַ֡⁠י"; // אֵלַ֡⁠י
  const index = buildSourceIndex([
    uhbRow(32, 7, [srcW(V1, "H0413", "x")]),
    uhbRow(32, 8, [srcW(V2, "H0413", "x")]),
  ]);
  const ust = JSON.stringify({ verseObjects: [zaln("H0413", "x", V2, [w("to me")])] });
  const bridged = sourceWordsForRange(index, 32, 7, 8);
  assert(bridged.length === 2, "bridge 7-8 unions both verses' words");
  assert(repairVerse(ust, bridged).status === "clean", "with the bridge, the exact v8 word matches and nothing changes");
  const unbridged = sourceWordsForRange(index, 32, 7, null);
  const wrong = repairVerse(ust, unbridged);
  assert(wrong.status === "repaired" && wrong.changes[0].content.after === V1,
    "control: v7 alone would rewrite it to the wrong word — why bridges matter");
}

// ── ambiguity is declined, not guessed ─────────────────────────────────────

console.log("\nambiguous source — fail closed and report");
{
  const A = "יְ֠הוּדָה"; // JER 28:4 candidates
  const B = "יְהוּדָ֜ה";
  const M = "יְ⁠הוּדָה";
  const words = buildSourceIndex([uhbRow(28, 4, [srcW(A, "H3063", "y"), t(" "), srcW(B, "H3063", "y")])]).get("28:4");
  const r = repairVerse(JSON.stringify({ verseObjects: [zaln("H3063", "y", M, [w("Judah")])] }), words);
  assert(r.status === "clean", "two UHB words fit: the canonizer changes nothing");
  assert(r.declined.length === 1 && r.declined[0].reason.startsWith("ambiguous"), "and the milestone is reported as DECLINED/ambiguous");
}

// ── classification + edge statuses ─────────────────────────────────────────

console.log("\nclassification and edge cases");
{
  const legacy = "כֹּ֚ל"; // UHB order: dagesh before holam
  const nfcOrder = "כֹּ֚ל"; // same word, NFC order
  assert(legacy.normalize("NFC") === nfcOrder.normalize("NFC"), "fixture: the two differ only in mark order");
  const words = buildSourceIndex([uhbRow(18, 16, [srcW(legacy, "H3605", "z")])]).get("18:16");
  const r = repairVerse(JSON.stringify({ verseObjects: [zaln("H3605", "z", nfcOrder, [w("all")])] }), words);
  assert(r.status === "repaired" && r.changes[0].kind === "mark_order", "mark-order-only change classified mark_order");
  assert(classifyChange({ lemma: { before: "a", after: "b" } }) === "lemma_only", "lemma-only change classified lemma_only");
  assert(repairVerse(jerUlt(), []).status === "no_source", "no UHB words → no_source (nothing guessed)");
  assert(repairVerse("{not json", words).status === "refused", "unparseable content_json → refused");
  assert(uEscape("a⁠֠") === "a\\u2060\\u05A0", "uEscape leaves ASCII and escapes the rest");
}

console.log(`\n${passed} assertions passed`);
