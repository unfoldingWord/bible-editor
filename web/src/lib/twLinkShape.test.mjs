// isMalformedTwLink: the Words link picker refuses typed text Door43 would
// reject (issue #1316), and the regex stays identical to the server's copy.
// Run from web/: node --experimental-strip-types --no-warnings src/lib/twLinkShape.test.mjs

import { readFileSync } from "node:fs";
import { isMalformedTwLink, TW_LINK_RE } from "./twLinkShape.ts";

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

assert(isMalformedTwLink("trouble"), "a bare word is malformed");
assert(isMalformedTwLink("rc://*/tw/dict"), "too few path segments is malformed");
assert(isMalformedTwLink(" rc://*/tw/dict/bible/other/trouble"), "a leading space is malformed (Door43 does not strip)");
assert(!isMalformedTwLink("rc://*/tw/dict/bible/other/trouble"), "a full rc:// link is fine");
assert(!isMalformedTwLink("rc://en/tw/dict/bible/names/abraham"), "a language-pinned link is fine");
assert(!isMalformedTwLink(""), "blank is not malformed (lint flags it as empty instead)");
assert(!isMalformedTwLink(null), "null is not malformed");

// The server copy lives in api/src/twLinkShape.ts. If they drift, the picker
// accepts a link the API then refuses (or refuses one the API would take).
const apiSrc = readFileSync(new URL("../../../api/src/twLinkShape.ts", import.meta.url), "utf8");
assert(
  apiSrc.includes(`export const TW_LINK_RE = ${TW_LINK_RE.toString()};`),
  "web TW_LINK_RE is identical to api/src/twLinkShape.ts",
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll twLinkShape assertions passed.");
