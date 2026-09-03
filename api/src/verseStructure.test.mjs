// Unit coverage for verseStructure.ts's planStructure (issue #728) — the pure
// structural planner the nightly reimport runs per chapter before any content
// write. Real-SQLite end-to-end cases live in applyVerseRows.test.mjs.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/verseStructure.test.mjs

import { planStructure, structureKey, MAX_STRUCTURE_COMPONENT_ROWS } from "./verseStructure.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const row = (verse, verse_end = null, version = 1) => ({ chapter: 5, verse, verse_end, version });
const mv = (verse, verseEnd = null) => ({ chapter: 5, verse, verseEnd });
const HUMAN = { mayHoldHumanEdit: true, hasHumanCommit: true, incomplete: false, incompleteReason: "", counts: { ours: 1, ai: 0, human: 1 }, humanShas: ["a"] };
const AI_ONLY = { mayHoldHumanEdit: false, hasHumanCommit: false, incomplete: false, incompleteReason: "", counts: { ours: 1, ai: 1, human: 0 }, humanShas: [] };
const CUT = { confirmedAt: 200, editId: 100, lineage: HUMAN };
const CUT_AI = { confirmedAt: 200, editId: 100, lineage: AI_ONLY };
const summary = (p) => ({
  skip: [...p.skipMasterKeys].sort(),
  adoptions: p.adoptions.map((a) => [a.kind, a.anchor.verse, a.anchorMaster.verseEnd ?? null, a.absorbed.map((r) => r.verse), a.recreated.map((m) => m.verse)]),
  conflicts: p.conflicts.map((c) => [c.verse, c.reason]),
  keptLocal: p.keptLocal.map((k) => [k.d1Rows.map((r) => r.verse), k.masterVerses.map((m) => m.verse)]),
  unclassified: p.unclassified,
});
const EMPTY = { skip: [], adoptions: [], conflicts: [], keptLocal: [], unclassified: 0 };

console.log("\n[agreement and one-sided components are not structural questions]");
eq(summary(planStructure([row(1), row(2)], [mv(1), mv(2)], CUT, new Map())), EMPTY, "plain rows on both sides");
eq(summary(planStructure([row(1, 2)], [mv(1, 2)], CUT, new Map())), EMPTY, "the same bridge on both sides");
eq(summary(planStructure([row(1, 2)], [mv(1, 2), mv(3)], CUT, new Map())), EMPTY, "a master-only neighbour (3) is a plain insert, not a component member");
eq(summary(planStructure([row(1, 2), row(3)], [mv(1, 2)], CUT, new Map())), EMPTY, "a D1-only neighbour is left alone");
eq(summary(planStructure([row(1, 1)], [mv(1)], CUT, new Map())), EMPTY, "a degenerate verse_end == verse row agrees with a singleton");
eq(summary(planStructure([row(0), row(1)], [mv(0), mv(1)], CUT, new Map())), EMPTY, "verse 0 is ignored on both sides");
eq(summary(planStructure([row(1, 3)], [mv(1, 4)], CUT, new Map())), EMPTY,
  "a verse_end-only change with no other row on either side (master widened over verses D1 lacks) stays with the content path (#609 shape)");
eq(summary(planStructure([row(1, 3)], [mv(1, 2)], CUT, new Map())), EMPTY,
  "…and the narrowing twin (master no longer carries verse 3 at all) likewise");
eq(summary(planStructure([row(1, 3)], [mv(1, 4)], null, new Map())), EMPTY, "…regardless of watermark");

console.log("\n[table row 1: local bridge, master plain → kept local, master rows skipped]");
{
  const edits = new Map([[structureKey(5, 1), { id: 150, createdAt: 300 }]]);
  eq(summary(planStructure([row(1, 2, 3)], [mv(1), mv(2), mv(3)], CUT, edits)),
    { ...EMPTY, skip: ["5:1", "5:2"], keptLocal: [[[1], [1, 2]]] }, "id above the boundary → local; 3 untouched");
  const ts = new Map([[structureKey(5, 1), { id: 150, createdAt: 250 }]]);
  eq(summary(planStructure([row(1, 2, 3)], [mv(1), mv(2)], { confirmedAt: 200, editId: null, lineage: HUMAN }, ts)),
    { ...EMPTY, skip: ["5:1", "5:2"], keptLocal: [[[1], [1, 2]]] }, "timestamp fallback: created_at >= confirmedAt → local");
  const old = new Map([[structureKey(5, 1), { id: 150, createdAt: 100 }]]);
  eq(summary(planStructure([row(1, 2, 3)], [mv(1), mv(2)], { confirmedAt: 200, editId: null, lineage: HUMAN }, old)).keptLocal, [],
    "…and created_at < confirmedAt is exported on the fallback path");
}

console.log("\n[table row 2: exported bridge, master un-bridged → split adoption (human) / refused (non-human)]");
{
  const below = new Map([[structureKey(5, 1), { id: 50, createdAt: 10 }]]);
  eq(summary(planStructure([row(1, 2, 3)], [mv(1), mv(2)], CUT, below)),
    { ...EMPTY, skip: ["5:2"], adoptions: [["split", 1, null, [], [2]]] }, "structural row at/below the boundary → exported → split; only the recreated key is skipped");
  eq(summary(planStructure([row(1, 2, 3)], [mv(1), mv(2)], CUT, new Map())).adoptions, [["split", 1, null, [], [2]]],
    "no structural row at all (imported structure) is exported too");
  eq(summary(planStructure([row(1, 2, 3)], [mv(1), mv(2)], CUT_AI, below)),
    { ...EMPTY, skip: ["5:1", "5:2"], conflicts: [[1, "master_moved_non_human"]] }, "a provably non-human divergence keeps D1 and flags the start verse");
  eq(summary(planStructure([row(1, 4)], [mv(1, 2), mv(3, 4)], CUT, new Map())).adoptions, [["split", 1, 2, [], [3]]],
    "a bridge narrowed to a bridge + a bridge is still a pure split");
}

console.log("\n[table row 3: D1 split after the export, master still bridged → kept local]");
{
  const edits = new Map([[structureKey(5, 1), { id: 150, createdAt: 300 }]]);
  eq(summary(planStructure([row(1), row(2)], [mv(1, 2)], CUT, edits)),
    { ...EMPTY, skip: ["5:1"], keptLocal: [[[1, 2], [1]]] }, "the 'split' row on the start key classifies the component local");
}

console.log("\n[table row 4: master bridged, D1 plain and exported → bridge adoption]");
{
  eq(summary(planStructure([row(1), row(2, null, 7)], [mv(1, 2)], CUT, new Map())),
    { ...EMPTY, adoptions: [["bridge", 1, 2, [2], []]] }, "D1's 2 is absorbed; nothing is skipped (the anchor goes through the content path)");
  eq(summary(planStructure([row(1, 2), row(3, 4)], [mv(1, 4)], CUT, new Map())).adoptions, [["bridge", 1, 4, [3], []]],
    "extending a bridge over a bridge is still a pure absorb");
  eq(summary(planStructure([row(1), row(2), row(3)], [mv(1, 3)], CUT, new Map())).adoptions, [["bridge", 1, 3, [2, 3], []]],
    "several absorbed rows, sorted");
}

console.log("\n[no watermark → unclassified, kept, skipped]");
eq(summary(planStructure([row(1, 2)], [mv(1), mv(2)], null, new Map())), { ...EMPTY, skip: ["5:1", "5:2"], unclassified: 1 }, "null cutoff");
eq(summary(planStructure([row(1, 2)], [mv(1), mv(2)], { confirmedAt: null, editId: null }, new Map())), { ...EMPTY, skip: ["5:1", "5:2"], unclassified: 1 }, "empty cutoff");

console.log("\n[shapes that are not a pure bridge or split are refused as complex]");
eq(summary(planStructure([row(1, 2), row(3)], [mv(1), mv(2, 3)], CUT, new Map())),
  { ...EMPTY, skip: ["5:1", "5:2"], conflicts: [[1, "master_structure_complex"]] }, "anchor shrinks AND a D1 row must go");
eq(summary(planStructure([row(1, 2), row(3, 4)], [mv(1, 3), mv(4)], CUT, new Map())).conflicts, [[1, "master_structure_complex"]],
  "anchor widens but the absorbed row pokes out past master's range");
eq(summary(planStructure([row(2, 3)], [mv(1, 3)], CUT, new Map())).conflicts, [[2, "master_structure_complex"]],
  "no anchor: master's range starts where D1 has no row");
eq(summary(planStructure([row(1, 2), row(2)], [mv(1, 2)], CUT, new Map())).conflicts, [[1, "master_structure_complex"]],
  "a pre-existing D1 overlap (1-2 beside 2) is never resolved by guessing");
{
  const wide = Array.from({ length: MAX_STRUCTURE_COMPONENT_ROWS + 2 }, (_, i) => row(i + 1));
  const p = planStructure(wide, [mv(1, MAX_STRUCTURE_COMPONENT_ROWS + 2)], CUT, new Map());
  eq(p.conflicts.map((c) => c.reason), ["master_structure_complex"], "more absorbed rows than one batch can carry is refused");
}

console.log("\n[components are independent, and chapters are independent]");
{
  const edits = new Map([[structureKey(5, 1), { id: 150, createdAt: 300 }]]);
  const p = planStructure(
    [row(1, 2), row(4), row(5), { chapter: 6, verse: 1, verse_end: 2, version: 1 }],
    [mv(1), mv(2), mv(4, 5), { chapter: 6, verse: 1, verseEnd: null }, { chapter: 6, verse: 2, verseEnd: null }],
    CUT, edits,
  );
  eq(summary(p), {
    skip: ["5:1", "5:2", "6:2"],
    adoptions: [["bridge", 4, 5, [5], []], ["split", 1, null, [], [2]]],
    conflicts: [],
    keptLocal: [[[1], [1, 2]]],
    unclassified: 0,
  }, "chapter 5: 1-2 local (kept) and 4/5 bridged on master (adopt); chapter 6: exported bridge un-bridged (adopt)");
}

console.log("\n[the lineage question is asked over the whole component range]");
{
  // Human commits mapped to verse 2 only; the component is 1-2. The start verse
  // alone would say "non-human"; the whole range says a human touched it.
  const narrowed = { ...HUMAN, refsComplete: true, humanRefs: ["5:2"] };
  const p = planStructure([row(1, 2)], [mv(1), mv(2)], { confirmedAt: 200, editId: 100, lineage: narrowed }, new Map());
  eq(p.adoptions.length, 1, "a human hunk in the second half of the bridge authorizes the adoption");
  const elsewhere = { ...HUMAN, refsComplete: true, humanRefs: ["5:9"] };
  const q = planStructure([row(1, 2)], [mv(1), mv(2)], { confirmedAt: 200, editId: 100, lineage: elsewhere }, new Map());
  eq(q.conflicts.map((c) => c.reason), ["master_moved_non_human"], "…and a human hunk elsewhere in the chapter does not");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll verseStructure assertions passed.");
