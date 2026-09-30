// buildTnQuickRequest on a bridged ULT/UST row (issue #968). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/tnQuickRequest.test.mjs
//
// A note's occurrence counts within its own verse, but a bridge numbered
// ACROSS its span stamps the verse-2 copy of a repeated Hebrew word as 2/2.
// The English sent to the AI must be the English aligned to the note's own
// verse's copy.

import usfm from "usfm-js";
import { buildTnQuickRequest } from "./tnQuickRequest.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const vo = (raw) => {
  const json = usfm.toJSON(raw);
  const ch = Object.keys(json.chapters)[0];
  return Object.fromEntries(
    Object.entries(json.chapters[ch]).filter(([k]) => /^\d/.test(k)).map(([k, v]) => [k, v.verseObjects]),
  );
};
const mk = (verse, verseEnd, verseObjects, bv, plain) => ({
  book: "ZEC", chapter: 1, verse, verse_end: verseEnd, bible_version: bv,
  plain_text: plain, version: 1, updated_by: null, updated_at: 0, content: { verseObjects },
});

const YHWH = "יְהוָה";
const src = vo(String.raw`\id ZEC
\c 1
\v 1 \w יְהוָה|lemma="יְהוָה" strong="H3068" x-morph="He,Np"\w*
\v 2 \w יְהוָה|lemma="יְהוָה" strong="H3068" x-morph="He,Np"\w*
`);
const uhb = { 1: mk(1, null, src["1"], "UHB", ""), 2: mk(2, null, src["2"], "UHB", "") };
const Z = (occ, occs, gloss) =>
  String.raw`\zaln-s |x-strong="H3068" x-lemma="יְהוָה" x-morph="He,Np" x-occurrence="${occ}" x-occurrences="${occs}" x-content="יְהוָה"\*\w ${gloss}|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*`;
const bridgeRow = (bv, body, plain) => {
  const parsed = vo(`\\id ZEC\n\\c 1\n\\v 1-2 ${body}\n`);
  return mk(1, 2, parsed["1-2"] ?? parsed["1"], bv, plain);
};
const note = (verse, occurrence = 1) => ({
  id: "t1", book: "ZEC", chapter: 1, verse, ref_raw: `1:${verse}`,
  support_reference: "rc://*/ta/man/translate/figs-explicit", quote: YHWH, occurrence,
});

console.log("\n[Case] across-span bridge: TN on verse 2 gets verse 2's English (#968)");
{
  const data = {
    verses: {
      ULT: { 1: bridgeRow("ULT", `${Z(1, 2, "Yahweh")} spoke; ${Z(2, 2, "LORD")}`, "Yahweh spoke; LORD") },
      UST: { 1: bridgeRow("UST", `${Z(1, 2, "He")} said; ${Z(2, 2, "God")}`, "He said; God") },
      UHB: uhb,
    },
  };
  const v2 = buildTnQuickRequest(note(2), data);
  assert(v2.ok && v2.request.ult.selection === "LORD", `ULT selection is LORD (got ${v2.ok ? v2.request.ult.selection : v2.error.reason})`);
  assert(v2.ok && v2.request.ust.selection === "God", `UST selection is God (got ${v2.ok ? v2.request.ust.selection : v2.error.reason})`);
  const v1 = buildTnQuickRequest(note(1), data);
  assert(v1.ok && v1.request.ult.selection === "Yahweh", `TN on verse 1 gets Yahweh (got ${v1.ok ? v1.request.ult.selection : v1.error.reason})`);
}

console.log("\n[Case] per-verse-numbered bridge keeps main's result (#968)");
{
  // 1/1 in each verse: which milestone is verse 2's is unknowable from the
  // numbering, so the lookup stays as on main (both copies).
  const data = {
    verses: {
      ULT: { 1: bridgeRow("ULT", `${Z(1, 1, "Yahweh")} spoke; ${Z(1, 1, "LORD")}`, "Yahweh spoke; LORD") },
      UST: { 1: bridgeRow("UST", `${Z(1, 1, "He")} said; ${Z(1, 1, "God")}`, "He said; God") },
      UHB: uhb,
    },
  };
  const v2 = buildTnQuickRequest(note(2), data);
  assert(v2.ok && v2.request.ult.selection === "Yahweh LORD", `unchanged: both copies (got ${v2.ok ? v2.request.ult.selection : v2.error.reason})`);
}

console.log("\n[Case] single verse unchanged (#968)");
{
  const parsed = vo(`\\id ZEC\n\\c 1\n\\v 2 ${Z(1, 1, "LORD")} spoke\n`);
  const data = {
    verses: {
      ULT: { 2: mk(2, null, parsed["2"], "ULT", "LORD spoke") },
      UST: { 2: mk(2, null, parsed["2"], "UST", "LORD spoke") },
      UHB: uhb,
    },
  };
  const v2 = buildTnQuickRequest(note(2), data);
  assert(v2.ok && v2.request.ult.selection === "LORD", `single verse: LORD (got ${v2.ok ? v2.request.ult.selection : v2.error.reason})`);
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall tnQuickRequest tests passed");
