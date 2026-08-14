// Smoke test for computeTsvMerge + foldTsvBase — the TSV three-way merge.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/tsvMerge.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors verseMerge.test.mjs /
// reimportClassify.test.mjs.
//
// What it locks down: an out-of-band maintainer edit on Door43 master to an
// app-edited tn/tq/twl row must be ADOPTED (or flagged as a conflict), never
// silently kept-and-reverted — attributed per field against the reconstructed
// ancestor. See tsvMerge.ts's header and the edited-row-skips-master-edit memory.

import { computeTsvMerge, foldTsvBase, tsvMergeFields } from "./tsvMerge.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}
function deep(actual, expected, msg) {
  eq(JSON.stringify(actual), JSON.stringify(expected), msg);
}

// ── computeTsvMerge ─────────────────────────────────────────────────────────

// 1. Converged: ours === theirs -> nothing to do.
{
  const r = computeTsvMerge("tn", { note: "a" }, { note: "hello" }, { note: "hello" });
  eq(r.action, "keep_converged", "tn converged action");
  eq(r.adopt, false, "tn converged not adopt");
  deep(r.writeFields, {}, "tn converged no writes");
}

// 2. Whitespace-only difference is not a move -> converged.
{
  const r = computeTsvMerge("tn", { note: "x" }, { note: "hello  world" }, { note: "hello world" });
  eq(r.action, "keep_converged", "tn whitespace-only diff -> converged");
}
{
  // literal \n escape vs space
  const r = computeTsvMerge("tn", { note: "x" }, { note: "a\\nb" }, { note: "a b" });
  eq(r.action, "keep_converged", "tn \\n-escape vs space -> converged");
}

// 3. No ancestor + a real diff -> keep_no_base (keep D1, surfaced).
{
  const r = computeTsvMerge("tn", null, { note: "ours" }, { note: "theirs" });
  eq(r.action, "keep_no_base", "tn no base action");
  eq(r.adopt, false, "tn no base not adopt");
}

// 4. Master never moved (theirs === base), only we moved -> keep ours.
{
  const r = computeTsvMerge("tn", { note: "orig" }, { note: "our edit" }, { note: "orig" });
  eq(r.action, "keep_master_unchanged", "tn master-unchanged action");
  deep(r.writeFields, {}, "tn master-unchanged writes nothing (our edit stands)");
}

// 5. Adopt: we never moved (ours === base), master did.
{
  const r = computeTsvMerge("tn", { note: "orig" }, { note: "orig" }, { note: "master fix" });
  eq(r.action, "adopt", "tn adopt action");
  eq(r.adopt, true, "tn adopt true");
  eq(r.conflict, false, "tn adopt no conflict");
  deep(r.writeFields, { note: "master fix" }, "tn adopt writes master value");
}

// 6. Conflict: both moved the same field -> master wins + flag.
{
  const r = computeTsvMerge("tn", { note: "orig" }, { note: "our edit" }, { note: "master edit" });
  eq(r.action, "adopt_conflict", "tn conflict action");
  eq(r.conflict, true, "tn conflict true");
  deep(r.writeFields, { note: "master edit" }, "tn conflict writes master value");
  deep(r.conflictFields, ["note"], "tn conflict lists note");
}

// 7. Mixed: master moved quote (we didn't) AND we moved note (master didn't).
//    -> adopt quote only, keep our note.
{
  const base = { quote: "q0", note: "n0", occurrence: 1 };
  const ours = { quote: "q0", note: "our note", occurrence: 1 };
  const theirs = { quote: "q_master", note: "n0", occurrence: 1 };
  const r = computeTsvMerge("tn", base, ours, theirs);
  eq(r.action, "adopt", "tn mixed adopt/keep -> adopt");
  deep(r.writeFields, { quote: "q_master" }, "tn mixed adopts only quote, keeps our note");
  deep(r.conflictFields, [], "tn mixed no conflict");
}

// 8. Mixed with a genuine both-moved field -> adopt_conflict overall.
{
  const base = { quote: "q0", note: "n0" };
  const ours = { quote: "q0", note: "our note" };
  const theirs = { quote: "q_master", note: "master note" };
  const r = computeTsvMerge("tn", base, ours, theirs);
  eq(r.action, "adopt_conflict", "tn mixed with conflict -> adopt_conflict");
  deep(r.writeFields, { quote: "q_master", note: "master note" }, "tn writes both master values");
  deep(r.conflictFields, ["note"], "tn only note is the conflict field");
}

// 9. Occurrence is deliberately NOT merged (renderOccurrence coercion makes
//    D1-vs-master occurrence unreliable — see FIELDS_BY_KIND). A pure occurrence
//    difference must therefore read as converged (nothing this merge owns
//    differs), never adopt.
{
  const r = computeTsvMerge("tn", { quote: "q", occurrence: 1 }, { quote: "q", occurrence: 1 }, { quote: "q", occurrence: 2 });
  eq(r.action, "keep_converged", "tn occurrence-only diff is ignored (not merged)");
  deep(r.writeFields, {}, "tn writes nothing for an occurrence-only diff");
}

// 10. Per-kind fields: twl merges orig_words / tw_link, ignores note.
{
  const base = { orig_words: "w0", tw_link: "l0" };
  const ours = { orig_words: "w0", tw_link: "l0", note: "ignored" };
  const theirs = { orig_words: "w_master", tw_link: "l0", note: "also ignored" };
  const r = computeTsvMerge("twl", base, ours, theirs);
  eq(r.action, "adopt", "twl adopt orig_words");
  deep(r.writeFields, { orig_words: "w_master" }, "twl adopts orig_words, note irrelevant");
}
{
  // tq merges question/response
  const r = computeTsvMerge(
    "tq",
    { question: "q0", response: "r0" },
    { question: "q0", response: "our r" },
    { question: "master q", response: "r0" },
  );
  eq(r.action, "adopt", "tq adopt question (kept our response)");
  deep(r.writeFields, { question: "master q" }, "tq adopts only question");
}

// 11. Field absent from a partial (aged-out) base but differing -> no_base.
{
  // base only carries note; quote differs but has no ancestor -> keep_no_base.
  const r = computeTsvMerge("tn", { note: "n0" }, { note: "n0", quote: "q_ours" }, { note: "n0", quote: "q_theirs" });
  eq(r.action, "keep_no_base", "tn field-absent-in-base diff -> keep_no_base");
  deep(r.writeFields, {}, "tn no writes when only unattributable field differs");
}

// 12. Base carries an explicit null; we filled it, master still null ->
//     master unchanged, keep our value.
{
  const r = computeTsvMerge(
    "tn",
    { support_reference: null, note: "n0" },
    { support_reference: "rc://x", note: "n0" },
    { support_reference: null, note: "n0" },
  );
  eq(r.action, "keep_master_unchanged", "tn explicit-null base, our fill stands");
  deep(r.writeFields, {}, "tn keeps our support_reference");
}

// sanity: field lists — tags is intentionally NOT here (owned by
// computeEditedFieldMerge), nor is sort_order (D1-owned).
deep(tsvMergeFields("tq"), ["quote", "question", "response"], "tq field list");

// ── foldTsvBase ─────────────────────────────────────────────────────────────

// A single full create -> all fields present.
{
  const base = foldTsvBase("tn", [
    { action: "create", payload: { quote: "q", note: "n", occurrence: 1, support_reference: "rc://s", tags: null } },
  ]);
  // tags and occurrence are not merged fields, so the fold omits them even when
  // the create carries them.
  deep(base, { quote: "q", note: "n", support_reference: "rc://s" }, "fold single create");
}

// Create + partial patch (note only) -> note updated, other fields from create.
{
  const base = foldTsvBase("tn", [
    { action: "create", payload: { quote: "q", note: "n0", occurrence: 1 } },
    { action: "update", payload: { note: "n1" } },
  ]);
  eq(base.note, "n1", "fold partial patch overlays note");
  eq(base.quote, "q", "fold partial patch keeps quote from create");
}

// Reimport payload uses camelCase (ParsedTsvRow) — origWords must fold to orig_words.
{
  const base = foldTsvBase("twl", [
    { action: "create", payload: { orig_words: "w0", tw_link: "l0", occurrence: 1 } },
    { action: "update", payload: { origWords: "w1", twLink: "l1" } },
  ]);
  eq(base.orig_words, "w1", "fold camelCase origWords -> orig_words");
  eq(base.tw_link, "l1", "fold camelCase twLink -> tw_link");
}

// Only partial patches survived (create aged out) -> unmentioned fields absent.
{
  const base = foldTsvBase("tn", [{ action: "update", payload: { note: "n_late" } }]);
  eq(base.note, "n_late", "fold aged-out: note present");
  eq("quote" in base, false, "fold aged-out: quote absent (unattributable)");
}

// No content-bearing entries -> null.
{
  const base = foldTsvBase("tn", [
    { action: "delete", payload: null },
    { action: "trash", payload: null },
  ]);
  eq(base, null, "fold no-content history -> null");
}

// Occurrence is not a merged field, so a history carrying ONLY occurrence folds
// to null (nothing this merge owns was ever set).
{
  const base = foldTsvBase("tn", [{ action: "create", payload: { occurrence: "2" } }]);
  eq(base, null, "fold occurrence-only history -> null (occurrence not merged)");
}

// A present-but-null field overlays as null (not skipped).
{
  const base = foldTsvBase("tn", [
    { action: "create", payload: { support_reference: "rc://s" } },
    { action: "update", payload: { support_reference: null } },
  ]);
  eq(base.support_reference, null, "fold present-null overlays to null");
}

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nall tsvMerge assertions passed");
