// Unit tests for the TWL PATCH ref_raw guard (twlRefGuard.ts, issue #724).
// Run: node --experimental-strip-types --no-warnings src/twlRefGuard.test.mjs

import assert from "node:assert/strict";
import { isValidTwlRefRaw } from "./twlRefGuard.ts";

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

t("a valid same-chapter single-verse ref is accepted", () => {
  assert.equal(isValidTwlRefRaw("3:5", 3), true);
});
t("a spanning range is rejected", () => {
  assert.equal(isValidTwlRefRaw("3:5-6", 3), false);
});
t("an empty string is rejected", () => {
  assert.equal(isValidTwlRefRaw("", 3), false);
});
t("front:intro is rejected (twl has no legal chapter-0 shape)", () => {
  assert.equal(isValidTwlRefRaw("front:intro", 0), false);
});
t("an intro reference is rejected", () => {
  assert.equal(isValidTwlRefRaw("3:intro", 3), false);
});
t("a cross-chapter reference is rejected", () => {
  assert.equal(isValidTwlRefRaw("4:5", 3), false);
});
t("chapter 0 is rejected even with a matching current chapter", () => {
  assert.equal(isValidTwlRefRaw("0:5", 0), false);
});
t("verse 0 is rejected", () => {
  assert.equal(isValidTwlRefRaw("3:0", 3), false);
});
t("comma-separated multi-verse lists are rejected", () => {
  assert.equal(isValidTwlRefRaw("3:5,6", 3), false);
});
t("non-numeric garbage is rejected", () => {
  assert.equal(isValidTwlRefRaw("abc", 3), false);
  assert.equal(isValidTwlRefRaw("3:5a", 3), false);
});

console.log(`${passed} passed`);
