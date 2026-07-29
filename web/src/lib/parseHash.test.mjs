// Smoke test for parseHash.ts. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/parseHash.test.mjs

import { parseHashString } from "./parseHash.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const DEFAULT_BOOK = "OBA";

// --- plain book/chapter ---
{
  const loc = parseHashString("#/ZEC/5", DEFAULT_BOOK);
  assert(loc.book === "ZEC", "plain: book parsed");
  assert(loc.chapter === 5, "plain: chapter parsed");
  assert(loc.verse === 1, "plain: verse defaults to 1");
  assert(loc.commentId === undefined, "plain: no commentId");
}

// --- book/chapter/verse ---
{
  const loc = parseHashString("#/ZEC/5/3", DEFAULT_BOOK);
  assert(loc.book === "ZEC" && loc.chapter === 5 && loc.verse === 3, "book/chapter/verse parsed");
  assert(loc.commentId === undefined, "no commentId when absent");
}

// --- book/chapter/verse?c=12 (backward-compat: normal parse unaffected) ---
{
  const loc = parseHashString("#/ZEC/5/3?c=12", DEFAULT_BOOK);
  assert(loc.book === "ZEC" && loc.chapter === 5 && loc.verse === 3, "book/chapter/verse still correct with ?c=");
  assert(loc.commentId === 12, "commentId extracted as number");
}

// --- ?c= with garbage value ---
{
  const loc = parseHashString("#/ZEC/5/3?c=abc", DEFAULT_BOOK);
  assert(loc.commentId === undefined, "non-numeric c= ignored, not thrown");
}

// --- empty hash defaults ---
{
  const loc = parseHashString("", DEFAULT_BOOK);
  assert(loc.book === DEFAULT_BOOK && loc.chapter === 1 && loc.verse === 1, "empty hash falls back to defaults");
  assert(loc.commentId === undefined, "empty hash has no commentId");
}

// --- lowercase book uppercased ---
{
  const loc = parseHashString("#/zec/5", DEFAULT_BOOK);
  assert(loc.book === "ZEC", "lowercase book is uppercased");
}

// --- chapter with ?c= but no verse segment ---
{
  const loc = parseHashString("#/ZEC/5?c=7", DEFAULT_BOOK);
  assert(loc.book === "ZEC" && loc.chapter === 5, "chapter-only + ?c= parses book/chapter");
  assert(loc.verse === 1, "chapter-only + ?c= defaults verse to 1");
  assert(loc.commentId === 7, "chapter-only + ?c= extracts commentId");
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll parseHash smoke checks passed.");
