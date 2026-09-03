// Tests for verseStructure.ts — the tombstone reducer that makes
// verse.bridged / verse.split / verse.updated WebSocket events converge under
// any delivery order (#729). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/verseStructure.test.mjs

import { applyBridged, applySplit, applyUpdated, mergeRefetched } from "./verseStructure.ts";

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

// ---------------------------------------------------------------------------
// mergeRefetched — the reconnect refetch must not regress rows this tab
// already holds at an equal-or-newer version.
//
// The race: the browser goes `online`; the outbox drains (PATCH verse 2,
// If-Match 5) and the WS reconnects (GET chapter) within the same moment. D1
// serves the GET before the PATCH commits, but the PATCH's 200 (v6, C′)
// reaches the tab first; the GET's v5/C lands second. An unconditional
// `setData(payload)` then regresses verse 2 to v5/C, and the next edit goes
// out with If-Match 5 → 409 against the user's own save.
{
  // Chapter-payload shaped fixtures. Only book/chapter/verses/tombstones and
  // one non-verse list matter to the merge; the rest is filler.
  const row = (verse, version, content, verse_end = null) => ({
    verse,
    version,
    content,
    verse_end,
    bible_version: "ult",
  });
  const payload = (rows, extra = {}) => ({
    book: "ZEC",
    chapter: 1,
    verses: { ult: map(...rows) },
    tn: [],
    tq: [],
    twl: [],
    verseStatuses: [],
    verseLaneChecks: [],
    ...extra,
  });

  // WITNESS: today's refetch is `setData(payload)` — an unconditional replace.
  // Modelled here so the bug is pinned as a failing assertion against the
  // model, not just as a passing one against the fix.
  const hardReplace = (_prev, fetched) => fetched;
  {
    const local = payload([row(1, 3, "a"), row(2, 6, "C′")]);
    const fetched = payload([row(1, 3, "a"), row(2, 5, "C")]);
    const out = hardReplace(local, fetched);
    assert(out.verses.ult[2].version === 5, "witness: unconditional replace regresses 2@6 → 2@5 (the bug)");
  }

  // 1. The interleaving above: local v6 vs fetched v5 → keep v6/C′.
  {
    const local = payload([row(1, 3, "a"), row(2, 6, "C′")]);
    const fetched = payload([row(1, 3, "a"), row(2, 5, "C")]);
    const out = mergeRefetched(local, fetched);
    assert(out.verses.ult[2].version === 6 && out.verses.ult[2].content === "C′", "local 2@6 survives a stale fetched 2@5");
    assert(out.verses.ult[2] === local.verses.ult[2], "the kept row is the local object itself");
    // Equal version keeps the local object too: by version alone an identical
    // row and a pending optimistic edit are indistinguishable, and keeping the
    // local one is right in both cases.
    assert(out.verses.ult[1] === local.verses.ult[1], "an equal-version row keeps the local object");
  }

  // 2. Equal version, optimistic content (force-applied edit whose PATCH is
  //    still pending) → keep local.
  {
    const local = payload([row(2, 5, "C′ (pending)")]);
    const fetched = payload([row(2, 5, "C")]);
    const out = mergeRefetched(local, fetched);
    assert(out.verses.ult[2].content === "C′ (pending)", "same-version optimistic local row is kept over the fetched row");
  }

  // 3. Fetched newer → take fetched.
  {
    const local = payload([row(2, 5, "C")]);
    const fetched = payload([row(2, 7, "D")]);
    const out = mergeRefetched(local, fetched);
    assert(out.verses.ult[2].version === 7 && out.verses.ult[2].content === "D", "fetched 2@7 replaces local 2@5");
  }

  // 4. Phantom local verse absent from fetched (missed verse.bridged) → dropped.
  {
    const local = payload([row(1, 3, "a"), row(2, 4, "phantom")]);
    const fetched = payload([row(1, 5, "a-b", 2)]);
    const out = mergeRefetched(local, fetched);
    assert(!(2 in out.verses.ult), "a verse the server no longer has is dropped — the whole point of the reconnect refetch");
    assert(out.verses.ult[1].verse_end === 2 && out.verses.ult[1].version === 5, "the bridge row comes from the fetched payload");
  }

  // 5. Tombstones cleared: the merged map is authoritative again.
  {
    const local = payload([row(1, 5, "a-b", 2)], { verseTombstones: { ult: { 2: 4 } } });
    const fetched = payload([row(1, 5, "a-b", 2)]);
    const out = mergeRefetched(local, fetched);
    assert(out.verseTombstones === undefined, "verseTombstones do not survive a merged refetch");
  }

  // 5b. …but a fetched row at or below a tombstone this tab holds is the
  //     deleted row seen through a stale read (GET served before the bridge
  //     committed; the bridge event then arrived over the fresh socket).
  //     Dropping it is the same clock argument applyUpdated uses.
  {
    const local = payload([row(1, 6, "a-b", 2)], { verseTombstones: { ult: { 2: 5 } } });
    const fetched = payload([row(1, 3, "a"), row(2, 5, "C")]);
    const out = mergeRefetched(local, fetched);
    assert(!(2 in out.verses.ult), "fetched 2@5 at the tombstone (2 deleted @5) is not resurrected");
    assert(out.verses.ult[1].version === 6 && out.verses.ult[1].verse_end === 2, "the newer local bridge row 1@6 is kept over fetched 1@3");
    const recreated = payload([row(1, 7, "a"), row(2, 7, "C2")]);
    const out2 = mergeRefetched(local, recreated);
    assert(out2.verses.ult[2]?.version === 7, "fetched 2@7 above the tombstone is a genuine recreation and is added");
  }

  // 6. New server verse (split while disconnected) → added.
  {
    const local = payload([row(1, 5, "a-b", 2)]);
    const fetched = payload([row(1, 6, "a"), row(2, 6, "b")]);
    const out = mergeRefetched(local, fetched);
    assert(out.verses.ult[2]?.version === 6 && out.verses.ult[1].verse_end === null, "split-created verse 2 is added and the start row de-bridged");
  }

  // 7. Non-verse parts always come from the fetched payload.
  {
    const local = payload([row(2, 6, "C′")], { tn: [{ id: "old" }], verseStatuses: [{ verse: 2, done: 0 }] });
    const fetched = payload([row(2, 5, "C")], { tn: [{ id: "new" }], verseStatuses: [{ verse: 2, done: 1 }] });
    const out = mergeRefetched(local, fetched);
    assert(out.tn === fetched.tn && out.verseStatuses === fetched.verseStatuses, "rows / statuses are the fetched ones even when a verse was kept");
    assert(out.verses.ult[2].version === 6, "…while the newer local verse is still kept");
  }

  // 8. Identity: when no local row is kept the fetched object is returned as
  //    is (fetched strictly newer on every overlapping verse, or no overlap);
  //    a null / different-chapter prev is a plain replace.
  {
    const fetched = payload([row(1, 3, "a"), row(2, 5, "C")]);
    assert(mergeRefetched(null, fetched) === fetched, "null prev → fetched itself");
    assert(mergeRefetched(payload([row(1, 2, "a0"), row(2, 4, "C0")]), fetched) === fetched, "fetched strictly newer everywhere → fetched itself");
    assert(mergeRefetched(payload([row(3, 9, "z")]), fetched) === fetched, "no overlapping verse → fetched itself");
    const otherChapter = { ...payload([row(2, 9, "zzz")]), chapter: 2 };
    assert(mergeRefetched(otherChapter, fetched) === fetched, "prev from another chapter never leaks rows into the fetched one");
  }

  // 9. A bible_version present locally but absent from the fetched payload is
  //    dropped with its rows; one absent locally is taken whole.
  {
    const local = { ...payload([row(2, 6, "C′")]), verses: { ult: map(row(2, 6, "C′")), ust: map(row(2, 9, "ust")) } };
    const fetched = { ...payload([row(2, 5, "C")]), verses: { ult: map(row(2, 5, "C")), ueb: map(row(2, 1, "ueb")) } };
    const out = mergeRefetched(local, fetched);
    assert(!("ust" in out.verses) && out.verses.ueb[2].version === 1 && out.verses.ult[2].version === 6, "bible_version keys follow the fetched payload; per-verse merge still applies");
  }
}

console.log(`\nverseStructure: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
