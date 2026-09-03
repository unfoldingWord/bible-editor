// Tests for verseStructure.ts — the tombstone reducer that makes
// verse.bridged / verse.split / verse.updated WebSocket events converge under
// any delivery order (#729). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/verseStructure.test.mjs

import { applyBridged, applySplit, applyUpdated } from "./verseStructure.ts";

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

// ---------------------------------------------------------------------------
// Minimal verse rows. Only `verse`, `version`, `verse_end` matter here.
const v = (verse, version, verse_end = null) => ({ verse, version, verse_end });
const map = (...rows) => Object.fromEntries(rows.map((r) => [r.verse, r]));
const initial = (...rows) => ({ verses: map(...rows), tombstones: {} });

function fold(reducer, state, events) {
  let s = state;
  for (const ev of events) {
    if (ev.type === "bridged") s = reducer.bridged(s, ev.verse, ev.removedVerse, ev.removedVersion);
    else if (ev.type === "split") s = reducer.split(s, ev.verse, ev.newVerses);
    else if (ev.type === "updated") s = reducer.updated(s, ev.verse);
    else throw new Error(`unknown event ${ev.type}`);
  }
  return s;
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

function sameRows(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => a[k].version === b[k].version && a[k].verse_end === b[k].verse_end);
}

const describe = (events) => events.map((e) => e.label).join(" → ");

// The fixed reducer under test.
const tombstoned = { bridged: applyBridged, split: applySplit, updated: applyUpdated };

// WITNESS: the pre-#729 logic, transcribed from useChapter.applyLocalVerseBridge
// / applyLocalVerseSplit and Shell's onVerseUpdate guard. Kept here so the test
// documents *what* the tombstone fixes; if someone later "simplifies" the
// reducer back to this shape, the witness assertion below flips and says so.
const naive = {
  bridged(state, bridge, removedVerse) {
    const verses = { ...state.verses };
    const existingStart = verses[bridge.verse];
    delete verses[removedVerse];
    if (!existingStart || bridge.version >= existingStart.version) verses[bridge.verse] = bridge;
    return { verses, tombstones: state.tombstones };
  },
  split(state, start, newVerses) {
    const verses = { ...state.verses };
    const existingStart = verses[start.verse];
    if (!existingStart || start.version >= existingStart.version) verses[start.verse] = start;
    for (const nv of newVerses) {
      const ex = verses[nv.verse];
      if (!ex || nv.version >= ex.version) verses[nv.verse] = nv;
    }
    return { verses, tombstones: state.tombstones };
  },
  updated(state, verse) {
    const existing = state.verses[verse.verse];
    if (!existing || verse.version > existing.version) {
      return { verses: { ...state.verses, [verse.verse]: verse }, tombstones: state.tombstones };
    }
    return state;
  },
};

// ---------------------------------------------------------------------------
// Scenarios. Each is the server's actual history: starting rows, the events
// it broadcast (in the order it committed them), and its final rows. Versions
// follow the server's real arithmetic — bridge bumps the start row by 1 and
// deletes the absorbed row at its current version; split bumps the start row
// by 1 and seeds each recreated row at MAX(historical max, bridge version) + 1
// (api/src/verseBridge.ts).
const scenarios = [
  {
    name: "failure 1: bridge 1-2, then immediately split",
    start: initial(v(1, 5), v(2, 3)),
    events: [
      { label: "bridged(1-2@6, rm 2@3)", type: "bridged", verse: v(1, 6, 2), removedVerse: 2, removedVersion: 3 },
      { label: "split(1@7, new 2@7)", type: "split", verse: v(1, 7), newVerses: [v(2, 7)] },
    ],
    final: map(v(1, 7), v(2, 7)),
  },
  {
    name: "failure 2: save on verse 2, then bridge 1-2",
    start: initial(v(1, 5), v(2, 3)),
    events: [
      { label: "updated(2@4)", type: "updated", verse: v(2, 4) },
      { label: "bridged(1-2@6, rm 2@4)", type: "bridged", verse: v(1, 6, 2), removedVerse: 2, removedVersion: 4 },
    ],
    final: map(v(1, 6, 2)),
  },
  {
    name: "split 1-2, then rebridge",
    // The tab loaded the bridge fresh: no local verse 2 and no tombstone (the
    // historical max for 2 lives only in the server's edit_log).
    start: initial(v(1, 6, 2)),
    events: [
      { label: "split(1@7, new 2@7)", type: "split", verse: v(1, 7), newVerses: [v(2, 7)] },
      { label: "bridged(1-2@8, rm 2@7)", type: "bridged", verse: v(1, 8, 2), removedVerse: 2, removedVersion: 7 },
    ],
    final: map(v(1, 8, 2)),
  },
  {
    name: "save 2, bridge 1-2, split (3 events)",
    start: initial(v(1, 5), v(2, 3)),
    events: [
      { label: "updated(2@4)", type: "updated", verse: v(2, 4) },
      { label: "bridged(1-2@6, rm 2@4)", type: "bridged", verse: v(1, 6, 2), removedVerse: 2, removedVersion: 4 },
      { label: "split(1@7, new 2@7)", type: "split", verse: v(1, 7), newVerses: [v(2, 7)] },
    ],
    final: map(v(1, 7), v(2, 7)),
  },
  {
    name: "bridge 1-2, split, rebridge (3 events)",
    start: initial(v(1, 5), v(2, 3)),
    events: [
      { label: "bridged(1-2@6, rm 2@3)", type: "bridged", verse: v(1, 6, 2), removedVerse: 2, removedVersion: 3 },
      { label: "split(1@7, new 2@7)", type: "split", verse: v(1, 7), newVerses: [v(2, 7)] },
      { label: "bridged(1-2@8, rm 2@7)", type: "bridged", verse: v(1, 8, 2), removedVerse: 2, removedVersion: 7 },
    ],
    final: map(v(1, 8, 2)),
  },
  {
    name: "bridge 1-2, split, save recreated 2, extend bridge to 1-3 (4 events)",
    start: initial(v(1, 5), v(2, 3), v(3, 9)),
    events: [
      { label: "bridged(1-2@6, rm 2@3)", type: "bridged", verse: v(1, 6, 2), removedVerse: 2, removedVersion: 3 },
      { label: "split(1@7, new 2@7)", type: "split", verse: v(1, 7), newVerses: [v(2, 7)] },
      { label: "updated(2@8)", type: "updated", verse: v(2, 8) },
      // Bridge 2 with 3: start row is 2 (version 9), absorbed is 3 at its version 9.
      { label: "bridged(2-3@9, rm 3@9)", type: "bridged", verse: v(2, 9, 3), removedVerse: 3, removedVersion: 9 },
    ],
    final: map(v(1, 7), v(2, 9, 3)),
  },
];

// ---------------------------------------------------------------------------
// Convergence property: every permutation of the server's events folds to the
// server's final rows.
for (const sc of scenarios) {
  let orders = 0;
  for (const order of permutations(sc.events)) {
    orders++;
    const out = fold(tombstoned, sc.start, order);
    assert(
      sameRows(out.verses, sc.final),
      `${sc.name}: order [${describe(order)}] → ${JSON.stringify(out.verses)} expected ${JSON.stringify(sc.final)}`,
    );
  }
  assert(orders >= 2, `${sc.name}: exercised ${orders} orders`);
}

// Witness: the naive (pre-fix) reducer does NOT converge for the two failure
// sequences in the issue. If this ever passes, the scenarios have stopped
// modelling the reordering that motivated the tombstone.
{
  const witnesses = scenarios.slice(0, 3);
  for (const sc of witnesses) {
    let diverged = [];
    for (const order of permutations(sc.events)) {
      const out = fold(naive, sc.start, order);
      if (!sameRows(out.verses, sc.final)) diverged.push(describe(order));
    }
    assert(diverged.length > 0, `witness: naive reducer should diverge on "${sc.name}" for some order`);
    if (diverged.length > 0) console.log(`  naive diverges on "${sc.name}" for: ${diverged.join(" | ")}`);
  }
}

// ---------------------------------------------------------------------------
// Stale echo: an update at the tombstone version is a dead row's echo; one
// version above is a recreation.
{
  const k = 4;
  let s = initial(v(1, 5), v(2, k + 1));
  s = applyBridged(s, v(1, 6, 2), 2, k + 1);
  assert(!(2 in s.verses), "bridge removes verse 2 at its deletion version");
  assert(s.tombstones[2] === k + 1, "tombstone recorded at k+1");

  const stale = applyUpdated(s, v(2, k + 1));
  assert(stale === s, "update for verse 2 at k+1 (== tombstone) is rejected (identity)");
  const olderStale = applyUpdated(s, v(2, k));
  assert(olderStale === s, "update for verse 2 at k (< tombstone) is rejected");

  const recreated = applyUpdated(s, v(2, k + 2));
  assert(recreated.verses[2]?.version === k + 2, "update for verse 2 at k+2 (> tombstone) is applied");
  assert(recreated.tombstones[2] === k + 1, "applying a recreation leaves the tombstone in place");

  // force (own-tab optimistic edit) still cannot resurrect a tombstoned verse…
  const forcedStale = applyUpdated(s, v(2, k + 1), { force: true });
  assert(forcedStale === s, "force does not bypass the tombstone");
  // …but does bypass the newer-than-local check for a live verse.
  const forcedSame = applyUpdated(s, v(1, 6), { force: true });
  assert(forcedSame !== s && forcedSame.verses[1].version === 6, "force applies a same-version row (optimistic edit)");
  const strictSame = applyUpdated(s, v(1, 6));
  assert(strictSame === s, "without force, a same-version row is a no-op");
}

// Tombstone monotonicity: a later bridge event with a lower removedVersion
// (reordered older event) must not lower the tombstone.
{
  let s = initial(v(1, 5), v(2, 3));
  s = applyBridged(s, v(1, 8, 2), 2, 7);
  const before = s.tombstones[2];
  s = applyBridged(s, v(1, 6, 2), 2, 3);
  assert(s.tombstones[2] === before && before === 7, "tombstone is max(existing, removedVersion)");
  assert(s.verses[1].version === 8, "older bridge event does not clobber the newer start row");
}

// Bridge keeps a local row that is NEWER than the removed version (a
// recreation already landed).
{
  let s = initial(v(1, 7), v(2, 7));
  s = applyBridged(s, v(1, 6, 2), 2, 3);
  assert(s.verses[2]?.version === 7, "local verse 2@7 survives a stale bridge that removed 2@3");
  assert(s.verses[1].version === 7, "start row 1@7 survives a stale bridge start 1-2@6");
}

// Compatibility: a bridge event without removedVersion (older server) deletes
// unconditionally and records no tombstone — today's behaviour, no worse.
{
  let s = initial(v(1, 5), v(2, 3));
  s = applyBridged(s, v(1, 6, 2), 2, undefined);
  assert(!(2 in s.verses), "no removedVersion: absorbed row is still removed");
  assert(!(2 in s.tombstones), "no removedVersion: no tombstone recorded");
}

// Identity on no-op keeps React state stable (no needless re-render).
{
  const s = initial(v(1, 6, 2));
  assert(applyBridged(s, v(1, 6, 2), 2, 3) !== s, "first bridge application changes state (tombstone)");
  const s2 = applyBridged(s, v(1, 6, 2), 2, 3);
  assert(applyBridged(s2, v(1, 6, 2), 2, 3) === s2, "re-applying the identical bridge is identity");
  const s3 = applySplit(s2, v(1, 7), [v(2, 7)]);
  assert(applySplit(s3, v(1, 7), [v(2, 7)]) === s3, "re-applying the identical split is identity");
}

// Split gating: a recreated verse at or below its tombstone is rejected (a
// stale split echo after a rebridge), above it is applied.
{
  let s = initial(v(1, 8, 2));
  s = applyBridged(s, v(1, 8, 2), 2, 7);
  const staleSplit = applySplit(s, v(1, 7), [v(2, 7)]);
  assert(staleSplit === s, "split whose recreated 2@7 == tombstone is a full no-op (start 1@7 < 8 too)");
  const freshSplit = applySplit(s, v(1, 9), [v(2, 9)]);
  assert(freshSplit.verses[2]?.version === 9 && freshSplit.verses[1].version === 9, "later split above the tombstone applies");
}

console.log(`\nverseStructure: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
