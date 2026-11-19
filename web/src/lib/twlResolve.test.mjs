// Tests for resolveSpanToSource (web/src/lib/twlResolve.ts) — the English-span ->
// {orig_words, occurrence, confident} resolver behind TWL suggestions. Covers the
// edge cases that make it the hard part: occurrence selection, multi-word source
// union, unaligned words, and unmatched spans.

import assert from "node:assert/strict";
import { resolveSpanToSource } from "./twlResolve.ts";
import { nfc } from "./hebrew.ts";
import usfm from "usfm-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

const w = (text, occurrence, occurrences = occurrence, extra = {}) => ({
  type: "word",
  tag: "w",
  text,
  occurrence: String(occurrence),
  occurrences: String(occurrences),
  ...extra,
});
const zaln = (content, occurrence, occurrences, children) => ({
  type: "milestone",
  tag: "zaln",
  content,
  occurrence: String(occurrence),
  occurrences: String(occurrences),
  children,
});
const t = (text) => ({ type: "text", text });

// UHB: "יְהוָה צְבָאוֹת ... יְהוָה" (two Yahweh occurrences).
const uhb = [
  w("יְהוָה", 1, 2, { strong: "H3068" }),
  t(" "),
  w("צְבָאוֹת", 1, 1),
  t(" "),
  w("יְהוָה", 2, 2, { strong: "H3068" }),
];

// ULT: "Yahweh of Armies ... Yahweh Selah" — "of"/"Armies" both under the
// צְבָאוֹת milestone; "Selah" is an unaligned bare word.
const ult = [
  zaln("יְהוָה", 1, 2, [w("Yahweh", 1, 2)]),
  t(" "),
  zaln("צְבָאוֹת", 1, 1, [w("of", 1), w("Armies", 1)]),
  t(" "),
  zaln("יְהוָה", 2, 2, [w("Yahweh", 2, 2)]),
  t(" "),
  w("Selah", 1),
];

// Single word, first occurrence.
{
  const r = resolveSpanToSource(ult, uhb, "Yahweh", 1);
  check(r && r.orig_words === "יְהוָה" && r.occurrence === 1 && r.confident, "single word occ1 -> יְהוָה occ1, confident");
}

// Single word, second occurrence picks the second Hebrew instance.
{
  const r = resolveSpanToSource(ult, uhb, "Yahweh", 2);
  check(r && r.orig_words === "יְהוָה" && r.occurrence === 2 && r.confident, "single word occ2 -> יְהוָה occ2, confident");
}

// Multi-word span unions the source words into one contiguous quote.
{
  const r = resolveSpanToSource(ult, uhb, "Yahweh of Armies", 1);
  check(
    r && r.orig_words === "יְהוָה צְבָאוֹת" && r.occurrence === 1 && r.confident,
    "multi-word 'Yahweh of Armies' -> 'יְהוָה צְבָאוֹת', confident",
  );
}

// Trailing punctuation in the span is tolerated.
{
  const r = resolveSpanToSource(ult, uhb, "Armies,", 1);
  check(r && r.orig_words === "צְבָאוֹת", "span with trailing punctuation still resolves");
}

// An unaligned word resolves to nothing (no source) -> null.
{
  const r = resolveSpanToSource(ult, uhb, "Selah", 1);
  check(r === null, "unaligned word -> null (no source to build from)");
}

// A span not present in the verse -> null.
{
  const r = resolveSpanToSource(ult, uhb, "Babylon", 1);
  check(r === null, "span not in verse -> null");
}

// Missing verse objects -> null.
{
  check(resolveSpanToSource(null, uhb, "Yahweh", 1) === null, "missing ULT -> null");
  check(resolveSpanToSource(ult, null, "Yahweh", 1) === null, "missing UHB -> null");
}

// DAN 6:3 shape — two source twins that differ ONLY by a U+2060 WORD JOINER.
// matchNorm folds the joiner away, so both \zaln-s (each legitimately stamped
// 1/1, since before folding they WERE distinct strings) would key identically
// unless collectTargetTokens is given the UHB verse to pin them apart. When it
// wasn't, the SECOND English "all" resolved to the FIRST Hebrew word and
// reported confident:true — silently writing the wrong orig_words onto a TWL
// row. (Pre-fix it returned the malformed two-word "כָּ⁠ל & כָּל".)
{
  const uhbTwins = [
    w("כָּ⁠ל", 1, 1),
    t(" "),
    w("קֳבֵל", 1, 1),
    t(" "),
    w("כָּל", 1, 1),
  ];
  const ultTwins = [
    zaln("כָּ⁠ל", 1, 1, [w("all", 1, 2)]),
    t(" "),
    zaln("קֳבֵל", 1, 1, [w("before", 1)]),
    t(" "),
    zaln("כָּל", 1, 1, [w("all", 2, 2)]),
  ];
  const first = resolveSpanToSource(ultTwins, uhbTwins, "all", 1);
  check(
    first && first.orig_words === "כָּ⁠ל" && first.occurrence === 1,
    `1st "all" -> the joiner-carrying כָּ⁠ל occ1 (got ${JSON.stringify(first)})`,
  );
  const second = resolveSpanToSource(ultTwins, uhbTwins, "all", 2);
  check(
    second && second.orig_words === "כָּל" && second.occurrence === 2,
    `2nd "all" -> the BARE כָּל occ2, not the first twin (got ${JSON.stringify(second)})`,
  );
  check(
    first.orig_words !== second.orig_words || first.occurrence !== second.occurrence,
    "the two twins resolve to DIFFERENT source words",
  );
}

// --- a bridged ULT row with x-ref, resolved against ONE verse (#1426) --------
// Real Door43 2CH 9:10-12 (the UST bridge stands in for a bridged ULT): each
// milestone counts per source verse and names it in x-ref, so אֶת 1/1 x-ref
// 9:11 and אֶת 1/1 x-ref 9:12 share the key אֶת|1. Resolving one verse's
// suggestion against that verse's UHB must not take another verse's English.
{
  console.log("\n[x-ref] bridged row resolved against one verse");
  const here = dirname(fileURLToPath(import.meta.url));
  const samples = resolve(here, "../../../docs/samples");
  const ustRaw = readFileSync(resolve(samples, "en_ust_14-2CH-9_10-12.usfm"), "utf8");
  const uhbJson = usfm.toJSON(readFileSync(resolve(samples, "hbo_uhb_14-2CH-9_10-12.usfm"), "utf8"));
  const uhbOf = (v) => uhbJson.chapters["9"][String(v)].verseObjects;
  const bridge = usfm.toJSON(ustRaw).chapters["9"]["10-12"].verseObjects;

  const own = resolveSpanToSource(bridge, uhbOf(12), "many things", 1, "9:12");
  check(
    own && nfc(own.orig_words) === nfc("אֶת־כָּל") && own.occurrence === 1 && own.confident,
    `9:12's "many things" -> 9:12's אֶת־כָּל (got ${JSON.stringify(own)})`,
  );
  const cross12 = resolveSpanToSource(bridge, uhbOf(12), "that wood", 1, "9:12");
  check(cross12 === null, `9:11's "that wood" does not resolve to 9:12's אֶת (got ${JSON.stringify(cross12)})`);
  const cross11 = resolveSpanToSource(bridge, uhbOf(11), "many things", 1, "9:11");
  check(cross11 === null, `9:12's "many things" does not resolve to 9:11's אֶת (got ${JSON.stringify(cross11)})`);
  const own11 = resolveSpanToSource(bridge, uhbOf(11), "that wood", 1, "9:11");
  check(
    own11 && nfc(own11.orig_words).startsWith(nfc("אֶת")) && own11.occurrence === 1 && own11.confident,
    `9:11's "that wood" -> 9:11's אֶת … (got ${JSON.stringify(own11)})`,
  );
  // glOccurrence still counts over the whole row (the suggest route scans the
  // row's full text): "King Solomon" is 9:12's, 9:10's, then 9:11's.
  const third = resolveSpanToSource(bridge, uhbOf(11), "King Solomon", 3, "9:11");
  check(
    third && nfc(third.orig_words) === nfc("הַ֠⁠מֶּלֶךְ") && third.confident,
    `3rd "King Solomon" in the row -> 9:11's הַמֶּלֶךְ (got ${JSON.stringify(third)})`,
  );

  // Milestones without x-ref keep the whole-bridge behaviour.
  const legacy = usfm.toJSON(ustRaw.replace(/ x-ref="[^"]*"/g, "")).chapters["9"]["10-12"].verseObjects;
  const scoped = resolveSpanToSource(legacy, uhbOf(12), "that wood", 1, "9:12");
  const unscoped = resolveSpanToSource(legacy, uhbOf(12), "that wood", 1);
  check(
    JSON.stringify(scoped) === JSON.stringify(unscoped) && scoped !== null,
    `no x-ref: sourceRef changes nothing (got ${JSON.stringify(scoped)} vs ${JSON.stringify(unscoped)})`,
  );
}

console.log(`twlResolve: ${passed} assertions passed`);
