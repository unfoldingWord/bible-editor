// parsePipelineRange (issue #1160): the AI-pipeline dialog's reference box.
// Chapters and chapter ranges as before; a verse range ("36:10-15") only when
// the caller allows verses (the notes pipeline), and only inside one chapter.
// Run from web/: node --experimental-strip-types --no-warnings src/lib/refParser.test.mjs

import { parsePipelineRange, parseChapterRange } from "./refParser.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}
const ok = (book, startChapter, endChapter, verses) => ({
  ok: true,
  range: { book, startChapter, endChapter, ...(verses ? { verseStart: verses[0], verseEnd: verses[1] } : {}) },
});
const isErr = (r) => r.ok === false && typeof r.error === "string" && r.error.length > 0;

console.log("\n[chapters, unchanged]");
eq(parsePipelineRange("36", "JER", true), ok("JER", 36, 36), "single chapter");
eq(parsePipelineRange("36-38", "JER", true), ok("JER", 36, 38), "chapter range");
eq(parsePipelineRange("36-38", "JER", false), parseChapterRange("36-38", "JER"), "no verses allowed → same as parseChapterRange");

console.log("\n[verse ranges, notes]");
eq(parsePipelineRange("36:10-15", "JER", true), ok("JER", 36, 36, [10, 15]), "C:V1-V2");
eq(parsePipelineRange(" 36 : 10 - 15 ", "JER", true), ok("JER", 36, 36, [10, 15]), "spaces tolerated");
eq(parsePipelineRange("JER 36:10-15", "ZEC", true), ok("JER", 36, 36, [10, 15]), "BOOK C:V1-V2");
eq(parsePipelineRange("jer 36:10-15", "ZEC", true), ok("JER", 36, 36, [10, 15]), "book is uppercased");
eq(parsePipelineRange("36:12", "JER", true), ok("JER", 36, 36, [12, 12]), "a single verse is a one-verse range");

console.log("\n[rejected]");
eq(isErr(parsePipelineRange("36:15-10", "JER", true)), true, "end verse before start verse");
eq(isErr(parsePipelineRange("36:0-5", "JER", true)), true, "verse 0 (the intro) is not a verse range");
eq(isErr(parsePipelineRange("36:10-37:5", "JER", true)), true, "cross-chapter verse range");
eq(isErr(parsePipelineRange("36-37:5", "JER", true)), true, "chapter range with a verse");
eq(isErr(parsePipelineRange("36:", "JER", true)), true, "colon with no verse");
eq(isErr(parsePipelineRange("36:10-15", "JER", false)), true, "verse range when verses are not allowed (non-notes pipeline)");
eq(isErr(parsePipelineRange("36:10-201", "JER", true)), true, "verse past the bot's cap (200)");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("refParser tests passed");
