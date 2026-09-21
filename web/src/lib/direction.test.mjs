// Tests for direction.ts — the single source of truth for RTL/LTR direction
// consolidated from 7 independent derivation sites (issue #843).
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/direction.test.mjs

import {
  directionForVersion,
  directionForBook,
  directionForText,
  isOtBookCode,
} from "./direction.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

console.log("\n[directionForVersion]");
assert(directionForVersion("UHB") === "rtl", "UHB is rtl");
assert(directionForVersion("UGNT") === "ltr", "UGNT is ltr");
assert(directionForVersion("ULT") === "ltr", "ULT is ltr");
assert(directionForVersion("UST") === "ltr", "UST is ltr");
assert(directionForVersion(null) === "ltr", "null version defaults to ltr");
assert(directionForVersion(undefined) === "ltr", "undefined version defaults to ltr");
assert(directionForVersion("") === "ltr", "empty-string version defaults to ltr");

console.log("\n[directionForBook / isOtBookCode]");
assert(directionForBook("ZEC") === "rtl", "ZEC (OT) is rtl");
assert(directionForBook("GEN") === "rtl", "GEN (OT) is rtl");
assert(directionForBook("mal") === "rtl", "lowercase OT code still matches (case-insensitive)");
assert(directionForBook("MAT") === "ltr", "MAT (NT) is ltr");
assert(directionForBook("REV") === "ltr", "REV (NT) is ltr");
assert(directionForBook(null) === "ltr", "null book code defaults to ltr — the deliberate choice for a pure direction API (unlike isHebrewBook's OT default)");
assert(directionForBook("XXX") === "ltr", "unrecognized book code defaults to ltr");
assert(isOtBookCode("ZEC") === true, "isOtBookCode true for a real OT code");
assert(isOtBookCode("MAT") === false, "isOtBookCode false for an NT code");
assert(isOtBookCode(null) === false, "isOtBookCode false for a missing code (no OT default baked in here)");

console.log("\n[directionForText]");
assert(directionForText("שָׁלוֹם") === "rtl", "Hebrew text is rtl");
assert(directionForText("λόγος") === "ltr", "Greek text is ltr (grouped with Latin)");
assert(directionForText("hello") === "ltr", "Latin text is ltr");
assert(directionForText("") === "empty", "empty string is 'empty', not folded into ltr");
assert(directionForText("   ") === "empty", "whitespace-only is 'empty'");
assert(directionForText("123") === "empty", "digits-only has no directional signal — 'empty'");
assert(directionForText(null) === "empty", "null is 'empty'");
assert(directionForText(undefined) === "empty", "undefined is 'empty'");
assert(
  directionForText("שָׁלוֹם hello") === "rtl",
  "mixed Hebrew+Latin favors rtl (Hebrew checked first, matching the pre-existing detectQuoteScript order)",
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll direction tests passed.");
