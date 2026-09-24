// Unit tests for tnDedup.ts — the TN content-dedup decision (Guard 2 of the
// DCS→D1 reimport hardening). Run from api/:
//   node --experimental-strip-types --no-warnings src/tnDedup.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { tnContentKey, planTnContentDedup } from "./tnDedup.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// Build a TN row; defaults make a complete identical-content note unless overridden.
function row(id, over = {}) {
  return {
    id,
    chapter: 1,
    verse: 1,
    occurrence: 1,
    support_reference: "rc://*/ta/man/translate/figs-metaphor",
    quote: "דָּבָר",
    note: "The word here means…",
    ...over,
  };
}

const setOf = (s) => [...s].sort((a, b) => a - b);

// --- tnContentKey: identity excludes id, includes occurrence ---
assert(
  tnContentKey(row("aaaa")) === tnContentKey(row("bbbb")),
  "same content under different ids → same key (id is not part of identity)",
);
assert(
  tnContentKey(row("aaaa", { occurrence: 1 })) !== tnContentKey(row("aaaa", { occurrence: 2 })),
  "different occurrence → different key (ISA 10:9 אִם occ 1 vs occ 2 stay distinct)",
);
assert(
  tnContentKey(row("aaaa", { note: "A" })) !== tnContentKey(row("aaaa", { note: "B" })),
  "different note text → different key",
);
assert(
  tnContentKey(row("aaaa", { occurrence: null })) === tnContentKey(row("bbbb", { occurrence: null })),
  "null occurrence is handled and still matches by content",
);

// --- planTnContentDedup scenarios ---

// 1. The doubling round-trip: D1 is clean, master carries two id-disjoint copies
//    of one note. Insert the first, skip the second.
{
  const incoming = [row("aaaa"), row("bbbb")];
  const skip = planTnContentDedup(incoming, new Set(), new Set());
  assert(setOf(skip).join(",") === "1", "doubling: second identical copy skipped, first kept");
}

// 1b. Triple copy → only the first survives.
{
  const incoming = [row("aaaa"), row("bbbb"), row("cccc")];
  const skip = planTnContentDedup(incoming, new Set(), new Set());
  assert(setOf(skip).join(",") === "1,2", "triple copy: indices 1 & 2 skipped");
}

// 2. Against an existing pristine row master KEEPS: aaaa is a no-op, bbbb dups it.
{
  const incoming = [row("aaaa"), row("bbbb")];
  const skip = planTnContentDedup(incoming, new Set(["aaaa"]), new Set(["aaaa"]));
  assert(setOf(skip).join(",") === "1", "existing pristine kept: duplicate insert bbbb skipped");
}

// 3. Distinct occurrences are NOT duplicates — both inserted.
{
  const incoming = [row("aaaa", { occurrence: 1 }), row("bbbb", { occurrence: 2 })];
  const skip = planTnContentDedup(incoming, new Set(), new Set());
  assert(skip.size === 0, "distinct occurrences both inserted (no false dedup)");
}

// 4. Never dedup against a human row: aaaa exists but is EDITED (in existsAny, not
//    existsPristine). An identical incoming note bbbb is still inserted — the
//    guard must not collapse master's note into human work.
{
  const incoming = [row("bbbb")];
  const skip = planTnContentDedup(incoming, new Set(), new Set(["aaaa"]));
  assert(skip.size === 0, "duplicate of a human-edited row is NOT skipped");
}

// 5. Master "rename" (drop id s, add id b, same content): s isn't in `incoming`
//    (so it's invisible to the dedup — the prune handles it). b is inserted.
{
  const incoming = [row("bbbb")];
  const skip = planTnContentDedup(incoming, new Set(), new Set());
  assert(skip.size === 0, "rename: new id inserted (stale id is pruned elsewhere)");
}

// 6. An update frees a content key: stored a1 was C_old, incoming a1 becomes
//    C_new, and a brand-new b1 wants C_old. b1 must NOT be skipped.
{
  const incoming = [row("a1aa", { note: "C_new" }), row("b1bb", { note: "C_old" })];
  const skip = planTnContentDedup(incoming, new Set(["a1aa"]), new Set(["a1aa"]));
  assert(skip.size === 0, "update frees a content key: new row claiming it is inserted");
}

// 7. Order independence: the duplicate insert appears BEFORE the existing-row
//    no-op in file order. The seed pre-claims the existing row's content, so the
//    earlier duplicate is still caught.
{
  const incoming = [row("bbbb"), row("aaaa")];
  const skip = planTnContentDedup(incoming, new Set(["aaaa"]), new Set(["aaaa"]));
  assert(setOf(skip).join(",") === "0", "order-independent: dup at index 0 skipped, no-op aaaa kept");
}

console.log("tnDedup.test.mjs: all assertions passed");
