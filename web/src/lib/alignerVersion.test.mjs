// versionNeedingAlignment: the Alignment tab lands on the one version
// (ULT/UST) that has unaligned words, and declines to choose otherwise.
// Run from web/: node --experimental-strip-types --no-warnings src/lib/alignerVersion.test.mjs

import { versionNeedingAlignment } from "./alignerVersion.ts";

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

const word = (text) => ({ type: "word", tag: "w", text, occurrence: "1", occurrences: "1" });
const aligned = (text) => ({
  type: "milestone",
  tag: "zaln",
  strong: "H1",
  lemma: "x",
  morph: "He,N",
  occurrence: "1",
  occurrences: "1",
  content: "x",
  children: [word(text)],
  endTag: "zaln-e\\*",
});
// Fresh arrays per call: verseHasUnalignedWork caches by array identity.
const row = (verse, verseObjects) => ({ verse, verse_end: null, content: { verseObjects } });
const done = (v) => row(v, [aligned("Hello")]);
const todo = (v) => row(v, [aligned("Hello"), word("again")]);

console.log("[versionNeedingAlignment]");
assert(versionNeedingAlignment({ ULT: { 3: done(3) }, UST: { 3: todo(3) } }, 3) === "UST", "only UST unaligned -> UST");
assert(versionNeedingAlignment({ ULT: { 3: todo(3) }, UST: { 3: done(3) } }, 3) === "ULT", "only ULT unaligned -> ULT");
assert(versionNeedingAlignment({ ULT: { 3: todo(3) }, UST: { 3: todo(3) } }, 3) === null, "both unaligned -> null");
assert(versionNeedingAlignment({ ULT: { 3: done(3) }, UST: { 3: done(3) } }, 3) === null, "neither unaligned -> null");
assert(versionNeedingAlignment({ ULT: { 3: done(3) } }, 3) === null, "UST row absent -> not a reason to switch");
assert(versionNeedingAlignment({ ULT: { 3: done(3) }, UST: { 3: todo(3) } }, 0) === null, "intro verse 0 -> null");
assert(versionNeedingAlignment(undefined, 3) === null, "no data -> null");
assert(
  versionNeedingAlignment({ ULT: { 3: done(3) }, UST: { 3: { ...todo(3), verse_end: 5 } } }, 4) === "UST",
  "verse inside a UST bridge resolves to the covering row",
);

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
