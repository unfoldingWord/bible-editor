// isMalformedTwLink: the Words link picker refuses typed text Door43 would
// reject (issue #1316), and the regex stays identical to the server's copy.
// Run from web/: node --experimental-strip-types --no-warnings src/lib/twLinkShape.test.mjs

import { readFileSync } from "node:fs";
import * as twLinkShape from "./twLinkShape.ts";

const { isMalformedTwLink, STRAIGHT_QUOTE_RE, TW_LINK_RE } = twLinkShape;

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
assert(isMalformedTwLink("   "), "whitespace-only is malformed (Door43 treats only \"\" as blank)");
assert(isMalformedTwLink("rc://*/tw/dict/bible/kt/god\n"), "a trailing newline is malformed (export writes a literal \\n)");
assert(isMalformedTwLink("rc://*/tw/dict/bible/kt/go\td"), "a tab is malformed");
// Issue #1327: Door43's _flag_straight_quotes is an error-severity check, and
// TW_LINK_RE alone accepts a straight quote.
assert(isMalformedTwLink("rc://*/tw/dict/bible/names/o'neil"), "a straight single quote is malformed");
assert(isMalformedTwLink('rc://*/tw/dict/bible/kt/"god"'), "a straight double quote is malformed");
assert(!isMalformedTwLink("rc://*/tw/dict/bible/names/o’neil"), "a curly apostrophe is fine (not a straight quote)");
assert(!isMalformedTwLink(""), "blank is not malformed (lint flags it as empty instead)");
assert(!isMalformedTwLink(null), "null is not malformed");

// Issue #1334: a full link whose only fault is a straight quote, a line break
// or tab, or blank space gets a sentence naming that fault; the picker shows
// it instead of "Not a link." Read off the namespace so a missing export fails
// these assertions rather than the import.
const problem = (link) =>
  typeof twLinkShape.twLinkCharacterProblem === "function" ? twLinkShape.twLinkCharacterProblem(link) : undefined;
assert(/straight quote \('\)/.test(problem("rc://*/tw/dict/bible/names/o'neil") ?? ""), "a straight ' in a full link is named");
assert(/straight quote \("\)/.test(problem('rc://*/tw/dict/bible/kt/"god"') ?? ""), 'a straight " in a full link is named');
assert(/line break or tab/.test(problem("rc://*/tw/dict/bible/kt/god\n") ?? ""), "a newline in a full link is named");
assert(/line break or tab/.test(problem("rc://*/tw/dict/bible/kt/go\td") ?? ""), "a tab in a full link is named");
assert(/only blank space/.test(problem("   ") ?? ""), "whitespace-only is named");
// Review of #1334: no article slug has a quote, so a curly quote is the wrong
// advice for a link; say to remove it or pick the article.
for (const link of ["rc://*/tw/dict/bible/names/o'neil", 'rc://*/tw/dict/bible/kt/"god"']) {
  assert(/pick the article from the list/.test(problem(link) ?? ""), `quote advice is 'pick the article' for ${link}`);
  assert(!/curly/.test(problem(link) ?? "curly"), `no curly-quote advice for ${link}`);
}
assert(problem("' ") === null, "a quote and a space is a shape problem, not 'only blank space'");
assert(problem("trouble") === null,"a bare word is a shape problem, not a character one (null)");
assert(problem("o'neil") === null, "a bare word with a quote is still a shape problem (null)");
assert(problem("rc://*/tw/dict/bible/kt/god") === null, "a good link has no problem (null)");
assert(problem("") === null && problem(null) === null, "blank has no problem (null)");

// The server copy lives in api/src/twLinkShape.ts. If they drift, the picker
// accepts a link the API then refuses (or refuses one the API would take).
const apiSrc = readFileSync(new URL("../../../api/src/twLinkShape.ts", import.meta.url), "utf8");
assert(
  apiSrc.includes(`export const TW_LINK_RE = ${TW_LINK_RE.toString()};`),
  "web TW_LINK_RE is identical to api/src/twLinkShape.ts",
);
assert(
  apiSrc.includes(`const STRAIGHT_QUOTE_RE = ${String(STRAIGHT_QUOTE_RE)};`),
  "web STRAIGHT_QUOTE_RE is identical to api/src/twLinkShape.ts",
);
// The api copy has no imports, so strip-types loads it directly. Same input,
// same sentence: the picker and the 400 must name the same fault.
const api = await import("../../../api/src/twLinkShape.ts");
for (const link of ["rc://*/tw/dict/bible/names/o'neil", 'rc://*/tw/dict/bible/kt/"god"', "rc://*/tw/dict/bible/kt/god\n", "rc://*/tw/dict/bible/kt/o'n\teil", "   ", "trouble", "o'neil", "rc://*/tw/dict/bible/kt/god", "", null]) {
  assert(
    typeof api.twLinkCharacterProblem === "function" && api.twLinkCharacterProblem(link) === problem(link),
    `web twLinkCharacterProblem matches api for ${JSON.stringify(link)}`,
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll twLinkShape assertions passed.");
