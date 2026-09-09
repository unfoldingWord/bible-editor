// Regression coverage for issue #671: a reorder-only PATCH
// (api/src/rows.ts's sort_order fast path) intentionally skips the version
// bump and broadcasts row.upserted with the unchanged version, and the old
// onUpsert guard in Shell.tsx dropped every same-version broadcast except a
// tn preserve/hint/trashed_at flip — so a drag-reorder in tab A never
// reordered tab B until an unrelated refetch. shouldApplyUpsert widens the
// same-version carve-out to also catch a sort_order difference.

import assert from "node:assert/strict";
import { shouldApplyUpsert } from "./rowUpsertGuard.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ok: ${msg}`);
};

const tnRow = (overrides = {}) => ({
  id: "abcd",
  book: "ZEC",
  chapter: 1,
  verse: 1,
  ref_raw: "1:1",
  tags: null,
  support_reference: null,
  quote: null,
  occurrence: null,
  note: "hello",
  sort_order: 100,
  version: 3,
  restored_from_version: null,
  updated_by: 1,
  updated_at: 1000,
  deleted_at: null,
  trashed_at: null,
  preserve: 0,
  hint: 0,
  ...overrides,
});

const twlRow = (overrides = {}) => ({
  id: "wxyz",
  book: "ZEC",
  chapter: 1,
  verse: 1,
  ref_raw: "1:1",
  tags: null,
  orig_words: "word",
  occurrence: 1,
  tw_link: "rc://...",
  sort_order: 100,
  version: 2,
  restored_from_version: null,
  updated_by: 1,
  updated_at: 1000,
  deleted_at: null,
  ...overrides,
});

console.log("[absent locally: always apply — a genuine insert]");
{
  const incoming = tnRow();
  check(shouldApplyUpsert("tn", incoming, undefined) === true, "no cached row => apply");
}

console.log("[strictly higher version: always apply — the normal edit case]");
{
  const existing = tnRow({ version: 3, note: "old" });
  const incoming = tnRow({ version: 4, note: "new" });
  check(shouldApplyUpsert("tn", incoming, existing) === true, "higher version => apply");
}

console.log("[same version, sort_order differs: now applies (issue #671, tn)]");
{
  const existing = tnRow({ version: 3, sort_order: 100 });
  const incoming = tnRow({ version: 3, sort_order: 200 });
  check(shouldApplyUpsert("tn", incoming, existing) === true, "tn reorder broadcast now applies cross-tab");
}

console.log("[same version, sort_order differs: applies for twl too, per-kind]");
{
  const existing = twlRow({ version: 2, sort_order: 100 });
  const incoming = twlRow({ version: 2, sort_order: 300 });
  check(shouldApplyUpsert("twl", incoming, existing) === true, "twl reorder broadcast now applies cross-tab");
}

console.log("[same version, nothing differs: still discarded — no over-applying]");
{
  const existing = tnRow({ version: 3 });
  const incoming = tnRow({ version: 3 });
  check(
    shouldApplyUpsert("tn", incoming, existing) === false,
    "identical same-version broadcast (e.g. the originating tab's own echo) stays a no-op",
  );
}
{
  const existing = twlRow({ version: 2 });
  const incoming = twlRow({ version: 2 });
  check(shouldApplyUpsert("twl", incoming, existing) === false, "identical same-version twl broadcast is a no-op");
}

console.log("[same version, older/lower than existing: never applies]");
{
  // Not expected in practice (id-scoped broadcasts arrive in order), but the
  // guard must not treat "different version, not higher" as newer.
  const existing = tnRow({ version: 3, sort_order: 100 });
  const incoming = tnRow({ version: 2, sort_order: 999 });
  check(shouldApplyUpsert("tn", incoming, existing) === false, "lower version never applies, even with other diffs");
}

console.log("[tn preserve/hint/trashed_at bit-toggles: unchanged pre-#671 behavior]");
{
  const existing = tnRow({ version: 3, preserve: 0 });
  const incoming = tnRow({ version: 3, preserve: 1 });
  check(shouldApplyUpsert("tn", incoming, existing) === true, "preserve toggle still applies same-version");
}
{
  const existing = tnRow({ version: 3, hint: 0 });
  const incoming = tnRow({ version: 3, hint: 1 });
  check(shouldApplyUpsert("tn", incoming, existing) === true, "hint toggle still applies same-version");
}
{
  const existing = tnRow({ version: 3, trashed_at: null });
  const incoming = tnRow({ version: 3, trashed_at: 12345 });
  check(shouldApplyUpsert("tn", incoming, existing) === true, "trashed_at toggle still applies same-version");
}

console.log(`\n${passed} checks passed.`);
