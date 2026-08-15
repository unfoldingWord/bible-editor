// Unit tests for publishedGuard.ts — the published-books policy backing the
// book-lock feature.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/publishedGuard.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import {
  PUBLISHED_BOOKS,
  PUBLISHED_SET_MIN_BOOKS,
  isPublishedBook,
  pickLatestStableRelease,
  masterTargetedStableRelease,
  publishedBooksFromEntries,
  releaseSetUsable,
  describePublishedDrift,
  lockOverrideAllowed,
} from "./publishedGuard.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// --- PUBLISHED_BOOKS composition ---
const UNPUBLISHED = ["NUM", "1CH", "2CH", "ECC", "ISA", "JER", "EZK", "DAN", "AMO", "ZEC"];

assert(PUBLISHED_BOOKS.size === 56, `PUBLISHED_BOOKS has 56 books (got ${PUBLISHED_BOOKS.size})`);
for (const book of UNPUBLISHED) {
  assert(!PUBLISHED_BOOKS.has(book), `${book} is absent from PUBLISHED_BOOKS (unpublished)`);
}
assert(PUBLISHED_BOOKS.size + UNPUBLISHED.length === 66, "56 published + 10 unpublished === 66");

// --- isPublishedBook ---
assert(isPublishedBook("gen"), "isPublishedBook is case-insensitive (lowercase)");
assert(isPublishedBook("Gen"), "isPublishedBook is case-insensitive (mixed case)");
assert(isPublishedBook("GEN"), "isPublishedBook true for GEN");
assert(!isPublishedBook("ZEC"), "isPublishedBook false for unpublished ZEC");
assert(!isPublishedBook("XYZ"), "isPublishedBook false for unknown code");

// --- pickLatestStableRelease ---
assert(
  pickLatestStableRelease([
    { tag_name: "v88", published_at: "2026-01-01T00:00:00Z", target_commitish: "release_v88" },
    { tag_name: "v89", published_at: "2026-06-23T00:00:00Z", target_commitish: "release_v89" },
  ])?.tag_name === "v89",
  "picks the newest stable release",
);

assert(
  pickLatestStableRelease([
    { tag_name: "v89", published_at: "2026-06-23T00:00:00Z", target_commitish: "release_v89" },
    {
      tag_name: "v90-rc1",
      published_at: "2026-07-01T00:00:00Z",
      target_commitish: "release_v90",
      prerelease: true,
    },
  ])?.tag_name === "v89",
  "skips a prerelease:true release even if newer",
);

assert(
  pickLatestStableRelease([
    { tag_name: "v89", published_at: "2026-06-23T00:00:00Z", target_commitish: "release_v89" },
    { tag_name: "v90-draft", published_at: "2026-07-01T00:00:00Z", target_commitish: "release_v90", draft: true },
  ])?.tag_name === "v89",
  "skips a draft:true release even if newer",
);

assert(
  pickLatestStableRelease([
    { tag_name: "v89", published_at: "2026-06-23T00:00:00Z", target_commitish: "release_v89" },
    { tag_name: "v83.1", published_at: "2026-07-01T00:00:00Z", target_commitish: "master" },
  ])?.tag_name === "v89",
  "skips a release whose target_commitish is master, even if newest and otherwise stable",
);

assert(
  pickLatestStableRelease([
    { tag_name: "v90-rc1", published_at: "2026-07-01T00:00:00Z", target_commitish: "release_v90", prerelease: true },
    { tag_name: "v83.1", published_at: "2026-06-01T00:00:00Z", target_commitish: "master" },
  ]) === null,
  "returns null when every candidate is filtered out",
);

// Must not sort by tag name: "v9" > "v10" as strings, so a naive string sort
// would pick v9 even though v10 published later. Give it the inverse (v9
// published LATER than v10) and confirm date order wins, not string order.
assert(
  pickLatestStableRelease([
    { tag_name: "v10", published_at: "2024-01-01T00:00:00Z", target_commitish: "release_v10" },
    { tag_name: "v9", published_at: "2025-01-01T00:00:00Z", target_commitish: "release_v9" },
  ])?.tag_name === "v9",
  "does not order by tag name — v9 (published later) wins over v10 (published earlier)",
);

assert(
  pickLatestStableRelease([
    { tag_name: "v88", created_at: "2026-01-01T00:00:00Z", target_commitish: "release_v88" },
    { tag_name: "v89", published_at: null, created_at: "2026-06-23T00:00:00Z", target_commitish: "release_v89" },
  ])?.tag_name === "v89",
  "falls back to created_at when published_at is null",
);

// --- masterTargetedStableRelease ---
assert(
  masterTargetedStableRelease([
    {
      tag_name: "v83.1",
      published_at: "2026-07-01T00:00:00Z",
      target_commitish: "master",
      prerelease: true,
    },
  ]) === null,
  "the real v83.1 hazard (prerelease:true, target master) is excluded, not reported",
);
assert(
  masterTargetedStableRelease([
    { tag_name: "v90", published_at: "2026-08-01T00:00:00Z", target_commitish: "master" },
  ])?.tag_name === "v90",
  "a genuinely STABLE release (no draft, no prerelease) targeting master IS reported",
);
assert(
  masterTargetedStableRelease([
    { tag_name: "v90-draft", published_at: "2026-08-01T00:00:00Z", target_commitish: "master", draft: true },
  ]) === null,
  "a draft release targeting master is excluded, not reported",
);
assert(
  masterTargetedStableRelease([
    { tag_name: "v89", published_at: "2026-06-23T00:00:00Z", target_commitish: "release_v89" },
  ]) === null,
  "no master-targeted release at all -> null",
);
assert(
  masterTargetedStableRelease([
    { tag_name: "v90", published_at: "2026-01-01T00:00:00Z", target_commitish: "master" },
    { tag_name: "v91", published_at: "2026-08-01T00:00:00Z", target_commitish: "master" },
  ])?.tag_name === "v91",
  "picks the newest master-targeted stable release when there is more than one",
);

// --- publishedBooksFromEntries ---
{
  const entries = ["01-GEN.usfm", "A0-FRT.usfm", "README.md", ".gitignore"];
  const result = publishedBooksFromEntries(entries, ["GEN", "EXO"], "ult");
  assert(result.size === 1 && result.has("GEN"), "ult entries yield exactly {GEN}");
  assert(!result.has("FRT"), "ult entries never invent phantom book FRT");
}
{
  const entries = ["tn_GEN.tsv"];
  const tnResult = publishedBooksFromEntries(entries, ["GEN"], "tn");
  assert(tnResult.has("GEN"), "tn_GEN.tsv matches tn resource for GEN");
  const tqResult = publishedBooksFromEntries(entries, ["GEN"], "tq");
  assert(!tqResult.has("GEN"), "tn_GEN.tsv does not match tq resource (no cross-resource bleed)");
}

// --- releaseSetUsable ---
assert(
  releaseSetUsable(new Set(Array.from({ length: 54 }, (_, i) => String(i)))),
  "54-book set is usable",
);
assert(
  !releaseSetUsable(new Set(["A", "B", "C"])),
  "3-book set is not usable (looks like a truncated/failed listing)",
);
assert(PUBLISHED_SET_MIN_BOOKS === 40, "PUBLISHED_SET_MIN_BOOKS is 40");

// --- describePublishedDrift ---
assert(
  describePublishedDrift(new Set(["GEN", "EXO"]), new Set(["GEN", "EXO"])) === null,
  "null when the sets are equal",
);
{
  const drift = describePublishedDrift(new Set(["GEN", "EXO"]), new Set(["GEN", "ISA"]));
  assert(drift !== null, "drift detected when sets differ");
  assert(
    drift.newlyPublished.length === 1 && drift.newlyPublished[0] === "ISA",
    "reports the newly published book",
  );
  assert(
    drift.noLongerPublished.length === 1 && drift.noLongerPublished[0] === "EXO",
    "reports the no-longer-published book",
  );
  assert(drift.message.includes("v90"), "message names the release tag");
  assert(drift.message.includes("ISA") && drift.message.includes("EXO"), "message names the differing books");
}

// --- lockOverrideAllowed --- (mirrors shrinkOverrideAllowed's test shape)
assert(
  lockOverrideAllowed({ allowLocked: true, book: "ISA", resource: "tn" }, 1, 1) === true,
  "ISA tn: explicit single book + resource + allowLocked -> override permitted",
);
assert(
  lockOverrideAllowed({ book: "ISA", resource: "tn" }, 1, 1) === false,
  "no allowLocked flag -> refused",
);
assert(
  lockOverrideAllowed({ allowLocked: false, book: "ISA", resource: "tn" }, 1, 1) === false,
  "allowLocked: false -> refused",
);
assert(
  lockOverrideAllowed({ allowLocked: true, resource: "tn" }, 1, 1) === false,
  "allowLocked + resource but no book -> refused",
);
assert(
  lockOverrideAllowed({ allowLocked: true, book: "ISA" }, 1, 1) === false,
  "allowLocked + book but no resource -> refused",
);
// The important one: a truthy but unrecognized resource string widens to
// ALL_RESOURCES elsewhere in the codebase, so the resolved count is 5 even
// though the raw string looked like a single valid resource.
assert(
  lockOverrideAllowed({ allowLocked: true, book: "ISA", resource: "tqq" }, 1, 5) === false,
  "typo'd resource widened to 5 resolved resources -> refused despite truthy raw string",
);
assert(
  lockOverrideAllowed({ allowLocked: true, book: "ISA", resource: "tn" }, 2, 1) === false,
  "resolved book count > 1 -> refused",
);
assert(
  lockOverrideAllowed({ allowLocked: true, book: "ISA", resource: "tn" }, 1, 0) === false,
  "resolved resource count 0 -> refused",
);

console.log("publishedGuard: all assertions passed");
