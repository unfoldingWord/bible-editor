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

import {
  classifyTsvRefMove,
  computeTsvMerge,
  foldTsvBase,
  foldTsvRefBase,
  tsvMergeFields,
  tsvRefMoved,
} from "./tsvMerge.ts";

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

console.log("\n[#540 item 2: AI-only master movement never beats a later human app edit]");

// 8a. The same both-moved field, but the commit lineage proved every commit that
// moved master's file since the ancestor was our own export or the note
// pipeline. D1's value stands, and the collision is still reported.
{
  const r = computeTsvMerge(
    "tn",
    { note: "orig" },
    { note: "our edit" },
    { note: "the AI run's note" },
    { masterMayHoldHumanEdit: false },
  );
  eq(r.action, "keep_ai_master", "tn both-moved + no human commit -> keep_ai_master");
  eq(r.conflict, true, "keep_ai_master: still a conflict a human reviews");
  eq(r.adopt, false, "keep_ai_master with nothing else to write: adopt false");
  deep(r.writeFields, {}, "keep_ai_master writes nothing for the contested field");
  deep(r.conflictFields, ["note"], "keep_ai_master still names the contested field");
}

// 8b. A row can hold BOTH a contested field D1 keeps and a field master moved on
// its own. The clean adopt still lands — the policy is about who wins a
// collision, not about refusing master's uncontested work.
{
  const base = { quote: "q0", note: "n0" };
  const ours = { quote: "q0", note: "our note" };
  const theirs = { quote: "q_master", note: "the AI run's note" };
  const r = computeTsvMerge("tn", base, ours, theirs, { masterMayHoldHumanEdit: false });
  eq(r.action, "keep_ai_master", "mixed clean-adopt + kept conflict -> keep_ai_master");
  eq(r.adopt, true, "adopt stays true — there is still a field to write");
  deep(r.writeFields, { quote: "q_master" }, "adopts the uncontested quote, keeps our note");
  deep(r.conflictFields, ["note"], "note is reported as the contested field");
}

// 8c. One-directional, same as the verse side: only a measured `false` flips the
// outcome. `true` and OMITTED both keep master-wins, because
// masterMayHoldHumanEdit() answers true for an incomplete walk and for never
// having looked.
{
  const args = ["tn", { note: "orig" }, { note: "our edit" }, { note: "master edit" }];
  eq(computeTsvMerge(...args).action, "adopt_conflict", "opts omitted -> master still wins");
  eq(computeTsvMerge(...args, {}).action, "adopt_conflict", "empty opts -> master still wins");
  eq(
    computeTsvMerge(...args, { masterMayHoldHumanEdit: true }).action,
    "adopt_conflict",
    "masterMayHoldHumanEdit true -> master still wins",
  );
  eq(
    computeTsvMerge(...args, { masterMayHoldHumanEdit: undefined }).action,
    "adopt_conflict",
    "masterMayHoldHumanEdit undefined -> master still wins",
  );
}

// 8d. Scoped to the collision. A field master moved that we never touched is
// still adopted with no flag at all, whatever the lineage says — that is how
// pipeline work reaches D1.
{
  const r = computeTsvMerge("tn", { note: "orig" }, { note: "orig" }, { note: "master fix" }, {
    masterMayHoldHumanEdit: false,
  });
  eq(r.action, "adopt", "uncontested master edit is still a clean adopt");
  eq(r.conflict, false, "uncontested adopt raises no conflict");
  deep(r.writeFields, { note: "master fix" }, "uncontested adopt still writes master's value");
}

// 8e. And a row with no recoverable ancestor stays keep_no_base: the policy
// resolves an attributed collision, it never invents an attribution.
{
  const r = computeTsvMerge("tn", null, { note: "our edit" }, { note: "master edit" }, {
    masterMayHoldHumanEdit: false,
  });
  eq(r.action, "keep_no_base", "no ancestor -> keep_no_base, not keep_ai_master");
  eq(r.conflict, false, "keep_no_base raises no conflict");
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

// ── classifyTsvRefMove (issue #540 item 3: WHO moved) ───────────────────────
// tsvRefMoved above only says the two sides disagree. Its caller used to read
// that as "Door43 moved it", which is wrong whenever the app moved it — and
// wrong in a way that could not heal: the flag told the translator to undo her
// own move, and the withheld watermark stopped the export from ever publishing
// it, so the same wrong flag returned every night (AMO tq, blocked 2026-08-17).
// These lock the attribution.

// D1 moved, master still at the ancestor -> an ordinary exportable edit.
{
  const base = { chapter: 1, verse: 2, ref_raw: "1:2" };
  eq(
    classifyTsvRefMove({ chapter: 1, verse: 6, ref_raw: "1:6" }, { chapter: 1, verse: 2, refRaw: "1:2" }, base, false),
    "ours_moved",
    "app moved the row, master still at the ancestor -> ours_moved (no flag, no hold)",
  );
}

// Master moved, D1 still at the ancestor -> the out-of-band move (old behavior).
{
  const base = { chapter: 1, verse: 2, ref_raw: "1:2" };
  eq(
    classifyTsvRefMove({ chapter: 1, verse: 2, ref_raw: "1:2" }, { chapter: 1, verse: 6, refRaw: "1:6" }, base, false),
    "theirs_moved",
    "master moved the row, app still at the ancestor -> theirs_moved (flag + hold)",
  );
}

// Both re-anchored, to different places -> a human has to pick.
{
  const base = { chapter: 1, verse: 2, ref_raw: "1:2" };
  eq(
    classifyTsvRefMove({ chapter: 1, verse: 5, ref_raw: "1:5" }, { chapter: 1, verse: 6, refRaw: "1:6" }, base, false),
    "both_moved",
    "both sides moved to different references -> both_moved",
  );
}

// No ancestor -> we may not name a side. Still holds (fail safe), but the
// caller's wording must not claim a Door43 editor did it.
{
  eq(
    classifyTsvRefMove({ chapter: 1, verse: 2, ref_raw: "1:2" }, { chapter: 1, verse: 6, refRaw: "1:6" }, null, false),
    "unattributable",
    "no ancestor -> unattributable, never a guessed side",
  );
}

// The in-app move patch sends ref_raw + verse and never chapter (same-chapter
// moves only, rows.ts), so a base folded from patches carries no `chapter`. That
// must NOT make a same-chapter move unattributable: chapter agrees on both
// sides, so it carries no information about who moved and needs no ancestor.
{
  const base = { verse: 2, ref_raw: "1:2" };
  eq(
    classifyTsvRefMove({ chapter: 1, verse: 6, ref_raw: "1:6" }, { chapter: 1, verse: 2, refRaw: "1:2" }, base, false),
    "ours_moved",
    "same-chapter move stays attributable when the ancestor never recorded chapter",
  );
}

// But a component that DOES differ and has no ancestor value is unattributable.
{
  const base = { verse: 2, ref_raw: "1:2" };
  eq(
    classifyTsvRefMove({ chapter: 1, verse: 2, ref_raw: "1:2" }, { chapter: 5, verse: 2, refRaw: "1:2" }, base, false),
    "unattributable",
    "a differing component the ancestor never recorded -> unattributable",
  );
}

// Agreement short-circuits before the ancestor is consulted at all.
{
  eq(
    classifyTsvRefMove({ chapter: 1, verse: 2, ref_raw: "1:2" }, { chapter: 1, verse: 2, refRaw: "1:2" }, null, false),
    "none",
    "identical references are 'none' even with no ancestor",
  );
}

// Protected rows keep tsvRefMoved's contract: never moved, so never a hold.
{
  eq(
    classifyTsvRefMove({ chapter: 3, verse: 4, ref_raw: "3:4" }, { chapter: 5, verse: 1, refRaw: "5:1" }, null, true),
    "none",
    "protected row is never treated as moved, ancestor or not",
  );
}

// ── foldTsvRefBase ──────────────────────────────────────────────────────────

// Absent means never recorded — not a blank ancestor.
{
  eq(foldTsvRefBase([]), null, "no entries -> null (no reference ancestor)");
  eq(foldTsvRefBase([{ action: "update", payload: { note: "x" } }]), null,
    "content-only history -> null (nothing recorded a reference)");
}

// Non-content actions are skipped, exactly as foldTsvBase skips them.
{
  eq(foldTsvRefBase([{ action: "delete", payload: { chapter: 1, verse: 2, ref_raw: "1:2" } }]), null,
    "a non-content action contributes no reference");
}

// Oldest -> newest overlay: the last recorded value for each component wins,
// and an entry that mentions only some components leaves the rest intact.
{
  const base = foldTsvRefBase([
    { action: "create", payload: { chapter: 1, verse: 2, ref_raw: "1:2" } },
    { action: "update", payload: { verse: 4, ref_raw: "1:4" } },
  ]);
  deep(base, { chapter: 1, verse: 4, ref_raw: "1:4" }, "later patch overlays verse/ref_raw and keeps chapter");
}

// An explicit null ref_raw in a payload is ABSENT, not "". pipelineImport.ts's
// tn hint expansion writes `ref_raw = COALESCE(?5, ref_raw)`, so a payload
// carrying `ref_raw: null` leaves the row's reference UNCHANGED — folding it to
// "" would record an ancestor the row never held, and a wrong ancestor is the
// one thing this fold must never produce.
{
  const base = foldTsvRefBase([{ action: "create", payload: { chapter: 1, verse: 2, ref_raw: null } }]);
  deep(base, { chapter: 1, verse: 2 }, "an explicit null ref_raw is absent, not the empty string");
  // Absent is fail-safe: ref_raw differs between the sides and the ancestor
  // never recorded it, so the move withholds rather than asserting "".
  eq(
    classifyTsvRefMove({ chapter: 1, verse: 2, ref_raw: "1:2" }, { chapter: 1, verse: 2, refRaw: "" }, base, false),
    "unattributable",
    "…so a differing ref_raw with no recorded ancestor withholds",
  );
  // An empty string that was genuinely RECORDED still folds, and a blank-ref row
  // is not a move against its own ancestor.
  const blank = foldTsvRefBase([{ action: "create", payload: { chapter: 1, verse: 2, ref_raw: "" } }]);
  deep(blank, { chapter: 1, verse: 2, ref_raw: "" }, "a recorded empty ref_raw folds as \"\"");
  eq(classifyTsvRefMove({ chapter: 1, verse: 2, ref_raw: null }, { chapter: 1, verse: 2, refRaw: "" }, blank, false),
    "none", "blank-ref row is not a move against its own ancestor");
}

// Only a string counts. Every real writer emits one (bookImport's
// `r["Reference"] ?? ""`, rows.ts's z.string(), ParsedTsvRow's `refRaw: string`),
// so anything else is a shape we have not seen — and String([...]) / String({})
// yield confident nonsense that would compare unequal to both sides and pin the
// row on `both_moved` forever.
{
  for (const [label, value] of [["a number", 5], ["an array", ["1:2"]], ["an object", {}], ["a boolean", true]]) {
    const base = foldTsvRefBase([{ action: "create", payload: { chapter: 1, verse: 2, ref_raw: value } }]);
    eq(base.ref_raw, undefined, `${label} ref_raw is not coerced into the ancestor`);
  }
}

// Both ref_raw spellings really are in production edit_log: bookImport.ts and
// rows.ts write snake_case `ref_raw`, while bookReimport.ts logs a ParsedTsvRow
// verbatim, whose field is camelCase `refRaw`. Reading only one leaves ref_raw
// absent from the ancestor of every reimport-written row, which degrades a
// ref_raw-only reshape to a permanent `unattributable`.
{
  const base = foldTsvRefBase([{ action: "update", payload: { chapter: 1, verse: 2, refRaw: "1:2" } }]);
  deep(base, { chapter: 1, verse: 2, ref_raw: "1:2" }, "camelCase refRaw (ParsedTsvRow, the reimport shape) folds in");
  // The case this rescues: verse unchanged, ref_raw reshaped by the app.
  eq(
    classifyTsvRefMove({ chapter: 1, verse: 2, ref_raw: "1:2-3" }, { chapter: 1, verse: 2, refRaw: "1:2" }, base, false),
    "ours_moved",
    "a ref_raw-only reshape stays attributable against a reimport-written ancestor",
  );
}
{
  // Mixed history: an old snake_case create, then a camelCase reimport update.
  // Newest wins, whichever spelling it used.
  const base = foldTsvRefBase([
    { action: "create", payload: { chapter: 1, verse: 2, ref_raw: "1:2" } },
    { action: "update", payload: { chapter: 1, verse: 5, refRaw: "1:5" } },
  ]);
  deep(base, { chapter: 1, verse: 5, ref_raw: "1:5" }, "mixed-spelling history folds newest-wins");
}

// Verse 0 is a real reference in this repo (chapter-front `front:intro` rows),
// so a recorded 0 must read as PRESENT, never as absent-and-unattributable.
{
  const base = foldTsvRefBase([{ action: "create", payload: { chapter: 0, verse: 0, ref_raw: "front:intro" } }]);
  deep(base, { chapter: 0, verse: 0, ref_raw: "front:intro" }, "a recorded chapter/verse of 0 is present, not absent");
  eq(
    classifyTsvRefMove({ chapter: 0, verse: 0, ref_raw: "front:intro" }, { chapter: 0, verse: 1, refRaw: "front:intro" }, base, false),
    "theirs_moved",
    "verse 0 ancestor attributes a move off it (0 is not treated as missing)",
  );
}

// Cross-book pollution. reconstructTsvBases matches `(book = ? OR book IS
// NULL)`, and prod holds 7,689 tn/tq/twl edit_log rows with a NULL book
// (0017's backfill is best-effort). Row ids are unique only per (book, id), so
// a NULL-book entry can be another book's history landing on this row's id —
// and here it would decide whether the export may overwrite master. An entry we
// cannot prove belongs to this row must not contribute.
{
  const base = foldTsvRefBase([
    { action: "create", payload: { chapter: 1, verse: 2, ref_raw: "1:2" }, bookKnown: true },
    { action: "update", payload: { chapter: 9, verse: 9, ref_raw: "9:9" }, bookKnown: false },
  ]);
  deep(base, { chapter: 1, verse: 2, ref_raw: "1:2" }, "a book-NULL entry does not pollute the reference ancestor");
  eq(
    foldTsvRefBase([{ action: "create", payload: { chapter: 9, verse: 9, ref_raw: "9:9" }, bookKnown: false }]),
    null,
    "a history of only book-NULL entries yields no ancestor (withhold, don't guess)",
  );
  // Callers that don't report it keep working unchanged.
  deep(
    foldTsvRefBase([{ action: "create", payload: { chapter: 1, verse: 2, ref_raw: "1:2" } }]),
    { chapter: 1, verse: 2, ref_raw: "1:2" },
    "an entry with bookKnown unreported still folds (existing callers unchanged)",
  );
}

// Absent-ish values must stay ABSENT, not coerce to 0 — because 0 is a REAL
// reference here (chapter-front `front:intro`). `Number(null)`, `Number("")`,
// `Number(false)` and `Number([])` are all a finite 0, which would turn a
// fail-safe absence into a fail-unsafe wrong ancestor.
{
  for (const [label, value] of [["null", null], ["empty string", ""], ["false", false], ["empty array", []]]) {
    const base = foldTsvRefBase([{ action: "create", payload: { chapter: 1, verse: value, ref_raw: "1:2" } }]);
    eq(base.verse, undefined, `a ${label} verse is absent, not 0`);
    // Absent is the fail-SAFE state: `verse` differs between the two sides and
    // the ancestor never recorded it, so the move is unattributable and holds.
    // Coerced to 0 it would instead read as "the ancestor said verse 0, and D1
    // moved away from it" — a confident, wrong `ours_moved` that lets the
    // export overwrite Door43. That flip is the whole point of the guard.
    eq(
      classifyTsvRefMove({ chapter: 1, verse: 5, ref_raw: "1:5" }, { chapter: 1, verse: 2, refRaw: "1:2" }, base, false),
      "unattributable",
      `…so a ${label} verse withholds instead of asserting a verse-0 ancestor`,
    );
  }
  // A genuine 0 still folds — the two must not be conflated.
  const real = foldTsvRefBase([{ action: "create", payload: { chapter: 0, verse: 0, ref_raw: "front:intro" } }]);
  eq(real.verse, 0, "a genuine verse 0 folds in as 0");
}

// Numbers arrive as strings from some writer shapes; a non-numeric value is
// dropped rather than folded in as NaN (NaN compares unequal to everything and
// would manufacture a permanent unattributable).
{
  const base = foldTsvRefBase([{ action: "create", payload: { chapter: "1", verse: "2", ref_raw: "1:2" } }]);
  deep(base, { chapter: 1, verse: 2, ref_raw: "1:2" }, "string chapter/verse coerce to numbers");
  const junk = foldTsvRefBase([{ action: "create", payload: { chapter: "front", verse: 2, ref_raw: "front:intro" } }]);
  deep(junk, { verse: 2, ref_raw: "front:intro" }, "a non-numeric chapter is dropped, not folded in as NaN");
}

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nall tsvMerge assertions passed");
