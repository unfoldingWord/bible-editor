import usfm from "usfm-js";
import { lintUsfmVerses } from "./api/src/lint.ts";
import { findReusedSourceWordIds, parseAlignment } from "./web/src/lib/alignment.ts";
import { nfc } from "./web/src/lib/hebrew.ts";

const text =
  `\c 1\n\p\n\v 1 ` +
  `\zaln-s |x-strong="H1" x-occurrence="1" x-occurrences="1" x-content="קיץ"\*` +
  `\zaln-s |x-strong="H1" x-occurrence="1" x-occurrences="1" x-content="קיץ"\*` +
  `\w whole\w*\zaln-e\*\zaln-e\* ` +
  `\zaln-s |x-strong="H1" x-occurrence="1" x-occurrences="1" x-content="קיץ"\*\w hot\w*\zaln-e\*\n`;
const vos = usfm.toJSON(text).chapters["1"]["1"].verseObjects;
const row = { book: "1CH", chapter: 1, verse: 1, verse_end: null, bible_version: "ULT", version: 1, content_json: JSON.stringify({ verseObjects: vos }) };
const issues = lintUsfmVerses([row]).filter(i => i.check === "Reused source token");
console.log("LINT flags:", issues.length);

const srcVo = [{ type: "word", tag: "w", text: "קיץ", strong: "H1" }];
const st = parseAlignment(vos, srcVo);
const idx = new Map([[`t:${nfc("קיץ")}|1`, 0]]);
const keyOf = (s) => {
  const c = nfc(s.content ?? "");
  const p = idx.get(`t:${c}|${s.occurrence}`);
  return p !== undefined ? `p${p}` : (c === "" ? null : `c${c}|${s.occurrence}`);
};
console.log("groups:", JSON.stringify(st.groups.map(g => g.source.map(s => `${s.content}/${s.occurrence}`))));
console.log("UI reused ids:", findReusedSourceWordIds(st.groups, keyOf).size);
