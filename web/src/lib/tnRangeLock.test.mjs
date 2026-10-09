// Tests for tnRangeLock.ts (issue #1165). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/tnRangeLock.test.mjs

import { isTnVerseLocked, tnLockingJobs } from "./tnRangeLock.ts";

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    passed++;
  }
}

const job = (extra = {}) => ({
  book: "JER",
  start_chapter: 36,
  end_chapter: 36,
  state: "running",
  locks_resources: ["tn"],
  ...extra,
});
const locked = (jobs, verse) => isTnVerseLocked(tnLockingJobs(jobs, "JER", 36), verse);

const range = job({ locks_tn_verse_range: { start: 10, end: 15 } });
assert(!locked([range], 3), "range 10-15: a note at verse 3 is editable");
assert(locked([range], 10) && locked([range], 12) && locked([range], 15), "range 10-15: notes at 10, 12, 15 are locked");
assert(!locked([range], 16) && !locked([range], 0), "range 10-15: verse 16 and the intro are editable");

assert(locked([job({ locks_tn_verse_range: null })], 3), "whole-chapter run (null range) locks verse 3");
assert(locked([job()], 3), "no range field (optimistic row / older server) locks the whole chapter: fail closed");
assert(locked([range, job({ locks_tn_verse_range: { start: 1, end: 5 } })], 3), "two range jobs: the union is locked");
assert(locked([range, job({ locks_tn_verse_range: null })], 3), "a range job plus a whole-chapter job: whole chapter locked");

assert(!locked([job({ state: "queued" })], 3), "a queued job locks nothing");
assert(!locked([job({ locks_resources: ["tq"] })], 3), "a job that does not write tn locks no note");
assert(!locked([job({ start_chapter: 37, end_chapter: 37 })], 3), "a job on another chapter locks nothing here");
assert(!locked([job({ book: "HOS" })], 3), "a job on another book locks nothing here");
assert(tnLockingJobs([], "JER", 36).length === 0, "no jobs → nothing locked");

if (failed) {
  console.error(`\n${failed} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`tnRangeLock: ${passed} passed`);
