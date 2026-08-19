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

import { computeTsvMerge, foldTsvBase, tsvMergeFields, tsvRefMoved } from "./tsvMerge.ts";

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

// 2b. Export-normalization-only differences are not a move. Master is always
// normalizeNoteText(some past D1 value) while the ancestor is folded from raw
// edit_log payloads, so a straight apostrophe in the ancestor vs the curly one
// the export educated must NOT read as "Door43 changed it" — that phantom made
// every later app edit a both-changed conflict that master won, reverting the
// AMO 3:10 note nightly (2026-08-18/19).
{
  // dsj8 regression: ancestor straight apostrophe, master curly (educated),
  // ours a genuine human rewrite -> master unchanged, our edit stands.
  const r = computeTsvMerge(
    "tn",
    { note: "comes with Yahweh's authority" },
    { note: "a genuine human rewrite" },
    { note: "comes with Yahweh’s authority" },
  );
  eq(r.action, "keep_master_unchanged", "tn curly-vs-straight apostrophe ancestor -> master unchanged");
  deep(r.writeFields, {}, "tn apostrophe phantom writes nothing");
}
{
  // educated double quotes
  const r = computeTsvMerge(
    "tn",
    { note: 'he said "go" now' },
    { note: "our new note" },
    { note: "he said “go” now" },
  );
  eq(r.action, "keep_master_unchanged", "tn educated double quotes -> master unchanged");
}
{
  // Alternate-translation label canonicalization
  const r = computeTsvMerge(
    "tn",
    { note: "Alternative Translation: x" },
    { note: "our new note" },
    { note: "Alternate translation: x" },
  );
  eq(r.action, "keep_master_unchanged", "tn alt-label canonicalization -> master unchanged");
}
{
  // ours straight vs theirs curly, same text -> converged, no write
  const r = computeTsvMerge("tn", { note: "x" }, { note: "Yahweh's word" }, { note: "Yahweh’s word" });
  eq(r.action, "keep_converged", "tn ours-straight vs theirs-curly same text -> converged");
}
{
  // tq question + response are export-normalized too — same phantom shape must
  // resolve the same way (Codex review coverage finding on PR #541).
  const r = computeTsvMerge(
    "tq",
    { question: "What is Yahweh's word?", response: "It is Yahweh's message." },
    { question: "Beth's new question?", response: "Beth's new answer." },
    { question: "What is Yahweh’s word?", response: "It is Yahweh’s message." },
  );
  eq(r.action, "keep_master_unchanged", "tq curly-vs-straight ancestor (question+response) -> master unchanged");
  deep(r.writeFields, {}, "tq apostrophe phantom writes nothing");
}
{
  // a REAL master edit that merely contains a curly quote still conflicts
  const r = computeTsvMerge(
    "tn",
    { note: "orig" },
    { note: "our edit" },
    { note: "master’s real edit" },
  );
  eq(r.action, "adopt_conflict", "tn real master edit with curly quote still conflicts");
}

// 2c. The export lens applies ONLY to the fields the export normalizes
// (note/question/response — export.ts:131/:138). quote, support_reference,
// orig_words, tw_link render RAW, so for them master really did move when a
// maintainer fixed an ASCII-quote corruption — the lens must NOT swallow it,
// or the raw-rendering export reverts the fix nightly.
{
  // tn quote: maintainer fixed a straight apostrophe on master, we never
  // touched the field -> adopt (NOT "unchanged").
  const r = computeTsvMerge(
    "tn",
    { quote: "the fishermen's boats", note: "n" },
    { quote: "the fishermen's boats", note: "n" },
    { quote: "the fishermen’s boats", note: "n" },
  );
  eq(r.action, "adopt", "tn quote-column ASCII-quote fix on master is adopted (no lens)");
  deep(r.writeFields, { quote: "the fishermen’s boats" }, "tn quote fix writes master's raw bytes");
}
{
  // twl orig_words: same shape, raw column
  const r = computeTsvMerge(
    "twl",
    { orig_words: "servant's", tw_link: "t" },
    { orig_words: "servant's", tw_link: "t" },
    { orig_words: "servant’s", tw_link: "t" },
  );
  eq(r.action, "adopt", "twl orig_words ASCII-quote fix on master is adopted (no lens)");
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

// ── tsvRefMoved (P1.4 reference-move detection) ─────────────────────────────
// The reimport must detect a Door43 maintainer re-anchoring an app-edited row
// to a different Reference (same id, new chapter/verse/ref_raw) — identity
// columns are excluded from computeTsvMerge, so nothing else catches this class,
// and missing it silently reverts the maintainer's move. These lock the
// detection (bookReimport.ts calls this exact helper; a regression here fails
// the suite). The two effects a true triggers in the caller — apply_incomplete
// (withhold the resource watermark so the export can't revert master) and
// review_kind='ref_moved' (flag the row for a human) — are wired in
// applyTsvRows off this boolean; this covers the decision that drives them.

// A moved row's identity change is invisible to the field merge: computeTsvMerge
// only sees content fields, so a same-content move yields no writeFields. This is
// exactly WHY the separate tsvRefMoved detection + watermark withhold is needed.
{
  const side = { quote: "q", note: "n", occurrence: 1, support_reference: null };
  const r = computeTsvMerge("tn", side, side, side);
  eq(r.action, "keep_converged", "moved-but-same-content row: field merge sees no change");
  deep(r.writeFields, {}, "moved-but-same-content row: field merge writes nothing (identity excluded)");
}

// Cross-chapter move (the case the row won't even appear in the old chapter's
// incoming set — caught when master's NEW chapter is processed via the id lookup).
{
  const cur = { chapter: 3, verse: 4, ref_raw: "3:4" };
  const incoming = { chapter: 5, verse: 1, refRaw: "5:1" };
  eq(tsvRefMoved(cur, incoming, false), true, "cross-chapter move detected");
}

// Same-chapter verse move.
{
  eq(tsvRefMoved({ chapter: 1, verse: 2, ref_raw: "1:2" }, { chapter: 1, verse: 6, refRaw: "1:6" }, false), true, "same-chapter verse move detected");
}

// ref_raw-only change (chapter/verse identical — e.g. a verse-bridge reshape
// like "1:2" -> "1:2-3" that refParts still reduces to chapter 1 verse 2).
{
  eq(tsvRefMoved({ chapter: 1, verse: 2, ref_raw: "1:2" }, { chapter: 1, verse: 2, refRaw: "1:2-3" }, false), true, "ref_raw-only change detected as a move");
}

// Not a move: identical location -> false (must not withhold the watermark for a
// normal edited row whose reference never changed).
{
  eq(tsvRefMoved({ chapter: 1, verse: 2, ref_raw: "1:2" }, { chapter: 1, verse: 2, refRaw: "1:2" }, false), false, "identical location is not a move");
}

// D1's chapter/verse arrive as strings from the stored row (Record<string,
// unknown>); Number() coercion must not read "1" !== 1 as a move.
{
  eq(tsvRefMoved({ chapter: "1", verse: "2", ref_raw: "1:2" }, { chapter: 1, verse: 2, refRaw: "1:2" }, false), false, "string chapter/verse coerce and compare equal");
}

// A null stored ref_raw normalizes to "" and matches an incoming "" (never a
// spurious move on a blank-ref row).
{
  eq(tsvRefMoved({ chapter: 1, verse: 2, ref_raw: null }, { chapter: 1, verse: 2, refRaw: "" }, false), false, "null stored ref_raw vs empty incoming -> not a move");
}

// Protected row (tn deleted/trashed/preserve/hint) is NEVER a move, even when the
// reference genuinely differs — it is left untouched and kept skipped_edited, so
// returning true would wrongly withhold the watermark forever (see the caller's
// cold-review #1 note in bookReimport.ts).
{
  eq(tsvRefMoved({ chapter: 3, verse: 4, ref_raw: "3:4" }, { chapter: 5, verse: 1, refRaw: "5:1" }, true), false, "protected row is never treated as moved");
}

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nall tsvMerge assertions passed");
