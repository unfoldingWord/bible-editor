// Smoke test for classifyReimportRow — the reorder-preservation invariant in
// the DCS→D1 reimport. Run from api/:
//   node --experimental-strip-types --no-warnings src/reimportClassify.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors sortOrder.test.mjs.
//
// Regression: a TN/TWL reorder writes only sort_order (no version/updated_by
// bump), so the row stays pristine. The reimport used to treat "content matches
// but sort_order differs" as a pristine change and overwrite sort_order back to
// master file order — reverting the user's reorder (HOS 11 TN / HOS 12 TWL,
// reported by Beth Oakes). A content-identical tn/twl row that owns its order
// must be a no-op so its local order survives and the next export pushes it to
// master. But the preservation is SCOPED: tq (no in-app reorder) and NULL-sort
// rows must still adopt master file order.

import { classifyReimportRow, isReimportableRow, computeEditedFieldMerge, AI_SOURCE } from "./reimportClassify.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n    expected ${expected}\n    got      ${actual}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// args: (contentMatches, sortMatches, reimportable, preserveLocalOrder, aiOnly)
console.log("\n[classifyReimportRow]");

// Steady state: content AND order match → no-op (both pristine and edited).
eq(classifyReimportRow(true, true, true, true), "noop", "content+sort match → noop");
eq(classifyReimportRow(true, true, false, false), "noop", "content+sort match (edited) → noop");

// THE FIX: content matches, sort differs, row owns its order (tn/twl, non-null)
// → no-op, preserving the local reorder instead of reverting to file order.
eq(
  classifyReimportRow(true, false, true, true),
  "noop",
  "tn/twl reorder (content match, sort differs, preserve) → noop (preserve)",
);

// SCOPING (Codex P2): content matches, sort differs, but master owns the order
// (tq, or a NULL sort_order) → adopt master file order when pristine…
eq(
  classifyReimportRow(true, false, true, false),
  "update",
  "tq / null-sort (content match, sort differs, no preserve) → update (adopt master order)",
);
// …and never clobber a human-edited row even to adopt order.
eq(
  classifyReimportRow(true, false, false, false),
  "edited",
  "edited row, sort differs, no preserve → skip (never clobber)",
);

// Content drifted from master.
eq(classifyReimportRow(false, false, true, false), "update", "content differs + pristine → update");
eq(classifyReimportRow(false, false, false, false), "edited", "content differs + edited → skip");
// A content change on a would-be-preserve row still updates (preserve only
// covers order, not content).
eq(classifyReimportRow(false, false, true, true), "update", "content differs + pristine + preserve → update");

// AI-only rows (reimportable + aiOnly): content drift re-seeds via update_ai
// (distinct from a pristine update so the caller uses the reclaim guard/counter).
eq(
  classifyReimportRow(false, false, true, false, true),
  "update_ai",
  "content differs + AI-only → update_ai (re-seed + reclaim)",
);
// AI-only, sort differs, master owns order → update_ai (adopt master order).
eq(
  classifyReimportRow(true, false, true, false, true),
  "update_ai",
  "AI-only, content match, sort differs, no preserve → update_ai",
);
// AI-only content-identical + sort match → still just a no-op.
eq(classifyReimportRow(true, true, true, false, true), "noop", "AI-only, content+sort match → noop");
// AI-only tn/twl reorder (content match, sort differs, preserve) → no-op; the
// preserve branch wins before the aiOnly re-seed (documented: self-heals later).
eq(
  classifyReimportRow(true, false, true, true, true),
  "noop",
  "AI-only tn/twl reorder (content match, sort differs, preserve) → noop",
);

console.log("\n[isReimportableRow]");

// Pristine (updated_by NULL) is always re-importable regardless of latestSource.
eq(
  isReimportableRow({ updated_by: null, latestSource: null, deleted_at: null, kind: "tn" }),
  true,
  "pristine tn (updated_by null) → reimportable",
);
// AI-only: updated_by set, latest content edit_log source is the AI pipeline.
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: null, kind: "tn" }),
  true,
  "AI-only tn (updated_by set, latest source ai_pipeline) → reimportable",
);
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: null, kind: "verse" }),
  true,
  "AI-only verse → reimportable",
);
// Human-edited: updated_by set, latest source null/manual → NOT re-importable.
eq(
  isReimportableRow({ updated_by: 7, latestSource: null, deleted_at: null, kind: "tn" }),
  false,
  "human-edited tn (latest source null) → NOT reimportable (skip)",
);
eq(
  isReimportableRow({ updated_by: 7, latestSource: "dcs_reimport", deleted_at: null, kind: "twl" }),
  false,
  "twl whose latest source is a non-AI source → NOT reimportable",
);
// AI row later human-edited: the human PATCH writes a null-source edit_log entry,
// so latestSource is no longer ai_pipeline → NOT re-importable.
eq(
  isReimportableRow({ updated_by: 7, latestSource: null, deleted_at: null, kind: "verse" }),
  false,
  "AI row later human-edited (latest source null) → NOT reimportable (skip)",
);
// Human-owned protections still block an otherwise-AI-only row.
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: 123, kind: "tq" }),
  false,
  "tombstone (deleted_at set) → NOT reimportable even if AI-only",
);
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: null, trashed_at: 123, kind: "tn" }),
  false,
  "trashed tn → NOT reimportable even if AI-only",
);
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: null, preserve: 1, kind: "tn" }),
  false,
  "preserve=1 tn → NOT reimportable even if AI-only",
);
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: null, hint: 1, kind: "tn" }),
  false,
  "hint=1 tn → NOT reimportable even if AI-only",
);
// Those tn-only protections are ignored for non-tn kinds (defensive: a caller
// passing them for a tq/twl/verse row must not accidentally block it).
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: null, preserve: 1, hint: 1, kind: "tq" }),
  true,
  "tq ignores preserve/hint → AI-only tq still reimportable",
);
// A pristine tombstone is not reimportable here (resurrection is a separate path).
eq(
  isReimportableRow({ updated_by: null, latestSource: null, deleted_at: 123, kind: "twl" }),
  false,
  "pristine tombstone → NOT reimportable (resurrection handled elsewhere)",
);

function eqDeep(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    console.error(`FAIL: ${msg}\n    expected ${b}\n    got      ${a}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const noProtections = { deleted_at: null, trashed_at: null, preserve: null, hint: null };

console.log("\n[computeEditedFieldMerge]");

// tn: master blanked tags → merges tags, keeps note untouched (note unchanged).
eqDeep(
  computeEditedFieldMerge(
    "tn",
    { tags: "keyword", note: "a note" },
    { tags: null, note: "a note" },
    noProtections,
  ),
  { tags: null },
  "tn: master blanked tags → merges tags only",
);

// tq: same rule — tags always adopted from master, including blank.
eqDeep(
  computeEditedFieldMerge(
    "tq",
    { tags: "keyword", question: "q?", response: "r." },
    { tags: "", question: "q?", response: "r." },
    noProtections,
  ),
  { tags: "" },
  "tq: master blanked tags → merges tags only",
);

// twl: master tags empty → does NOT merge (would wipe a human-set tag).
eqDeep(
  computeEditedFieldMerge("twl", { tags: "keyword" }, { tags: "" }, noProtections),
  null,
  "twl: master tags empty → does not merge",
);
// twl: master tags non-empty and different → merges.
eqDeep(
  computeEditedFieldMerge("twl", { tags: "old" }, { tags: "new" }, noProtections),
  { tags: "new" },
  "twl: master tags non-empty and different → merges",
);

// Note differing only by a double space → merges.
eqDeep(
  computeEditedFieldMerge(
    "tn",
    { tags: "x", note: "hello  world" },
    { tags: "x", note: "hello world" },
    noProtections,
  ),
  { note: "hello world" },
  "tn: note differs only by double space → merges",
);

// Note differing only by a space before a literal \n (two-char backslash-n) → merges.
eqDeep(
  computeEditedFieldMerge(
    "tn",
    { tags: "x", note: "line one \\nline two" },
    { tags: "x", note: "line one\\nline two" },
    noProtections,
  ),
  { note: "line one\\nline two" },
  "tn: note differs only by space before literal \\n → merges",
);

// Note differing substantively → does NOT merge, stays "edited".
eqDeep(
  computeEditedFieldMerge(
    "tn",
    { tags: "x", note: "the original note" },
    { tags: "x", note: "a completely different note" },
    noProtections,
  ),
  null,
  "tn: substantive note difference → does not merge",
);

// tq: question differs substantively, response matches → merges response only,
// leaves question (and the fate) as edited.
eqDeep(
  computeEditedFieldMerge(
    "tq",
    { tags: "x", question: "human question", response: "answer  here" },
    { tags: "x", question: "master question", response: "answer here" },
    noProtections,
  ),
  { response: "answer here" },
  "tq: only whitespace-only response merges, substantive question does not",
);

// quote/occurrence/support_reference are not part of MergeableTsvFields at
// all — computeEditedFieldMerge has no way to touch them; confirm nothing
// merges when only tags/note are checked and they already match (i.e. a
// row differing solely in a non-mergeable column never produces a merge).
eqDeep(
  computeEditedFieldMerge("tn", { tags: "x", note: "same" }, { tags: "x", note: "same" }, noProtections),
  null,
  "tn: nothing to merge (all mergeable fields already match) → null",
);

// Protections win: deleted_at/trashed_at/preserve/hint each block the merge
// outright even though tags would otherwise qualify.
eqDeep(
  computeEditedFieldMerge(
    "tn",
    { tags: "old" },
    { tags: "new" },
    { deleted_at: 123, trashed_at: null, preserve: null, hint: null },
  ),
  null,
  "tn: deleted_at set → never merges",
);
eqDeep(
  computeEditedFieldMerge(
    "tn",
    { tags: "old" },
    { tags: "new" },
    { deleted_at: null, trashed_at: 123, preserve: null, hint: null },
  ),
  null,
  "tn: trashed_at set → never merges",
);
eqDeep(
  computeEditedFieldMerge(
    "tn",
    { tags: "old" },
    { tags: "new" },
    { deleted_at: null, trashed_at: null, preserve: 1, hint: null },
  ),
  null,
  "tn: preserve=1 → never merges",
);
eqDeep(
  computeEditedFieldMerge(
    "tn",
    { tags: "old" },
    { tags: "new" },
    { deleted_at: null, trashed_at: null, preserve: null, hint: 1 },
  ),
  null,
  "tn: hint=1 → never merges",
);

// Pristine-row analogue: computeEditedFieldMerge is only ever consulted by the
// caller when classifyReimportRow already said "edited" — a pristine row
// takes the normal "update" fate and never reaches this function. Sanity
// check that classifyReimportRow itself is unaffected by this change.
eq(classifyReimportRow(false, false, true, false), "update", "pristine + content differs → still plain update");

// Nothing to merge → stays a plain "edited" skip (the caller falls back to
// skipped_edited when computeEditedFieldMerge returns null).
eqDeep(
  computeEditedFieldMerge(
    "twl",
    { tags: "same" },
    { tags: "same" },
    noProtections,
  ),
  null,
  "twl: nothing differs → null (fate stays edited)",
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll reimportClassify assertions passed.");
