// Issue #1166: a job's scope label and the notes same-scope check. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/pipelineScope.test.mjs

import { jobScopeLabel, sameNotesScope } from "./pipelineScope.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const job = (verse_range, start_chapter = 1, end_chapter = start_chapter) => ({
  book: "ZEC",
  start_chapter,
  end_chapter,
  verse_range,
});

console.log("\n[jobScopeLabel]");
assert(jobScopeLabel(job({ start: 3, end: 5 })) === "ZEC 1:3-5", "range → ZEC 1:3-5");
assert(jobScopeLabel(job({ start: 4, end: 4 })) === "ZEC 1:4", "one verse → ZEC 1:4");
assert(jobScopeLabel(job(null)) === "ZEC 1", "whole chapter → ZEC 1");
assert(jobScopeLabel(job(undefined)) === "ZEC 1", "no verse_range field → ZEC 1");
assert(jobScopeLabel(job(null, 1, 3)) === "ZEC 1–3", "chapter span → ZEC 1–3");
assert(jobScopeLabel(job("invalid")) === "ZEC 1 (verses unknown)", "invalid → unknown, not whole chapter");

console.log("\n[sameNotesScope]");
const req = (verseRange, startChapter = 1, endChapter = startChapter) => ({
  book: "ZEC",
  startChapter,
  endChapter,
  verseRange,
});
assert(sameNotesScope(job({ start: 3, end: 5 }), req({ start: 3, end: 5 })), "same range → same");
assert(!sameNotesScope(job({ start: 3, end: 5 }), req({ start: 6, end: 8 })), "1:3-5 running, 1:6-8 typed → different (queues)");
assert(!sameNotesScope(job({ start: 3, end: 5 }), req(null)), "range running, whole chapter typed → different");
assert(!sameNotesScope(job(null), req({ start: 3, end: 5 })), "whole chapter running, range typed → different");
assert(sameNotesScope(job(null), req(null)), "whole chapter both → same");
assert(sameNotesScope(job(undefined), req(null)), "no verse_range field reads as whole chapter");
assert(!sameNotesScope(job("invalid"), req(null)), "invalid never matches whole chapter");
assert(!sameNotesScope(job("invalid"), req({ start: 3, end: 5 })), "invalid never matches a range");
assert(!sameNotesScope(job(null, 1, 3), req(null)), "multi-chapter run vs one chapter → different (server matches exact chapters)");
assert(!sameNotesScope({ ...job(null), book: "MAL" }, req(null)), "other book → different");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("pipelineScope tests passed");
