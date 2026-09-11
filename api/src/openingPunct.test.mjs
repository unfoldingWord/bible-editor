// Unit tests for hasOpeningPunctInsideMilestone (api/src/openingPunct.ts).
// Run from api/:
//   node --experimental-strip-types --no-warnings src/openingPunct.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { hasOpeningPunctInsideMilestone } from "./openingPunct.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const w = (text) => ({ text, tag: "w", type: "word", occurrence: "1", occurrences: "1" });
const t = (text) => ({ type: "text", text });
const zaln = (children) => ({ tag: "zaln", type: "milestone", content: "x", children, endTag: "zaln-e\\*" });

console.log("[hasOpeningPunctInsideMilestone]");

assert(
  hasOpeningPunctInsideMilestone([zaln([w("himself"), t(", ‘")]), zaln([w("You")])]) === true,
  "flags a milestone whose trailing text (after its last \\w) contains an opening quote",
);

assert(
  hasOpeningPunctInsideMilestone([zaln([w("Judah"), t(", ")]), zaln([w("Er")])]) === false,
  "does not flag trailing closing punctuation without an opener",
);

assert(
  hasOpeningPunctInsideMilestone([zaln([w("say")]), t(", "), zaln([t("‘"), w("The")])]) === false,
  "does not flag an opener already stored as the leading child of the FOLLOWING milestone",
);

assert(
  hasOpeningPunctInsideMilestone([zaln([zaln([w("say"), t(", ‘")])])]) === true,
  "flags a nested milestone chain — the opener trails the outer chain's last word",
);

assert(
  hasOpeningPunctInsideMilestone([zaln([])]) === false,
  "a milestone with no word leaf at all is not flagged",
);

assert(hasOpeningPunctInsideMilestone([]) === false, "an empty verse is not flagged");
assert(hasOpeningPunctInsideMilestone([t("plain text only")]) === false, "a verse with no milestones is not flagged");

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll openingPunct (api) tests passed.");
