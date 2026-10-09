// Tests for tnRangeLock.ts (issue #1165). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/tnRangeLock.test.mjs

import { isTnMoveBlocked, isTnVerseLocked, movableNoteVerses, planRefusedTnMoveRollback, tnLockLabel, tnLockingJobs } from "./tnRangeLock.ts";

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

// ── move picker (J1) ──
const jobsOf = (...js) => tnLockingJobs(js, "JER", 36);
const verses = Array.from({ length: 21 }, (_, i) => i); // intro + 1..20
const blockedBy = (jobs) => (v) => isTnMoveBlocked(jobs, v);
{
  const picked = movableNoteVerses(verses, blockedBy(jobsOf(range)));
  assert(JSON.stringify(picked) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 18, 19, 20]), "range 10-15: the picker drops 10-15 and keeps the rest");
  assert(movableNoteVerses(verses, blockedBy(jobsOf(job({ locks_tn_verse_range: null })))) === verses, "whole-chapter run: picker unchanged (moves were never refused there), same array");
  assert(movableNoteVerses(verses, blockedBy([])) === verses, "no run: same array (no needless card re-render)");
  const two = movableNoteVerses(verses, blockedBy(jobsOf(range, job({ locks_tn_verse_range: { start: 1, end: 5 } }))));
  assert(!two.includes(3) && !two.includes(12) && two.includes(7), "two range runs: both ranges dropped");
}

// ── banner names the union (J2) ──
{
  assert(tnLockLabel(jobsOf(range)) === "notes in verses 10–15", "one range");
  assert(tnLockLabel(jobsOf(range, job({ locks_tn_verse_range: { start: 1, end: 5 } }))) === "notes in verses 1–5, 10–15", "two ranges, sorted");
  assert(tnLockLabel(jobsOf(range, job({ locks_tn_verse_range: null }))) === "notes", "range + whole chapter → all notes");
  assert(tnLockLabel(jobsOf(job({ locks_tn_verse_range: null }), range)) === "notes", "order does not matter");
  assert(tnLockLabel(jobsOf(range, job({ locks_tn_verse_range: { start: 16, end: 18 } }))) === "notes in verses 10–18", "adjacent ranges merge");
  assert(tnLockLabel(jobsOf(job({ locks_tn_verse_range: { start: 7, end: 7 } }))) === "notes in verse 7", "a one-verse range");
  assert(tnLockLabel(jobsOf(job())) === "notes", "no range field → all notes (fail closed)");
}

// ── refused move rollback (J1) ──
{
  const server = { verse: 3, ref_raw: "36:3", sort_order: 200 };
  const moved = { verse: 12, ref_raw: "36:12", sort_order: 900 };
  const patch = { verse: 12, ref_raw: "36:12", sort_order: 900 };
  const plan = planRefusedTnMoveRollback({ patch, serverRow: server, cachedRow: moved });
  assert(JSON.stringify(plan) === JSON.stringify(server), "a refused move puts the server's verse, ref and sort order back");
  assert(planRefusedTnMoveRollback({ patch: { note: "x" }, serverRow: server, cachedRow: moved }) === null, "not a move → nothing");
  assert(planRefusedTnMoveRollback({ patch, serverRow: undefined, cachedRow: moved }) === null, "row gone on the server → nothing");
  assert(planRefusedTnMoveRollback({ patch, serverRow: server, cachedRow: { ...moved, verse: 7, ref_raw: "36:7" } }) === null, "a later move already replaced it → leave it");
  assert(planRefusedTnMoveRollback({ patch, serverRow: server, cachedRow: server }) === null, "cache already at the server position → nothing");
}

if (failed) {
  console.error(`\n${failed} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`tnRangeLock: ${passed} passed`);
