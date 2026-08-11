// Unit tests for the raw-TAB write guard (rawTabGuard.ts).
// Run: node --experimental-strip-types --no-warnings src/rawTabGuard.test.mjs

import assert from "node:assert/strict";
import { findRawTabField } from "./rawTabGuard.ts";

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

t("clean object -> null", () => {
  assert.equal(findRawTabField({ note: "a clean note", tags: null, occurrence: 1 }), null);
});
t("TAB in note is caught", () => {
  assert.equal(findRawTabField({ note: "front:intro\tl9fr\t\t\t\t0\t# Introduction" }), "note");
});
t("TAB in a different field is caught by name", () => {
  assert.equal(findRawTabField({ note: "fine", question: "a\tb" }), "question");
});
t("non-string fields are ignored", () => {
  assert.equal(findRawTabField({ occurrence: 1, verse: 0, tags: null }), null);
});
t("empty object -> null", () => {
  assert.equal(findRawTabField({}), null);
});

console.log(`${passed} passed`);
