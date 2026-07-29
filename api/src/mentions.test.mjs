// Unit tests for mentions.ts — @mention extraction and resolution.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/mentions.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { extractMentionTokens, resolveMentions } from "./mentions.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${msg} (expected ${e}, got ${a})`);
}

// --- extractMentionTokens ---
assertEqual(extractMentionTokens("hey @jane check this"), ["jane"], "plain mention extracted");
assertEqual(extractMentionTokens("no mentions here"), [], "empty body yields no tokens");
assertEqual(extractMentionTokens(""), [], "empty string yields no tokens");
assertEqual(
  extractMentionTokens("contact me at foo@bar.com please"),
  [],
  "email address is not parsed as a mention",
);
assertEqual(extractMentionTokens("cc @bob."), ["bob"], "trailing period stripped");
assertEqual(extractMentionTokens("cc @bob,"), ["bob"], "trailing comma stripped");
assertEqual(
  extractMentionTokens("ping @jane.bussard about this"),
  ["jane.bussard"],
  "internal dot kept (not trailing punctuation)",
);
assertEqual(
  extractMentionTokens("@alice and @bob should look, cc @alice"),
  ["alice", "bob", "alice"],
  "multiple mentions in appearance order (dedup happens in resolveMentions)",
);

// --- resolveMentions ---
const knownUsernames = ["Jane.Bussard", "Bob-Smith", "alice_w", "Chris99"];

assertEqual(
  resolveMentions("hey @jane.bussard", knownUsernames),
  ["Jane.Bussard"],
  "case-insensitive match returns canonical casing",
);
assertEqual(
  resolveMentions("@ALICE_W @alice_w @Alice_W", knownUsernames),
  ["alice_w"],
  "dedup across repeated case variants",
);
assertEqual(
  resolveMentions("@jane.bussard @bob-smith", knownUsernames, "Jane.Bussard"),
  ["Bob-Smith"],
  "self excluded case-insensitively",
);
assertEqual(
  resolveMentions("@nobody-known here", knownUsernames),
  [],
  "unknown username dropped",
);
assertEqual(
  resolveMentions("contact foo@bar.com, cc @chris99", knownUsernames),
  ["Chris99"],
  "email false-positive excluded, real mention still resolved",
);
assertEqual(
  resolveMentions("cc @bob-smith. thanks", knownUsernames),
  ["Bob-Smith"],
  "trailing punctuation stripped before resolution",
);
assertEqual(
  resolveMentions("@jane.bussard and @bob-smith and @jane.bussard again", knownUsernames),
  ["Jane.Bussard", "Bob-Smith"],
  "multiple distinct mentions, first-appearance order preserved",
);
assertEqual(resolveMentions("", knownUsernames), [], "empty body resolves to no mentions");

console.log("mentions.test.mjs: all assertions passed");
