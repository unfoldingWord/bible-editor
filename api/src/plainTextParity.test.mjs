// The server's plain-text extractor must agree with the editor's (#1339).
//
// api/src/importParsers.ts `extractPlainText` (book import, reimport, the AI
// pipeline, lint) and web/src/lib/usfm.ts `extractPlainText` (every verse
// save, find/replace) are kept as two copies because the Worker and the web
// bundle are built separately. They drifted: the editor skipped a `\sp`
// speaker label's text, the server kept it, so an imported verse with a
// plain-text `\sp` label would start out with a stored plain text the editor
// calls stale. This test feeds both the same verse trees and asserts the same
// text.
//
// A label written as words (`\sp \w The\w* …`, 37 of the 41 labels in en_ust
// Song of Songs on 2026-11-13) parses as an empty `sp` node followed by
// ordinary body words. The import nests those words into the `sp` node
// (nestWordLabels, #1350), so both copies skip them; the real-SNG cases at the
// end pin that.
//
// scripts/import-book.mjs has a third copy. It runs top-level code on import
// (reads argv, writes SQL), so it can't be imported here; it uses the
// `isHeaderLabelNode` exported by importParsers.ts for the same skip.
//
// Run from api/: node --experimental-strip-types --no-warnings src/plainTextParity.test.mjs

import usfm from "usfm-js";
import { readFileSync } from "node:fs";
import { extractPlainText as apiExtract, extractVersesForRange, nestWordLabels as apiNest } from "./importParsers.ts";
import { extractPlainText as webExtract, nestWordLabels as webNest } from "../../web/src/lib/usfm.ts";

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

function same(name, tree, want) {
  const a = apiExtract(tree);
  const w = webExtract(tree);
  check(a === w, `${name}: api ${JSON.stringify(a)} === web ${JSON.stringify(w)}`);
  if (want !== undefined) check(w === want, `${name}: want ${JSON.stringify(want)}, got ${JSON.stringify(w)}`);
}

const t = (text) => ({ type: "text", text });
const w = (text) => ({ text, tag: "w", type: "word", occurrence: "1", occurrences: "1" });
const zaln = (strong, children) => ({ tag: "zaln", type: "milestone", strong, content: "x", children, endTag: "zaln-e\\*" });

// Hand-built trees, in the shapes usfm-js and the editor produce.
same(
  "\\sp label on text (usfm-js shape)",
  { verseObjects: [w("Let"), t(" "), w("him"), t(" kiss me.\n"), { tag: "sp", text: "The man\n" }, { tag: "q1", type: "quote", text: "You are fair.\n" }] },
  "Let him kiss me. You are fair.",
);
same(
  "\\sp label lifted to content",
  { verseObjects: [t("Let him kiss me.\n"), { tag: "sp", content: "The man\n" }, { tag: "q1", type: "quote" }, t("You are fair.")] },
  "Let him kiss me. You are fair.",
);
same(
  "\\sp label beside aligned words",
  { verseObjects: [zaln("H0", [w("The")]), t(" "), zaln("H1", [w("woman")]), t("\n"), { tag: "sp", text: "\"the man speaking\"\n" }, { tag: "q1", type: "quote" }, zaln("H2", [w("ran")]), t(".")] },
  "The woman ran.",
);
same("\\qa acrostic label on text (raw)", { verseObjects: [{ tag: "qa", type: "quote", text: "Aleph\n" }, { tag: "q1", type: "quote", text: "How lonely sits the city." }] });
same("\\qa acrostic label lifted to content", { verseObjects: [{ tag: "qa", type: "quote", content: "Aleph" }, { tag: "q1", type: "quote" }, t("How lonely sits the city.")] }, "How lonely sits the city.");
same("\\d superscription on text (no type)", { verseObjects: [{ tag: "d", text: "For the director.\n" }, { tag: "q1", type: "quote", text: "Praise him." }] }, "For the director. Praise him.");
same("\\d superscription as a section with aligned children", { verseObjects: [{ tag: "d", type: "section", children: [zaln("H1", [w("For")]), t(" the director.")] }, t("\n"), t("Praise him.")] }, "For the director. Praise him.");
same("\\qs Selah\\qs* wrapper", { verseObjects: [{ tag: "q1", type: "quote", text: "Praise him. " }, { tag: "qs", type: "quote", text: "Selah", endTag: "qs*" }, t("\n")] }, "Praise him. Selah");
same("\\qs wrapping aligned words", { verseObjects: [t("Praise him. "), { tag: "qs", type: "quote", endTag: "qs*", children: [zaln("H5542", [w("Selah")])] }] }, "Praise him. Selah");
same("\\s1 section heading", { verseObjects: [{ tag: "s1", type: "section", content: "A heading\n" }, t("Body text.")] }, "Body text.");
same("\\r parallel reference", { verseObjects: [{ tag: "r", content: "(Matt 1:1)\n" }, t("Body text.")] }, "Body text.");
same("\\sr and \\cl labels", { verseObjects: [{ tag: "sr", content: "1:1-5\n" }, { tag: "cl", content: "Psalm 3\n" }, t("Body text.")] }, "Body text.");
same("poetry marker glued to words", { verseObjects: [t("One"), { tag: "q2", type: "quote" }, t("two.")] }, "One two.");
same("paragraph marker glued, with parked punctuation", { verseObjects: [t("said"), { tag: "p", type: "paragraph", text: "“" }, t("Go.”")] }, "said “Go.”");
// Footnote prose lives on `content`, which neither copy reads. (usfm-js parks
// the space after `\f*` on `nextChar`, which neither reads either, so both
// give "lonelysits": a shared quirk, not pinned here.)
same("footnote content is not text", { verseObjects: [t("How lonely "), { tag: "f", type: "footnote", content: "+ \\ft note text", endTag: "f*", nextChar: " " }, t("sits the city.")] }, "How lonely sits the city.");
same("verse-level object without verseObjects", {}, "");

// The same trees as the API's own import path builds them from USFM.
const src = String.raw`\id SNG
\c 1
\sp The woman
\q1
\v 2 \w Let|x-occurrence="1" x-occurrences="1"\w* \w him|x-occurrence="1" x-occurrences="1"\w* kiss me.
\sp The man
\q1 You are fair.
\v 3 \qa Aleph
\q1 How lonely\f + \ft note text\f* sits the city.
\s1 A heading
\r (Matt 1:1)
\d For the director.
\q1 Praise him. \qs Selah\qs*
\cl Psalm 3
\v 4 One
\q2 two.
`;
const verses = extractVersesForRange(src, 1, 1);
check(verses.length >= 3, `parsed the sample (got ${verses.length} verses)`);
for (const v of verses) {
  const tree = JSON.parse(v.contentJson);
  check(v.plainText === webExtract(tree), `import path ${v.chapter}:${v.verse}: stored ${JSON.stringify(v.plainText)} === web ${JSON.stringify(webExtract(tree))}`);
}
const v2 = verses.find((v) => v.verse === 2);
check(v2 && !/The man/.test(v2.plainText), `import path 1:2: no \\sp label text in the stored plain text (got ${JSON.stringify(v2?.plainText)})`);
// usfm-js itself parses the sample the way the hand-built cases assume.
check(usfm.toJSON(src).chapters["1"]["2"].verseObjects.some((n) => n.tag === "sp" && typeof n.text === "string"), "usfm-js parks \\sp on text");

// Real Song of Songs labels written as words (#1350): a trimmed copy of the
// Door43 en_ust file (SNG 1:1 with one label, 1:4 with four, one of them
// holding \zaln milestones). The stored plain text skips every label, and the
// two copies of the nest agree.
{
  const sng = readFileSync(new URL("./fixtures/sng-sp-labels.usfm.txt", import.meta.url), "utf8");
  const rows = extractVersesForRange(sng, 1, 1);
  const byVerse = (n) => rows.find((r) => r.verse === n);
  check(byVerse(1)?.plainText === "This is King Solomon’s most beautiful song.", `SNG 1:1 plain text skips the word label (got ${JSON.stringify(byVerse(1)?.plainText)})`);
  check(byVerse(4) && !/speaking|herself|Jerusalem speaking/.test(byVerse(4).plainText), `SNG 1:4 plain text skips all four word labels (got ${JSON.stringify(byVerse(4)?.plainText)})`);
  for (const r of rows) {
    const tree = JSON.parse(r.contentJson);
    check(r.plainText === apiExtract(tree) && r.plainText === webExtract(tree), `SNG ${r.chapter}:${r.verse}: stored, api and web plain text agree`);
  }
  const raw = usfm.toJSON(sng).chapters["1"];
  for (const v of Object.keys(raw)) {
    const vos = raw[v].verseObjects;
    check(JSON.stringify(apiNest(vos)) === JSON.stringify(webNest(vos)), `SNG 1:${v}: api and web nestWordLabels agree`);
  }
}

// Shapes that must not nest, and an empty-text opener (review of #1350): a
// milestone opening on a label word and closing in the body (usfm-js puts the
// \q1 and the body word inside it), a run with no \w word, and `text: ""`.
{
  const odd = usfm.toJSON(String.raw`\c 1
\p
\v 1 \w Body|x-occurrence="1" x-occurrences="1"\w*.
\sp \w The|x-occurrence="1" x-occurrences="1"\w* \zaln-s |x-strong="H1" x-lemma="a" x-morph="He" x-occurrence="1" x-occurrences="1" x-content="א"\*\w man|x-occurrence="1" x-occurrences="1"\w*
\q1 \w Hi|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* \w there|x-occurrence="1" x-occurrences="1"\w*
\v 2 \w Next|x-occurrence="1" x-occurrences="1"\w*.
\sp \zaln-s |x-strong="H2" x-lemma="b" x-morph="He" x-occurrence="1" x-occurrences="1" x-content="ב"\*\zaln-e\*
\q1 \w Go|x-occurrence="1" x-occurrences="1"\w*
`).chapters["1"];
  for (const v of ["1", "2"]) {
    const vos = odd[v].verseObjects;
    check(apiNest(vos) === vos && webNest(vos) === vos, `odd 1:${v}: neither copy nests it`);
  }
  check(apiExtract({ verseObjects: apiNest(odd["1"].verseObjects) }).includes("Hi there"), "odd 1:1: the body words stay verse text");
  const emptyText = [{ tag: "sp", text: "" }, w("The"), t(" "), w("man"), t("\n"), { tag: "q1", type: "quote" }, w("Hi")];
  check(JSON.stringify(apiNest(emptyText)) === JSON.stringify(webNest(emptyText)) && apiNest(emptyText)[0].text === undefined, "empty-text opener: both copies nest it and drop the empty text");
  check(apiExtract({ verseObjects: apiNest(emptyText) }) === "Hi", "empty-text opener: the label is out of the plain text");
}

// A footnote, cross reference or character marker inside a `\sp` line is part
// of the label (#1354 item 2): both copies nest across it, identically, and
// the stored plain text has no label word.
{
  const src = String.raw`\c 1
\p
\v 1 \w Body|x-occurrence="1" x-occurrences="1"\w*.
\sp \w The|x-occurrence="1" x-occurrences="1"\w* \w woman|x-occurrence="1" x-occurrences="1"\w*\f + \ft A note.\f* \add \w speaking|x-occurrence="1" x-occurrences="1"\w*\add* \nd \w Lord|x-occurrence="1" x-occurrences="1"\w*\nd*
\q1 \w Hi|x-occurrence="1" x-occurrences="1"\w* there.
\v 2 \w Next|x-occurrence="1" x-occurrences="1"\w*.
\sp \add The\add* \w woman|x-occurrence="1" x-occurrences="1"\w* \x - \xo 1:1 \xt Gen 1:1\x*
\q1 \w Go|x-occurrence="1" x-occurrences="1"\w*
`;
  const fx = usfm.toJSON(src).chapters["1"];
  for (const v of ["1", "2"]) {
    const vos = fx[v].verseObjects;
    const nested = apiNest(vos);
    check(JSON.stringify(nested) === JSON.stringify(webNest(vos)), `footnote/char marker 1:${v}: api and web nestWordLabels agree`);
    check(nested.filter((n) => n && n.tag === "sp").length === 1 && nested[nested.findIndex((n) => n && n.tag === "sp") + 1]?.tag === "q1",
      `footnote/char marker 1:${v}: the whole \\sp line is one label, followed by its \\q1 (got ${JSON.stringify(nested.map((n) => n?.tag ?? n?.type))})`);
  }
  const rows = extractVersesForRange(src, 1, 1);
  check(rows.find((r) => r.verse === 1)?.plainText === "Body. Hi there.", `footnote/char marker 1:1: stored plain text has no label word (got ${JSON.stringify(rows.find((r) => r.verse === 1)?.plainText)})`);
  check(rows.find((r) => r.verse === 2)?.plainText === "Next. Go", `footnote/char marker 1:2: stored plain text has no label word (got ${JSON.stringify(rows.find((r) => r.verse === 2)?.plainText)})`);
}

// Only character and note markers join a label's run (#1366 item 3): a `\va`,
// `\vp`, `\ca` or `\fig` is a closed marker too, but no part of a speaker label.
// Both copies keep them out of the label, identically; `\fe` and `\wj` join.
{
  const src = String.raw`\c 1
\p
\v 1 \w Body|x-occurrence="1" x-occurrences="1"\w*.
\sp \w The|x-occurrence="1" x-occurrences="1"\w* \w man|x-occurrence="1" x-occurrences="1"\w*
\va 2\va*
\q1 \w Hi|x-occurrence="1" x-occurrences="1"\w*
\v 2 \w B|x-occurrence="1" x-occurrences="1"\w*.
\sp \w The|x-occurrence="1" x-occurrences="1"\w* \fe + \ft end\fe* \wj \w man|x-occurrence="1" x-occurrences="1"\w*\wj*
\q1 \w Hi|x-occurrence="1" x-occurrences="1"\w*
\v 3 \w C|x-occurrence="1" x-occurrences="1"\w*.
\sp \w The|x-occurrence="1" x-occurrences="1"\w* \vp 2a\vp* \ca 3\ca* \fig A|src="a.jpg" size="col"\fig*
\q1 \w Go|x-occurrence="1" x-occurrences="1"\w*
`;
  const fx = usfm.toJSON(src).chapters["1"];
  const kids = (vos) => vos.find((n) => n && n.tag === "sp").children.map((c) => c.tag ?? c.type);
  for (const v of ["1", "2", "3"]) {
    const vos = fx[v].verseObjects;
    check(JSON.stringify(apiNest(vos)) === JSON.stringify(webNest(vos)), `marker list 1:${v}: api and web nestWordLabels agree`);
  }
  check(!kids(apiNest(fx["1"].verseObjects)).includes("va"), `\\va after a label stays in the verse (got ${JSON.stringify(kids(apiNest(fx["1"].verseObjects)))})`);
  check(kids(apiNest(fx["2"].verseObjects)).includes("fe") && kids(apiNest(fx["2"].verseObjects)).includes("wj"), "\\fe and \\wj join the label");
  check(!kids(apiNest(fx["3"].verseObjects)).some((k) => ["vp", "ca", "fig"].includes(k)), `\\vp, \\ca, \\fig stay out of the label (got ${JSON.stringify(kids(apiNest(fx["3"].verseObjects)))})`);
}

if (failed > 0) {
  console.error(`\nplainTextParity: ${failed} check(s) failed, ${passed} passed.`);
  process.exit(1);
}
console.log(`\nplainTextParity: all ${passed} checks passed.`);
