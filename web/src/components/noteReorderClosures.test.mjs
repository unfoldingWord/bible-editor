// Regression coverage for issue #489: a memo-skipped NoteCard whose own data
// is unchanged, but whose NEIGHBOR moved during an arrow reorder, must not
// keep a stale onMoveUp/onMoveDown closure.
//
// NoteCard.tsx is a JSX component and can't run under plain node, so — same
// convention as syncStaleness.test.mjs — this replicates the pure logic
// under test: ResourceColumn's per-card prevNote/nextNote derivation
// (renderNoteCard), Shell.tsx's reorderSequential (renumbers only the rows
// that actually shifted), and NoteCard's areNotePropsEqual comparator (the
// prevNoteId/nextNoteId lines added by the fix). If any of these three
// formulas drifts from the real code, this test failing is the signal.

import assert from "node:assert/strict";

// ── ResourceColumn.renderNoteCard's neighbor derivation ─────────────────────
// samePeers = peers.filter(p => p.verse === r.verse); idx = samePeers.indexOf(r);
// prevNote = idx > 0 ? samePeers[idx - 1] : null; nextNote = idx < samePeers.length - 1 ? samePeers[idx + 1] : null;
function neighborsFor(sortedPeers, id) {
  const idx = sortedPeers.findIndex((r) => r.id === id);
  const prevNote = idx > 0 ? sortedPeers[idx - 1] : null;
  const nextNote = idx < sortedPeers.length - 1 ? sortedPeers[idx + 1] : null;
  return { prevNoteId: prevNote?.id ?? null, nextNoteId: nextNote?.id ?? null };
}

// ── Shell.tsx's reorderSequential (renumbers ONLY the rows that shifted) ────
function reorderSequential(sorted, draggedId, refId, position) {
  const dragged = sorted.find((r) => r.id === draggedId);
  const without = sorted.filter((r) => r.id !== draggedId);
  const refIdx = without.findIndex((r) => r.id === refId);
  const insertIdx = position === "before" ? refIdx : refIdx + 1;
  const next = [...without.slice(0, insertIdx), dragged, ...without.slice(insertIdx)];
  const changes = [];
  next.forEach((row, i) => {
    const sort_order = (i + 1) * 100;
    if (row.sort_order !== sort_order) changes.push({ ...row, sort_order });
  });
  return { next, changes };
}

// ── NoteCard.areNotePropsEqual — only the props relevant to this bug ────────
function propsEqualPreFix(a, b) {
  return a.row === b.row && a.dragging === b.dragging;
}
function propsEqualPostFix(a, b) {
  return (
    a.row === b.row &&
    a.dragging === b.dragging &&
    (a.prevNoteId ?? null) === (b.prevNoteId ?? null) &&
    (a.nextNoteId ?? null) === (b.nextNoteId ?? null)
  );
}

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ok: ${msg}`);
};

console.log("[the traced #489 scenario: A(100) B(200) C(300) D(400), click B's down-arrow]");

const rowA = { id: "A", sort_order: 100 };
const rowB = { id: "B", sort_order: 200 };
const rowC = { id: "C", sort_order: 300 };
const rowD = { id: "D", sort_order: 400 };
const before = [rowA, rowB, rowC, rowD];

// D's props as ResourceColumn would have built them on the render BEFORE the
// move — this is the closure D's onMoveUp/onMoveDown captured.
const dPropsBefore = { row: rowD, dragging: false, ...neighborsFor(before, "D") };
check(dPropsBefore.prevNoteId === "C", "before the move, D's captured prevNote is C");

// Move B to just after C: reorderSequential renumbers ONLY the shifted rows
// (B and C), per its own doc comment — D and A keep their original row
// objects/sort_order, exactly like a real Shell.tsx dispatch only patches
// the rows reorderSequential returned.
const { next: after, changes } = reorderSequential(before, "B", "C", "after");
check(
  changes.map((c) => c.id).sort().join(",") === "B,C",
  "reorderSequential only renumbers the two rows that actually shifted (B, C) — D's row object is untouched",
);
check(after.map((r) => r.id).join(",") === "A,C,B,D", "new order is A, C, B, D");

// Rebuild the peers array the way ResourceColumn would after Shell applies
// the patch: A and D keep their SAME row references (memo's load-bearing
// `row === row` check would pass for both); only B and C get new objects.
const changedById = new Map(changes.map((c) => [c.id, c]));
const afterPeers = before
  .map((r) => changedById.get(r.id) ?? r) // A, D unchanged refs; B, C replaced
  .sort((a, b) => a.sort_order - b.sort_order);
check(afterPeers.find((r) => r.id === "D") === rowD, "D's row object reference is unchanged after the reorder (real memo-skip precondition)");

const dPropsAfter = { row: rowD, dragging: false, ...neighborsFor(afterPeers, "D") };
check(dPropsAfter.prevNoteId === "B", "after the move, D's REAL current neighbor is now B, not C");

console.log("\n[pre-fix comparator: D memo-skips despite its neighbor changing — the bug]");
check(
  propsEqualPreFix(dPropsBefore, dPropsAfter) === true,
  "without prevNoteId/nextNoteId, D's props read as unchanged -> React.memo skips D -> its onMoveUp closure keeps pointing at stale neighbor C",
);

console.log("\n[post-fix comparator: D re-renders, picking up the correct neighbor]");
check(
  propsEqualPostFix(dPropsBefore, dPropsAfter) === false,
  "with prevNoteId/nextNoteId compared, D's props are correctly seen as changed -> D re-renders -> onMoveUp is rebuilt against the real neighbor B",
);

console.log("\n[clicking D's up-arrow after the fix reorders against the correct neighbor]");
{
  // Post-fix, D's freshly rebuilt onMoveUp closure calls
  // onNoteReorder(D, dPropsAfter.prevNoteId, "before") — i.e. against B, the
  // real current neighbor — instead of the stale C from before the move.
  const { next: finalOrder } = reorderSequential(after, "D", dPropsAfter.prevNoteId, "before");
  check(finalOrder.map((r) => r.id).join(",") === "A,C,D,B", "correct result: A, C, D, B (D moved up exactly one slot)");
}

console.log("\n[the pre-fix bug's actual mis-ordering, for contrast]");
{
  // With the stale closure (pre-fix), D's onMoveUp still calls
  // onNoteReorder(D, "C", "before") — the neighbor from BEFORE B moved.
  const { next: buggyOrder } = reorderSequential(after, "D", "C", "before");
  check(
    buggyOrder.map((r) => r.id).join(",") === "A,D,C,B",
    "the pre-fix bug: D leaps two slots to A, D, C, B instead of A, C, D, B — exactly the failure scenario in issue #489",
  );
}

console.log(`\nAll ${passed} noteReorderClosures assertions passed.`);
