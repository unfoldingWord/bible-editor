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
  sourceCoverage,
  rowIdentityProblem,
  dedupeRows,
  commentSafe,
  parseFootnoteWords,
  repointQereVerse,
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
  const index = buildSourceIndex(jerUhb()).words;
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
  ]).words;
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
  const words = buildSourceIndex([uhbRow(28, 4, [srcW(A, "H3063", "y"), t(" "), srcW(B, "H3063", "y")])]).words.get("28:4");
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
  const words = buildSourceIndex([uhbRow(18, 16, [srcW(legacy, "H3605", "z")])]).words.get("18:16");
  const r = repairVerse(JSON.stringify({ verseObjects: [zaln("H3605", "z", nfcOrder, [w("all")])] }), words);
  assert(r.status === "repaired" && r.changes[0].kind === "mark_order", "mark-order-only change classified mark_order");
  assert(classifyChange({ lemma: { before: "a", after: "b" } }) === "lemma_only", "lemma-only change classified lemma_only");
  assert(repairVerse(jerUlt(), []).status === "no_source", "no UHB words → no_source (nothing guessed)");
  assert(repairVerse("{not json", words).status === "refused", "unparseable content_json → refused");
  assert(uEscape("a⁠֠") === "a\\u2060\\u05A0", "uEscape leaves ASCII and escapes the rest");
}

// ── review fixes: coverage, dump hygiene, comment safety ───────────────────

console.log("\nsource coverage — missing or unparseable UHB verses are problems, not empty");
{
  const idx = buildSourceIndex([
    uhbRow(5, 1, [srcW("a", "H1", "a")]),
    { book: "JER", chapter: 5, verse: 2, bible_version: "UHB", content_json: "{broken" },
    uhbRow(5, 4, [srcW("d", "H4", "d")]),
  ]);
  assert(idx.unusable.has("5:2"), "buildSourceIndex records an unparseable UHB verse instead of skipping it");
  assert(sourceCoverage(idx, 5, 1, null).problems.length === 0, "a present single verse has full coverage");
  const bad = sourceCoverage(idx, 5, 1, 2);
  assert(bad.problems.length === 1 && /5:2/.test(bad.problems[0]) && /unusable/.test(bad.problems[0]), "a bridge over an unparseable verse is a problem");
  const gap = sourceCoverage(idx, 5, 3, 4);
  assert(gap.problems.length === 1 && /5:3 missing/.test(gap.problems[0]), "a bridge over a verse absent from the dump is a problem");
  const dup = buildSourceIndex([uhbRow(6, 1, [srcW("a", "H1", "a")]), uhbRow(6, 1, [srcW("b", "H1", "b")])]);
  assert(dup.unusable.has("6:1") && !dup.words.has("6:1"), "duplicate UHB rows with different content are unusable");
  const same = buildSourceIndex([uhbRow(6, 1, [srcW("a", "H1", "a")]), uhbRow(6, 1, [srcW("a", "H1", "a")])]);
  assert(!same.unusable.has("6:1") && same.words.has("6:1"), "identical duplicate UHB rows collapse");
}

console.log("\nrowIdentityProblem — absent keys refuse, null values do not");
{
  const good = { book: "JER", chapter: 1, verse: 1, verse_end: null, bible_version: "ULT", version: 3, content_json: "{}", plain_text: null, updated_by: null };
  assert(rowIdentityProblem(good) === null, "null verse_end / plain_text / updated_by are fine");
  for (const k of ["verse_end", "plain_text", "updated_by"]) {
    const r = { ...good };
    delete r[k];
    assert(/absent/.test(rowIdentityProblem(r) ?? ""), `a row without the '${k}' key is refused`);
  }
  assert(/content_json/.test(rowIdentityProblem({ ...good, content_json: null }) ?? ""), "NULL content_json is refused");
  assert(/version/.test(rowIdentityProblem({ ...good, version: "x" }) ?? ""), "non-integer version is refused");
}

console.log("\ndedupeRows — identical collapse, disagreeing duplicates conflict");
{
  const a = { book: "JER", chapter: 1, verse: 1, bible_version: "ULT", version: 3, content_json: "{}", verse_end: null };
  const d1 = dedupeRows([a, { ...a }]);
  assert(d1.rows.length === 1 && d1.conflicts.size === 0, "identical duplicates collapse to one row");
  const d2 = dedupeRows([a, { ...a, version: 4 }]);
  assert(d2.rows.length === 1 && d2.conflicts.has("JER/1/1/ULT"), "duplicates with different versions conflict");
  const d3 = dedupeRows([a, { ...a, content_json: '{"x":1}' }]);
  assert(d3.conflicts.has("JER/1/1/ULT"), "duplicates with different content conflict");
}

console.log("\ncomment safety");
{
  const evil = "H1\nUPDATE verses SET version = 0;\r--";
  const safe = commentSafe(`-- ${evil}`);
  assert(!/[\r\n]/.test(safe), "commentSafe removes CR/LF so a value cannot leave its comment");
  assert(safe.includes("\\u000A") && safe.includes("\\u000D"), "and shows them as escapes");
  assert(!/[\r\n]/.test(uEscape(evil)), "uEscape also escapes ASCII control characters");
  assert(commentSafe("-- א ok") === "-- א ok", "commentSafe leaves printable text (including Hebrew) alone");
}

// ── qere → ketiv (issue #956) ──────────────────────────────────────────────

// EZK 43:15, from the prod UHB row (2026-09-24): ketiv in the main text, qere
// in the footnote that follows it.
const ARIEL_KETIV = "וּ⁠מֵ⁠הָ⁠אֲרִאֵ֣יל";
const ARIEL_QERE = "וּמֵהָאֲרִיאֵ֣ל";
const ARIEL_STRONG = "c:m:d:H0741";
const ARIEL_LEMMA = "אֲרִיאֵל";
const HARL = "וְ⁠הַֽ⁠הַרְאֵ֖ל";
const qereNote = (text, strong, lemma, morph) => ({
  tag: "f", type: "footnote", endTag: "f*", nextChar: " ",
  content: `+ \\ft Q \\+w ${text}|lemma="${lemma}" strong="${strong}" x-morph="${morph}"\\+w*`,
});
const ezkUhb = (verse = 15) =>
  uhbRow(43, verse, [
    srcW(HARL, "c:d:H2025", "x"), t(" "),
    { ...srcW(ARIEL_KETIV, ARIEL_STRONG, ARIEL_LEMMA), morph: "He,C:R:Td:Ncmsa" }, t("\n"),
    qereNote(ARIEL_QERE, ARIEL_STRONG, ARIEL_LEMMA, "He,C:R:Td:Ncmsa"),
  ]);
const ezkUlt = (content = ARIEL_QERE, strong = ARIEL_STRONG) =>
  JSON.stringify({ verseObjects: [t("and "), zaln(strong, ARIEL_LEMMA, content, [w("from"), t(" "), w("the"), t(" "), w("hearth")])] });

console.log("\nqere footnote parsing");
{
  const q = parseFootnoteWords(qereNote(ARIEL_QERE, ARIEL_STRONG, ARIEL_LEMMA, "He,Ncmsa").content);
  assert(q.length === 1 && q[0].text === ARIEL_QERE && q[0].strong === ARIEL_STRONG && q[0].morph === "He,Ncmsa", "reads text, strong and x-morph from a \\+w in the footnote");
  const index = buildSourceIndex([ezkUhb()]);
  const qs = index.qeres.get("43:15");
  assert(qs.length === 1 && qs[0].ketivIndex === 1, "the qere points at the \\w right before the footnote");
  const k = buildSourceIndex([uhbRow(43, 15, [srcW(HARL, "H1", "x"), { tag: "f", type: "footnote", content: "+ \\ft K \\+w x|strong=\"H1\"\\+w*" }])]);
  assert(k.qeres.get("43:15").length === 0, "a footnote that is not a Q note is ignored");
  const orphan = buildSourceIndex([uhbRow(43, 15, [qereNote(ARIEL_QERE, ARIEL_STRONG, ARIEL_LEMMA, "m"), srcW(HARL, "H1", "x")])]);
  assert(!orphan.unusable.has("43:15") && orphan.qeres.get("43:15")[0].ketivIndex === -1, "a qere footnote with no \\w before it is untied (-1); the verse stays usable for #945");
  const multi = { tag: "f", type: "footnote", content: `+ \\ft Q \\+w ${ARIEL_QERE}|strong="${ARIEL_STRONG}"\\+w* \\+w ${HARL}|strong="H1"\\+w*` };
  const m = buildSourceIndex([uhbRow(9, 4, [srcW(ARIEL_KETIV, ARIEL_STRONG, ARIEL_LEMMA), multi])]);
  assert(m.qeres.get("9:4").length === 2 && m.qeres.get("9:4").every((q) => q.ketivIndex === -1), "1CH 9:4 shape: a footnote with several \\+w words is untied");
  const misplaced = buildSourceIndex([uhbRow(30, 3, [srcW(ARIEL_KETIV, ARIEL_STRONG, ARIEL_LEMMA), srcW(HARL, "H0953", "x"), qereNote(ARIEL_QERE, ARIEL_STRONG, ARIEL_LEMMA, "m")])]);
  assert(misplaced.qeres.get("30:3")[0].ketivIndex === -1, "PSA 30:3 shape: a footnote after a word with a different Strong's is untied");
  const cm = sourceCoverage(misplaced, 30, 3, null);
  const rm = repointQereVerse(ezkUlt(), cm.words, cm.qeres);
  assert(rm.status === "clean" && /cannot be tied/.test(rm.declined[0]?.reason ?? ""), "a milestone on an untied qere is declined, never re-pointed");
}

console.log("\nEZK 43:15 ULT — qere milestone re-pointed to the ketiv \\w");
{
  const cov = sourceCoverage(buildSourceIndex([ezkUhb()]), 43, 15, null);
  const r = repointQereVerse(ezkUlt(), cov.words, cov.qeres);
  assert(r.status === "repaired" && r.changes.length === 1, `one milestone repaired (got ${r.status})`);
  assert(r.changes[0].content.after === ARIEL_KETIV, `content becomes the ketiv bytes (${uEscape(r.changes[0].content.after)})`);
  assert(r.changes[0].morph?.after === "He,C:R:Td:Ncmsa", "morph adopts the ketiv's morph");
  assert(!r.changes[0].lemma && !r.changes[0].strongChange, "unchanged lemma and strong are not reported");
  assert(r.changes[0].kind === "qere_ketiv", "classified qere_ketiv");
  const again = repointQereVerse(r.newContentJson, cov.words, cov.qeres);
  assert(again.status === "clean" && again.declined.length === 0, "idempotent, and nothing is left unhighlightable");
  assert(repointQereVerse(ezkUlt(ARIEL_KETIV), cov.words, cov.qeres).status === "clean", "a milestone already on the ketiv is left alone");
}

console.log("\nqere repoint — fail closed");
{
  const cov = sourceCoverage(buildSourceIndex([ezkUhb()]), 43, 15, null);
  const wrongStrong = repointQereVerse(ezkUlt(ARIEL_QERE, "H9999"), cov.words, cov.qeres);
  assert(wrongStrong.status === "clean" && /neither/.test(wrongStrong.declined[0]?.reason ?? ""), "a Strong's matching neither qere nor ketiv is declined, not written");
  const twoKetiv = uhbRow(43, 15, [
    srcW(ARIEL_KETIV, ARIEL_STRONG, ARIEL_LEMMA), qereNote(ARIEL_QERE, ARIEL_STRONG, ARIEL_LEMMA, "m"), t(" "),
    srcW(ARIEL_KETIV, ARIEL_STRONG, ARIEL_LEMMA), qereNote(ARIEL_QERE, ARIEL_STRONG, ARIEL_LEMMA, "m"),
  ]);
  const c2 = sourceCoverage(buildSourceIndex([twoKetiv]), 43, 15, null);
  const amb = repointQereVerse(ezkUlt(), c2.words, c2.qeres);
  assert(amb.status === "clean" && /ambiguous/.test(amb.declined[0]?.reason ?? ""), "two ketiv words carrying the same qere are declined");
  const far = buildSourceIndex([uhbRow(43, 15, [srcW(HARL, ARIEL_STRONG, ARIEL_LEMMA), qereNote(ARIEL_QERE, ARIEL_STRONG, ARIEL_LEMMA, "m")])]);
  assert(far.qeres.get("43:15")[0].ketivIndex === -1, "same Strong's but skeletons more than 2 edits apart: untied");
  const numeric = JSON.parse(ezkUlt());
  numeric.verseObjects[1].occurrence = 1;
  const rn = repointQereVerse(JSON.stringify(numeric), cov.words, cov.qeres);
  assert(rn.status === "clean" && /not strings/.test(rn.declined[0]?.reason ?? ""), "numeric occurrence is declined, not left stale");
  const collide = uhbRow(46, 9, [
    srcW(ARIEL_KETIV, ARIEL_STRONG, ARIEL_LEMMA), qereNote(ARIEL_QERE, ARIEL_STRONG, ARIEL_LEMMA, "m"), t(" "),
    srcW(ARIEL_QERE + "֙", "H3318", "x"),
  ]);
  const c3 = sourceCoverage(buildSourceIndex([collide]), 46, 9, null);
  const col = repointQereVerse(ezkUlt(), c3.words, c3.qeres);
  assert(col.status === "clean" && /both/.test(col.declined[0]?.reason ?? ""), "EZK 46:9 shape: a qere whose skeleton also matches another \\w is reported, not written");
  const stray = repointQereVerse(ezkUlt("אבג"), cov.words, cov.qeres);
  assert(stray.status === "clean" && stray.declined.length === 1, "a milestone matching neither a \\w nor a qere is reported as declined");
}

console.log("\nqere repoint — verse bridge: ketiv index and occurrence count span the bridge");
{
  // 1CH 8:22-25 shape: the ketiv sits in the bridge's third verse, and the
  // same ketiv text also occurs in its first verse.
  const rows = [
    uhbRow(8, 22, [srcW(ARIEL_KETIV, ARIEL_STRONG, ARIEL_LEMMA)]),
    uhbRow(8, 23, [srcW(HARL, "H1", "x")]),
    uhbRow(8, 24, [srcW(ARIEL_KETIV, ARIEL_STRONG, ARIEL_LEMMA), qereNote(ARIEL_QERE, ARIEL_STRONG, ARIEL_LEMMA, "m")]),
  ];
  const cov = sourceCoverage(buildSourceIndex(rows), 8, 22, 24);
  assert(cov.qeres.length === 1 && cov.qeres[0].ketivIndex === 2, "the qere's ketiv index is offset past the earlier verses' words");
  const r = repointQereVerse(ezkUlt(), cov.words, cov.qeres);
  assert(r.changes[0].occurrence?.after === "2" && r.changes[0].occurrences?.after === "2", "occurrence 2 of 2 across the bridge");
}

console.log("\nverifier — strong diffs are stored as strongChange");
{
  const a = JSON.parse(ezkUlt());
  const b = JSON.parse(ezkUlt(ARIEL_QERE, "H0741"));
  const v = verifyOnlyZalnSourceChanged(a, b, new Set(["strong"]));
  assert(v.ok && v.changes[0].strong === ARIEL_STRONG && v.changes[0].strongChange.after === "H0741", "the record keeps strong as its label and the diff under strongChange");
}

console.log(`\n${passed} assertions passed`);
