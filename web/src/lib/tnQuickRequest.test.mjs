// buildTnQuickRequest on a bridged ULT/UST row (issue #968). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/tnQuickRequest.test.mjs
//
// A note's occurrence counts within its own verse, but a bridge numbered
// ACROSS its span stamps the verse-2 copy of a repeated Hebrew word as 2/2.
// The English sent to the AI must be the English aligned to the note's own
// verse's copy.

import usfm from "usfm-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTnQuickRequest } from "./tnQuickRequest.ts";
import { nfc } from "./hebrew.ts";

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

// --- English input on a bridge with x-ref (#1426) ---------------------------
// Real Door43 data: 2CH UST 9:10-12 is one bridged row whose milestones count
// per source verse and name it in x-ref (אֶת 1/1 x-ref 9:11 twice, אֶת 1/1
// x-ref 9:12); the ULT keeps 9:10, 9:11 and 9:12 separate. An English quote
// typed on 9:12 must send only 9:12's UST English to the AI.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const samples = resolve(here, "../../../docs/samples");
  const read = (f) => readFileSync(resolve(samples, f), "utf8");
  const plainOfVo = (vo) => {
    const out = [];
    const walk = (ns) => { for (const n of ns ?? []) { if (n?.type === "word") out.push(n.text); else if (n?.children) walk(n.children); } };
    walk(vo);
    return out.join(" ");
  };
  const row2ch = (verse, verseEnd, verseObjects, bv) => ({
    book: "2CH", chapter: 9, verse, verse_end: verseEnd, bible_version: bv,
    plain_text: plainOfVo(verseObjects), version: 1, updated_by: null, updated_at: 0, content: { verseObjects },
  });
  const uhbJson = usfm.toJSON(read("hbo_uhb_14-2CH-9_10-12.usfm"));
  const ultJson = usfm.toJSON(read("en_ult_14-2CH-9_10-12.usfm"));
  const UHB = {};
  const ULT = {};
  for (const v of [10, 11, 12]) {
    UHB[v] = row2ch(v, null, uhbJson.chapters["9"][String(v)].verseObjects, "UHB");
    ULT[v] = row2ch(v, null, ultJson.chapters["9"][String(v)].verseObjects, "ULT");
  }
  const ustBridge = (raw) => row2ch(10, 12, usfm.toJSON(raw).chapters["9"]["10-12"].verseObjects, "UST");
  const ustRaw = read("en_ust_14-2CH-9_10-12.usfm");
  const note2ch = (verse, quote) => ({
    id: "t1", book: "2CH", chapter: 9, verse, ref_raw: `9:${verse}`,
    support_reference: "rc://*/ta/man/translate/figs-explicit", quote, occurrence: 1,
  });

  console.log("\n[Case] English input on 9:12: UST selection is 9:12's English only (#1426)");
  {
    const data = { verses: { ULT, UST: { 10: ustBridge(ustRaw) }, UHB } };
    const r = buildTnQuickRequest(note2ch(12, "all"), data);
    assert(
      r.ok && r.request.ust.selection === "many things in Jerusalem",
      `UST selection leaves out 9:11's "that wood … it" (got ${r.ok ? JSON.stringify(r.request.ust.selection) : r.error.reason})`,
    );
  }

  console.log("\n[Case] English input on a bridged ULT with x-ref finds the note's own verse's Hebrew (#1426)");
  {
    // The UST bridge stands in for a bridged ULT. "King Solomon" occurs in
    // 9:12 first (document order), then 9:10 and 9:11; a 9:11 note must
    // derive 9:11's הַמֶּלֶךְ, not 9:12's וְהַמֶּלֶךְ שְׁלֹמֹה.
    const data = { verses: { ULT: { 10: { ...ustBridge(ustRaw), bible_version: "ULT" } }, UST: { 10: ustBridge(ustRaw) }, UHB } };
    const r = buildTnQuickRequest(note2ch(11, "King Solomon"), data);
    assert(
      r.ok && nfc(r.request.hebrewGuess) === nfc("הַ֠⁠מֶּלֶךְ"),
      `hebrewGuess is 9:11's הַמֶּלֶךְ (got ${r.ok ? JSON.stringify(r.request.hebrewGuess) : r.error.reason})`,
    );
    assert(
      r.ok && r.request.ust.selection === "King Solomon He",
      `UST selection is 9:11's English (got ${r.ok ? JSON.stringify(r.request.ust.selection) : r.error.reason})`,
    );
  }

  console.log("\n[Case] a note spanning the bridge keeps the unscoped English lookup (#1426)");
  {
    // ref 9:10-12 may quote any of the three verses, so 9:12's English must
    // still be found for a note stored on 9:10.
    const data = { verses: { ULT: { 10: { ...ustBridge(ustRaw), bible_version: "ULT" } }, UST: { 10: ustBridge(ustRaw) }, UHB } };
    const r = buildTnQuickRequest({ ...note2ch(10, "many things in Jerusalem"), ref_raw: "9:10-12" }, data);
    assert(
      r.ok && nfc(r.request.hebrewGuess).includes(nfc("כָּל")),
      `range note: 9:12's English still derives its Hebrew (got ${r.ok ? JSON.stringify(r.request.hebrewGuess) : r.error.reason})`,
    );
  }

  console.log("\n[Case] English input on a bridge WITHOUT x-ref is unchanged (#1426)");
  {
    const data = { verses: { ULT, UST: { 10: ustBridge(ustRaw.replace(/ x-ref="[^"]*"/g, "")) }, UHB } };
    const r = buildTnQuickRequest(note2ch(12, "all"), data);
    assert(
      r.ok && r.request.ust.selection === "many things in Jerusalem that wood it",
      `no x-ref: whole-bridge match as before (got ${r.ok ? JSON.stringify(r.request.ust.selection) : r.error.reason})`,
    );
  }
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall tnQuickRequest tests passed");
