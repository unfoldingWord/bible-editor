// Tests for resolveSpanToSource (web/src/lib/twlResolve.ts) — the English-span ->
// {orig_words, occurrence, confident} resolver behind TWL suggestions. Covers the
// edge cases that make it the hard part: occurrence selection, multi-word source
// union, unaligned words, and unmatched spans.

import assert from "node:assert/strict";
import { resolveSpanToSource } from "./twlResolve.ts";

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

console.log(`twlResolve: ${passed} assertions passed`);
