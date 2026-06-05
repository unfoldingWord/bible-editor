// Smoke test for morph.ts against real x-morph codes from UHB (Hebrew) and
// UGNT (Greek). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/morph.test.mjs
// Not a test framework; failures exit non-zero. Mirrors alignment.test.mjs.

import { decodeMorph, morphemeText } from "./morph.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
  else console.log(`  ok: ${msg}`);
}

// The motivating case: ZEC 5:6 עֵינָם "their eye" — noun + attached pronoun.
{
  const d = decodeMorph("He,Ncbsc:Sp3mp");
  assert(d?.lang === "He", "ZEC 5:6 lang He");
  assert(d.morphemes.length === 2, "ZEC 5:6 has 2 morphemes (noun + suffix)");
  assert(morphemeText(d.morphemes[0]) === "noun · both genders · singular · construct",
    `ZEC 5:6 main = noun construct (got "${morphemeText(d.morphemes[0])}")`);
  assert(d.pronounSuffix?.gloss === "their", `ZEC 5:6 suffix gloss "their" (got "${d.pronounSuffix?.gloss}")`);
  assert(d.pronounSuffix?.parse === "3rd person masculine plural",
    `ZEC 5:6 suffix parse (got "${d.pronounSuffix?.parse}")`);
}

// Possessive vs object: same suffix on a verb glosses as object "them".
{
  const noun = decodeMorph("He,Ncmsc:Sp3mp");
  assert(noun.pronounSuffix.gloss === "their", "noun host → possessive 'their'");
  const verb = decodeMorph("He,Vqp3ms:Sp3mp");
  assert(verb.pronounSuffix.gloss === "them", `verb host → object 'them' (got "${verb.pronounSuffix.gloss}")`);
}

// Other pronoun persons/genders/numbers.
{
  assert(decodeMorph("He,Ncbsc:Sp3ms").pronounSuffix.gloss === "his", "Sp3ms → his");
  assert(decodeMorph("He,Ncbsc:Sp1cs").pronounSuffix.gloss === "my", "Sp1cs → my");
  assert(decodeMorph("He,Ncmpc:Sp2ms").pronounSuffix.gloss === "your", "Sp2ms → your");
  assert(decodeMorph("He,Ncfpc:Sp3fs").pronounSuffix.gloss === "her", "Sp3fs → her");
}

// Multi-prefix word: conjunction + preposition + noun + suffix (ZEC-style).
{
  const d = decodeMorph("He,C:R:Ncmsc:Sp3ms");
  assert(d.morphemes.map((m) => m.kind).join(",") === "prefix,prefix,main,suffix",
    `kinds = prefix,prefix,main,suffix (got "${d.morphemes.map((m) => m.kind).join(",")}")`);
  assert(d.morphemes[0].pos === "conjunction" && d.morphemes[1].pos === "preposition",
    "prefixes are conjunction + preposition");
  assert(d.pronounSuffix.gloss === "his", "multi-prefix suffix → his");
}

// Hebrew verb (no suffix): wayyiqtol qal.
{
  const d = decodeMorph("He,C:Vqw3ms");
  assert(d.pronounSuffix === null, "verb has no pronoun suffix");
  assert(morphemeText(d.morphemes[1]) === "verb · qal · sequential imperfect · 3rd person · masculine · singular",
    `qal wayyiqtol parse (got "${morphemeText(d.morphemes[1])}")`);
}

// Greek noun: nominative masculine singular.
{
  const d = decodeMorph("Gr,N,,,,,NMS,");
  assert(d.lang === "Gr" && d.morphemes.length === 1, "Greek single morpheme");
  assert(morphemeText(d.morphemes[0]) === "noun · nominative · masculine · singular",
    `Greek NMS (got "${morphemeText(d.morphemes[0])}")`);
}

// Greek verb: indicative aorist active 1st plural.
{
  const d = decodeMorph("Gr,V,IAA1,,P,");
  assert(morphemeText(d.morphemes[0]) === "verb · indicative · aorist · active · 1st person · plural",
    `Greek verb IAA1 P (got "${morphemeText(d.morphemes[0])}")`);
}

// Greek adjective with posType, and personal pronoun.
{
  assert(morphemeText(decodeMorph("Gr,AA,,,,AFP,").morphemes[0]) === "adjective · ascriptive · accusative · feminine · plural",
    `Greek AA AFP (got "${morphemeText(decodeMorph("Gr,AA,,,,AFP,").morphemes[0])}")`);
  assert(morphemeText(decodeMorph("Gr,RP,,,1A,P,").morphemes[0]) === "pronoun · personal · 1st person · accusative · plural",
    `Greek RP (got "${morphemeText(decodeMorph("Gr,RP,,,1A,P,").morphemes[0])}")`);
}

// Robustness: empty / unknown input.
{
  assert(decodeMorph("") === null, "empty → null");
  assert(decodeMorph(undefined) === null, "undefined → null");
  assert(decodeMorph("Xx,foo") === null, "unknown lang → null");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll morph.ts assertions passed.");
