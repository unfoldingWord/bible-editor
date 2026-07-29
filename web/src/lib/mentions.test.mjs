// Smoke test for mentions.ts. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/mentions.test.mjs
//
// The load-bearing case is trailing punctuation: the server strips it before
// resolving a mention, so if this helper doesn't, "@bob." notifies Bob but
// renders unhighlighted — the highlighted set silently disagrees with the
// notified set. Keep in sync with api/src/mentions.test.mjs.

import { splitMentions } from "./mentions.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const KNOWN = ["bob", "jane.bussard", "Chris"];

// Convenience: the mention texts a body produces, in order.
const mentionsOf = (body, known = KNOWN) =>
  splitMentions(body, known)
    .filter((s) => s.isMention)
    .map((s) => s.text);

// Convenience: the full body reassembled, to prove no text is lost or dropped.
const rejoin = (body, known = KNOWN) =>
  splitMentions(body, known)
    .map((s) => s.text)
    .join("");

// --- trailing punctuation (the regression this file exists for) -------------
assert(
  JSON.stringify(mentionsOf("thanks @bob.")) === JSON.stringify(["@bob"]),
  'trailing period: "@bob." highlights @bob',
);
assert(
  rejoin("thanks @bob.") === "thanks @bob.",
  "trailing period stays in a following plain segment (nothing lost)",
);
{
  const segs = splitMentions("thanks @bob.", KNOWN);
  const last = segs[segs.length - 1];
  assert(last.isMention === false && last.text === ".", "the period is its own plain segment");
}
assert(
  JSON.stringify(mentionsOf("cc @bob, please")) === JSON.stringify(["@bob"]),
  'trailing comma: "@bob," highlights @bob',
);
assert(
  JSON.stringify(mentionsOf("(ask @bob)")) === JSON.stringify(["@bob"]),
  'trailing paren: "@bob)" highlights @bob',
);
assert(
  JSON.stringify(mentionsOf("@bob?! really")) === JSON.stringify(["@bob"]),
  'multiple trailing marks: "@bob?!" highlights @bob',
);

// --- internal punctuation must survive -------------------------------------
assert(
  JSON.stringify(mentionsOf("hi @jane.bussard here")) === JSON.stringify(["@jane.bussard"]),
  "internal dot is kept: @jane.bussard",
);
assert(
  JSON.stringify(mentionsOf("hi @jane.bussard.")) === JSON.stringify(["@jane.bussard"]),
  "internal dot kept while trailing dot stripped",
);

// --- emails must not false-positive ----------------------------------------
assert(mentionsOf("mail foo@bar.com now").length === 0, "email yields no mention");
assert(rejoin("mail foo@bar.com now") === "mail foo@bar.com now", "email text passes through intact");

// --- unknown users are not highlighted -------------------------------------
assert(mentionsOf("hello @nobody").length === 0, "unknown username is not highlighted");
assert(
  JSON.stringify(mentionsOf("@bob and @nobody")) === JSON.stringify(["@bob"]),
  "known highlighted, unknown left plain",
);

// --- casing + multiples ----------------------------------------------------
assert(
  JSON.stringify(mentionsOf("yo @CHRIS")) === JSON.stringify(["@CHRIS"]),
  "match is case-insensitive; the body's own casing is preserved in the segment",
);
assert(
  JSON.stringify(mentionsOf("@bob and @Chris")) === JSON.stringify(["@bob", "@Chris"]),
  "multiple mentions in order",
);

// --- edges -----------------------------------------------------------------
assert(splitMentions("", KNOWN).length === 0, "empty body yields no segments");
assert(mentionsOf("no mentions here").length === 0, "plain body yields no mentions");
assert(rejoin("no mentions here") === "no mentions here", "plain body passes through intact");
assert(mentionsOf("@bob", []).length === 0, "empty known-list highlights nothing");

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("All mentions smoke checks passed.");
