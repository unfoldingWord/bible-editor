// Unit tests for canonizeHebrew.ts — canonizing resource Hebrew to the exact
// UHB bytes. Run from api/:
//   node --experimental-strip-types --no-warnings src/canonizeHebrew.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { canonizeAlignmentSource, canonizeQuote } from "./canonizeHebrew.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// ── Building blocks ─────────────────────────────────────────────────────────
// A consonant + dagesh + hiriq. The UHB stores marks in traditional Tanakh
// order (dagesh, ccc=21, BEFORE the vowel hiriq, ccc=18); NFC reorders to
// ascending combining class (hiriq before dagesh). The two are byte-distinct
// but visually identical — exactly the drift canonize repairs.
const BET = "ב";
const DAGESH = "ּ";
const HIRIQ = "ִ";
const QAMATS = "ָ";
const WJ = "⁠"; // word joiner

const LEGACY = BET + DAGESH + HIRIQ; // UHB storage order
const NFC = BET + HIRIQ + DAGESH; // AI / NFC order

// Sanity: the two orders fold together under NFC, and NFC is the canonical form.
assert(NFC.normalize("NFC") === NFC, "precondition: NFC form is already canonical");
assert(LEGACY.normalize("NFC") === NFC, "precondition: legacy UHB order folds to the NFC form");
assert(LEGACY !== NFC, "precondition: legacy and NFC bytes genuinely differ");

const w = (text, lemma, morph) => ({ text, strong: "H1", lemma, morph });
// Milestones default to strong "H1" (matching w()); override via attrs.strong.
const zaln = (attrs, children = []) => ({ type: "milestone", tag: "zaln", strong: "H1", ...attrs, children });

// ── canonizeAlignmentSource ─────────────────────────────────────────────────

// 1. Exact tier: milestone content/lemma in NFC order → rewritten to UHB legacy
//    bytes. This is the headline behavior.
{
  const uhb = [w(LEGACY, LEGACY, "Ncmsa")];
  const vo = [zaln({ content: NFC, lemma: NFC, morph: "Ncmsa" })];
  const n = canonizeAlignmentSource(vo, uhb);
  assert(n === 1, "exact: one milestone changed");
  assert(vo[0].content === LEGACY, "exact: content rewritten to UHB legacy bytes");
  assert(vo[0].lemma === LEGACY, "exact: lemma rewritten to UHB legacy bytes");
}

// 2. No-op: milestone already byte-identical to UHB → nothing changes.
{
  const uhb = [w(LEGACY, LEGACY, "Ncmsa")];
  const vo = [zaln({ content: LEGACY, lemma: LEGACY, morph: "Ncmsa" })];
  const before = JSON.stringify(vo);
  const n = canonizeAlignmentSource(vo, uhb);
  assert(n === 0, "no-op: already-canonical milestone reports 0 changes");
  assert(JSON.stringify(vo) === before, "no-op: tree untouched");
}

// 3. Conservatism: a STRONG mismatch means NO match → left as-is. Strong's is the
//    source-identity key (aligned with milestoneSourceKey), so a milestone pointed
//    at a different Strong's number never adopts another word's bytes.
{
  const uhb = [w(LEGACY, LEGACY, "Ncmsa")]; // strong H1 (from w())
  const vo = [zaln({ content: NFC, lemma: NFC, morph: "Ncmsa", strong: "H2" })];
  const n = canonizeAlignmentSource(vo, uhb);
  assert(n === 0, "strong mismatch: no change (Strong's is the identity key)");
  assert(vo[0].content === NFC, "strong mismatch: content preserved unchanged");
}

// 3b. Regression for the gpt-5.4-mini finding: a valid milestone that carries only
//     x-strong + x-content (no x-lemma / x-morph) must still canonize. Keying on
//     lemma/morph would have skipped it; keying on strong+content does not.
{
  const uhb = [w(LEGACY, LEGACY, "Ncmsa")]; // strong H1
  const vo = [{ type: "milestone", tag: "zaln", strong: "H1", content: NFC }]; // no lemma, no morph
  const n = canonizeAlignmentSource(vo, uhb);
  assert(n === 1, "strong+content-only milestone canonized (lemma/morph absent)");
  assert(vo[0].content === LEGACY, "strong+content-only: content rewritten to UHB bytes");
  assert(!("lemma" in vo[0]), "strong+content-only: no lemma invented on a milestone that lacked one");
}

// 4. Stripped tier: milestone missing the vowel points still matches on the
//    consonant skeleton and adopts the fully-pointed UHB form.
{
  const dbrBare = "דבר"; // ד ב ר
  const dbrPointed = "ד" + QAMATS + "ב" + QAMATS + "ר"; // דָבָר
  const uhb = [w(dbrPointed, dbrPointed, "Ncmsa")];
  const vo = [zaln({ content: dbrBare, lemma: dbrPointed, morph: "Ncmsa" })];
  const n = canonizeAlignmentSource(vo, uhb);
  assert(n === 1, "stripped: bare-consonant content matched and changed");
  assert(vo[0].content === dbrPointed, "stripped: adopted the pointed UHB form");
}

// 5. Word-joiner tier: content differs by BOTH vowels and a dropped U+2060 →
//    only the loosest tier matches, and it adopts the UHB form (WJ and all).
{
  const dbrBare = "דבר";
  const dbrPointedWj = "ד" + QAMATS + "ב" + QAMATS + "ר" + WJ;
  const uhb = [w(dbrPointedWj, dbrPointedWj, "Ncmsa")];
  const vo = [zaln({ content: dbrBare, lemma: dbrPointedWj, morph: "Ncmsa" })];
  const n = canonizeAlignmentSource(vo, uhb);
  assert(n === 1, "word-joiner: bare content matched the pointed+WJ UHB word");
  assert(vo[0].content === dbrPointedWj, "word-joiner: adopted UHB form including the U+2060");
}

// Two same-skeleton source words that differ only by pointing (both fold to the
// consonant בּ). Each carries a dagesh so its legacy≠NFC byte order gives canonize
// something to rewrite.
const W1_LEGACY = BET + DAGESH + HIRIQ; // בִּ (== LEGACY)
const W1_NFC = BET + HIRIQ + DAGESH;
const W2_LEGACY = BET + DAGESH + QAMATS; // בָּ
const W2_NFC = BET + QAMATS + DAGESH;

// 6. Distinct pointing is order-INDEPENDENT: the exact tier keeps pointing, so
//    two same-skeleton words land in distinct buckets and each milestone
//    canonizes to ITS OWN UHB word even when target order is REVERSED vs source
//    order. (The old walk-order scheme would swap them — see case 6c.)
{
  const uhb = [w(W1_LEGACY, W1_LEGACY, "M"), w(W2_LEGACY, W2_LEGACY, "M")]; // source: occ1=W1, occ2=W2
  const vo = [
    zaln({ content: W2_NFC, lemma: W2_NFC, morph: "M" }), // target reordered: W2 first…
    zaln({ content: W1_NFC, lemma: W1_NFC, morph: "M" }), // …then W1
  ];
  const n = canonizeAlignmentSource(vo, uhb);
  assert(n === 2, "distinct pointing: both milestones canonized");
  assert(vo[0].content === W2_LEGACY, "reordered: W2 milestone → W2 UHB bytes (not swapped)");
  assert(vo[1].content === W1_LEGACY, "reordered: W1 milestone → W1 UHB bytes (not swapped)");
}

// 6c. AMBIGUOUS skeleton fails closed (Codex's repro). Two same-skeleton,
//     different-pointing UHB words; the milestones are BARE (pointing lost) and
//     in reversed order. We cannot tell which is which, so we write NOTHING —
//     never the wrong pointing. Before the fix, walk-order consumption assigned
//     occ 2 the pointing of occ 1 (silent x-content corruption).
{
  const uhb = [w(W1_LEGACY, W1_LEGACY, "M"), w(W2_LEGACY, W2_LEGACY, "M")];
  const bare = BET; // "ב" — strips to the shared skeleton
  const vo = [
    zaln({ content: bare, lemma: bare, morph: "M", occurrence: "2" }),
    zaln({ content: bare, lemma: bare, morph: "M", occurrence: "1" }),
  ];
  const n = canonizeAlignmentSource(vo, uhb);
  assert(n === 0, "ambiguous bare skeleton: fail closed, nothing changed");
  assert(
    vo[0].content === bare && vo[1].content === bare,
    "ambiguous: both milestones left untouched (no wrong pointing written)",
  );
}

// 6b. Discontinuous alignment: ONE UHB word (single occurrence) referenced by
//     TWO milestones (e.g. אָמַר split around "Moses" in "And Moses said"). The
//     first consumes the lone UHB entry; the SECOND must still be canonized via
//     the resolution cache — not left with its bad byte order. Regression for the
//     dropped foundForms fallback.
{
  const uhb = [w(LEGACY, LEGACY, "M")]; // ONE entry — the single source occurrence
  const vo = [
    zaln({ content: NFC, lemma: NFC, morph: "M", occurrence: "1", occurrences: "1" }),
    { type: "word", tag: "w", text: "Moses" },
    zaln({ content: NFC, lemma: NFC, morph: "M", occurrence: "1", occurrences: "1" }),
  ];
  const n = canonizeAlignmentSource(vo, uhb);
  assert(n === 2, "discontinuous: BOTH milestones for the one source word canonized");
  assert(vo[0].content === LEGACY, "discontinuous: first milestone canonized");
  assert(vo[2].content === LEGACY, "discontinuous: SECOND (repeat) milestone canonized, not left with bad bytes");
  assert(vo[1].text === "Moses", "discontinuous: the intervening target word is untouched");
}

// 7. Recursion + target words untouched: nested milestones both canonize; the
//    English `\w` target words in between are never modified.
{
  const uhb = [w(LEGACY, LEGACY, "M"), w(LEGACY, LEGACY, "M")];
  const vo = [
    zaln({ content: NFC, lemma: NFC, morph: "M" }, [
      { type: "word", tag: "w", text: "the" },
      zaln({ content: NFC, lemma: NFC, morph: "M" }, [{ type: "word", tag: "w", text: "house" }]),
    ]),
  ];
  const n = canonizeAlignmentSource(vo, uhb);
  assert(n === 2, "recursion: both the outer and nested milestone changed");
  assert(vo[0].content === LEGACY, "recursion: outer milestone canonized");
  assert(vo[0].children[1].content === LEGACY, "recursion: nested milestone canonized");
  assert(vo[0].children[0].text === "the", "recursion: target word 'the' untouched");
  assert(vo[0].children[1].children[0].text === "house", "recursion: target word 'house' untouched");
}

// 8. Empty UHB → no-op.
{
  const vo = [zaln({ content: NFC, lemma: NFC, morph: "M" })];
  assert(canonizeAlignmentSource(vo, []) === 0, "empty UHB: returns 0");
  assert(vo[0].content === NFC, "empty UHB: content untouched");
}

// ── canonizeQuote ───────────────────────────────────────────────────────────

// 9. Multi-word quote: each word canonized, the space separator preserved.
{
  const q = NFC + " " + "דבר"; // NFC-order word + bare word
  const uhb = [w(LEGACY, LEGACY, "M"), w("ד" + QAMATS + "ב" + QAMATS + "ר", "L2", "M")];
  const out = canonizeQuote(q, uhb);
  assert(
    out === LEGACY + " " + "ד" + QAMATS + "ב" + QAMATS + "ר",
    "quote: both words canonized, space preserved",
  );
}

// 10. Maqaf separator preserved.
{
  const maqaf = "־";
  const q = NFC + maqaf + NFC;
  const uhb = [w(LEGACY, LEGACY, "M"), w(LEGACY, LEGACY, "M")];
  const out = canonizeQuote(q, uhb);
  assert(out === LEGACY + maqaf + LEGACY, "quote: maqaf separator preserved between canonized words");
}

// 11. Ambiguity in quotes fails closed (#959 review). A bare skeleton that
//     matches two differently pointed UHB words is left as-is: picking the
//     first would move a quote meant for the second onto another word. Once
//     one candidate is consumed, the other is no longer ambiguous.
{
  const boA = "בֹא";
  const baA = "ב" + QAMATS + "א";
  const bare = "בא";
  const uhb = [w(boA, "L", "M"), w(baA, "L", "M")];
  assert(canonizeQuote(bare + " " + bare, uhb) === bare + " " + bare, "quote: ambiguous bare skeleton left as-is");
  assert(canonizeQuote(boA + " " + bare, uhb) === boA + " " + baA, "quote: after boA is consumed, bare resolves to baA");
}

// 11b. A word already byte-identical to a UHB word is kept, even when an
//      earlier look-alike (same NFC, other bytes) would match the exact tier.
//      translationCore counts each byte-distinct surface separately (lint.ts).
{
  const uhb = [w(LEGACY, LEGACY, "M"), w(NFC, NFC, "M")];
  assert(canonizeQuote(NFC, uhb) === NFC, "quote: byte-identical 2nd look-alike kept, not moved to the 1st");
  assert(canonizeQuote(LEGACY, uhb) === LEGACY, "quote: byte-identical 1st look-alike kept");
}

// 12. strict mode (verse ranges): only the exact tier fires; a bare word that
//     would need the stripped tier is left untouched.
{
  const dbrBare = "דבר";
  const dbrPointed = "ד" + QAMATS + "ב" + QAMATS + "ר";
  const uhb = [w(dbrPointed, dbrPointed, "M")];
  assert(
    canonizeQuote(dbrBare, uhb, { strict: true }) === dbrBare,
    "strict: stripped-tier match suppressed for verse ranges",
  );
  assert(
    canonizeQuote(dbrBare, uhb) === dbrPointed,
    "non-strict: same input DOES match via the stripped tier",
  );
}

// 13. Unmatched word left as-is; no throw on empty UHB.
{
  const q = NFC;
  assert(canonizeQuote(q, []) === q, "empty UHB: quote returned unchanged");
  assert(canonizeQuote(q, [w("שלום", "L", "M")]) === q, "no match: word left as-is");
}

// 14. Each invisible joiner in the exact-tier fold is exercised independently
//     (pins the INVISIBLE_JOINERS class members — WJ/U+2060 is already covered
//     by cases 5 & 13's absence, ZWJ and BOM are pinned here). A quote word that
//     carries the joiner still matches a clean UHB word and adopts its exact
//     bytes — only possible if canonicalHebrew() strips that codepoint.
{
  const clean = "אב"; // alef bet, no joiner
  const uhb = [w(clean, clean, "M")];
  assert(
    canonizeQuote("א‍ב", uhb) === clean,
    "ZWJ (U+200D) folded at exact tier → adopts clean UHB bytes",
  );
  assert(
    canonizeQuote("א﻿ב", uhb) === clean,
    "BOM/ZWNBSP (U+FEFF) folded at exact tier → adopts clean UHB bytes",
  );
}

// 15. GUARANTEE: what lands in the data is REAL Hebrew bytes, never a literal
//     "\uXXXX" escape sequence. Canonize a milestone (whose UHB form even carries
//     a word joiner), serialize the way applyVerseUpdate does (JSON.stringify),
//     and assert the output holds the real characters and zero backslash-u.
{
  const dbrWj = "ד" + QAMATS + "ב" + QAMATS + "ר" + WJ;
  const uhb = [w(dbrWj, dbrWj, "M")];
  // lemma matches the UHB lemma (as real data would); content is bare and gets
  // canonized up to the pointed+WJ UHB form via the word-joiner tier.
  const vo = [zaln({ content: "דבר", lemma: dbrWj, morph: "M" })];
  canonizeAlignmentSource(vo, uhb);
  const serialized = JSON.stringify(vo);
  assert(vo[0].content === dbrWj, "guarantee: adopted the real UHB form");
  assert(serialized.includes(dbrWj), "guarantee: serialized JSON holds the real Hebrew characters");
  assert(!serialized.includes("\\u"), "guarantee: serialized JSON contains NO \\uXXXX escape sequence");
}

console.log("canonizeHebrew.test.mjs: all assertions passed");
