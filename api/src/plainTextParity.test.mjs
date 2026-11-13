// The server's plain-text extractor must agree with the editor's (#1339).
//
// api/src/importParsers.ts `extractPlainText` (book import, reimport, the AI
// pipeline, lint) and web/src/lib/usfm.ts `extractPlainText` (every verse
// save, find/replace) are kept as two copies because the Worker and the web
// bundle are built separately. They drifted: the editor skipped a `\sp`
// speaker label's text, the server kept it, so an imported Song of Songs verse
// would start out with a stored plain text the editor calls stale. This test
// feeds both the same verse trees and asserts the same text.
//
// scripts/import-book.mjs has a third copy. It runs top-level code on import
// (reads argv, writes SQL), so it can't be imported here; it uses this file's
// shared `isHeaderLabelNode` from importParsers.ts for the same skip.
//
// Run from api/: node --experimental-strip-types --no-warnings src/plainTextParity.test.mjs

import usfm from "usfm-js";
import { extractPlainText as apiExtract, extractVersesForRange } from "./importParsers.ts";
import { extractPlainText as webExtract } from "../../web/src/lib/usfm.ts";

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

if (failed > 0) {
  console.error(`\nplainTextParity: ${failed} check(s) failed, ${passed} passed.`);
  process.exit(1);
}
console.log(`\nplainTextParity: all ${passed} checks passed.`);
