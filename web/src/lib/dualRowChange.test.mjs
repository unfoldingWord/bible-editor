// Tests for dualRowChange.ts — the dual aligner's notice when a bridge or
// split drops unsaved work (#1075). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/dualRowChange.test.mjs

import { droppedEditNotice } from "./dualRowChange.ts";

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

const row = (rowKey, label, extra = {}) => ({ chapter: 7, verseNum: 7, rowKey, label, ...extra });
const dirtyText = { reading: true, panel: false };
const dirtyDrags = { reading: false, panel: true };
const both = { reading: true, panel: true };
const clean = { reading: false, panel: false };

// A bridge under unsaved reading text names the verse it was typed on.
const bridged = droppedEditNotice("ZEC", "UST", row("7-7", "7"), row("6-7", "6-7"), dirtyText);
assert(bridged !== null && bridged.includes("ZEC 7:7 UST"), `bridge names the old row: ${bridged}`);
assert(bridged !== null && /unsaved reading text there was dropped/.test(bridged), `says the text was dropped: ${bridged}`);

// A split names the bridged row.
const split = droppedEditNotice("ZEC", "UST", row("6-7", "6-7", { verseNum: 6 }), row("6-6", "6", { verseNum: 6 }), dirtyText);
assert(split !== null && split.includes("ZEC 7:6-7 UST"), `split names the bridged row: ${split}`);

// Panel drags, and both at once.
assert(/unsaved alignment changes there were dropped/.test(droppedEditNotice("ZEC", "UST", row("7-7", "7"), row("6-7", "6-7"), dirtyDrags) ?? ""), "drags");
assert(
  /unsaved reading text and alignment changes there were dropped/.test(droppedEditNotice("ZEC", "UST", row("7-7", "7"), row("6-7", "6-7"), both) ?? ""),
  "text and drags",
);

// Nothing unsaved, nothing to say.
assert(droppedEditNotice("ZEC", "UST", row("7-7", "7"), row("6-7", "6-7"), clean) === null, "clean side is silent");
// Same row (a version-only change) is not a drop.
assert(droppedEditNotice("ZEC", "UST", row("7-7", "7"), row("7-7", "7"), dirtyText) === null, "same row is silent");
// A verse navigation changes the row too, but goes through the gate.
assert(droppedEditNotice("ZEC", "UST", row("7-7", "7"), row("8-8", "8", { verseNum: 8 }), dirtyText) === null, "verse nav is silent");
assert(droppedEditNotice("ZEC", "UST", row("7-7", "7"), row("7-7", "7", { chapter: 8 }), dirtyText) === null, "chapter change is silent");
// First render, and a side that had no row.
assert(droppedEditNotice("ZEC", "UST", undefined, row("7-7", "7"), dirtyText) === null, "first render is silent");
assert(droppedEditNotice("ZEC", "UST", row("none", null), row("7-7", "7"), dirtyText) === null, "no old row is silent");

console.log(`dualRowChange: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
