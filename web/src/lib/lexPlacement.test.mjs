// Tests for lexPlacement.ts (#1055). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/lexPlacement.test.mjs

import { chooseLexPlacement, lexAnchorRect } from "./lexPlacement.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}
const r = (top, bottom, left, right) => ({ top, bottom, left, right });

// Rows mode: a two-line UHB block mid-screen → below the block.
assert(chooseLexPlacement(r(600, 690, 180, 820), 1400, 900) === "bottom", "room below → bottom");
// Block near the bottom of the screen → above it.
assert(chooseLexPlacement(r(760, 850, 180, 820), 1400, 900) === "top", "no room below → top");
// Columns mode: the UHB column fills the height; more room on the left.
assert(chooseLexPlacement(r(110, 890, 760, 1050), 1400, 900) === "left", "tall column → left side");
assert(chooseLexPlacement(r(110, 890, 150, 440), 1400, 900) === "right", "tall column at left → right side");
// Tall and wide: no side fits → whichever of above/below is bigger.
assert(chooseLexPlacement(r(150, 880, 50, 1350), 1400, 900) === "top", "nothing fits → larger of above/below");

// Anchor: vertical placements span the block and sit on the word's center x.
const a = lexAnchorRect("bottom", r(600, 690, 180, 820), r(610, 640, 400, 440));
assert(a.top === 600 && a.bottom === 690 && a.left === 420 && a.right === 420, "bottom anchor = block edges, word x");
const s = lexAnchorRect("left", r(110, 890, 760, 1050), r(300, 330, 900, 950));
assert(s.left === 760 && s.right === 1050 && s.top === 315 && s.bottom === 315, "side anchor = block edges, word y");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nlexPlacement.test.mjs: all assertions passed");
