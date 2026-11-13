// Export round trip for a `\sp` speaker label written as words (#1350).
//
// The import nests a word label's `\w` words into the `sp` node so the editor
// treats them as a header label, not verse text (nestWordLabels). Door43's
// format must not change: the nightly export has to write the label back as
// `\sp \w The|…\w*` exactly as Door43 holds it. This feeds a trimmed copy of the
// real Door43 en_ust Song of Songs file (1:1 and 1:4, five word labels, one
// holding \zaln milestones) through the import and the export and wants the
// same bytes back.
//
// Run from api/: node --experimental-strip-types --no-warnings src/spWordLabelExport.test.mjs

import { readFileSync } from "node:fs";
import { buildUsfm } from "./export.ts";
import { extractVersesForRange, extractUsfmHeaders } from "./importParsers.ts";

let passed = 0;
function check(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  passed++;
}

const src = readFileSync(new URL("./fixtures/sng-sp-labels.usfm.txt", import.meta.url), "utf8");
const extracts = extractVersesForRange(src, 1, 1);
const nested = extracts.flatMap((e) => JSON.parse(e.contentJson).verseObjects.filter((n) => n.tag === "sp"));
check(nested.length === 5 && nested.every((n) => Array.isArray(n.children) && n.endTag === ""), `the import nests all five word labels (got ${JSON.stringify(nested.map((n) => Object.keys(n)))})`);

const rows = extracts.map((e) => ({
  book: "SNG", chapter: e.chapter, verse: e.verse, verse_end: e.verseEnd, bible_version: "UST",
  content_json: e.contentJson, plain_text: e.plainText, version: 1,
}));
const out = buildUsfm({ book: "SNG", bibleVersion: "UST", headers: extractUsfmHeaders(src), verses: rows });
if (out !== src) {
  let i = 0;
  while (i < out.length && out[i] === src[i]) i++;
  console.error(`first difference at ${i}:\n  door43 ${JSON.stringify(src.slice(i - 80, i + 80))}\n  export ${JSON.stringify(out.slice(i - 80, i + 80))}`);
}
check(out === src, "import then export gives Door43's bytes back");

console.log(`spWordLabelExport: ${passed} checks passed.`);
