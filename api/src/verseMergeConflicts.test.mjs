// Regression tests for the 2026-08-14 prod-audit fixes in
// verseMergeConflicts.ts / verses.ts, plus the follow-on fixes from the
// independent six-angle review of the first version of this PR:
//
//   DEFECT 1 (wrong audience) — the merge-conflict banner alert only ever
//   reached the admin (ALERT_USERNAME); the editors whose work was actually
//   overwritten never learned about it. Fixed by attributing each
//   'adopt_conflict' overwrite to the human who authored the replaced
//   version (via edit_log) and giving them their own system_alerts row.
//
//   DEFECT 2 (self-destructing evidence) — verses.ts's PATCH route used to
//   DELETE the verse_merge_conflicts row the instant a human re-saved the
//   flagged verse, erasing the audit trail (and the overwritten_version
//   recovery pointer) as people fixed their own overwritten work. Fixed by
//   marking resolved_at/resolved_by (migration 0049) instead, and filtering
//   "active" reads on resolved_at IS NULL.
//
//   REVIEW FIX 1 (re-detection invisibility, six-angle review) — the upsert
//   never reset resolved_at/resolved_by, so a verse that was resolved and
//   then genuinely conflicted AGAIN stayed invisible to every "active"
//   reader forever.
//
//   REVIEW FIX 3 (lost-adoption cleanup destroying audit rows, six-angle
//   review) — deleteLostAdoptionConflicts used to hard-delete
//   unconditionally; scoped so it can't destroy a row's prior (possibly
//   resolved) history just because a LATER, separate attempt on the same
//   verse lost its CAS race.
//
//   REVIEW FIX 6 (dismissal stickiness, six-angle review) — the alert was
//   unconditionally deleted-then-reinserted every run, so a dismissed alert
//   reappeared the very next run even with nothing new to report.
//
//   CODEX FIX (second-opinion review, supersedes the FIRST version of FIX 1
//   above) — that first version cleared resolved_at/resolved_by EAGERLY in
//   the speculative upsert, before the master-adoption CAS write even ran.
//   Codex found the real bug: if a verse carried an OLD, human-resolved
//   conflict, and this run's speculative adopt_conflict upsert cleared
//   resolved_at, but the CAS then LOST its race (nothing was actually
//   overwritten), the row was left FALSELY reactivated — an active alert for
//   an overwrite that never happened, with the original resolution's audit
//   trail destroyed. Fixed with two-phase reactivation: the speculative
//   upsert (UPSERT_VERSE_MERGE_CONFLICT_SQL) never touches
//   resolved_at/resolved_by at all; only confirmAdoptedConflicts
//   (CONFIRM_ADOPTED_CONFLICT_SQL), called AFTER the CAS batch confirms which
//   adoptions actually landed, clears them. A new last_recorded_at column
//   (separate from detected_at, which keeps its original "age of the
//   unresolved streak" meaning) lets deleteLostAdoptionConflicts recognize
//   "this row was touched by THIS run's speculative write" without needing
//   detected_at to double as that signal.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/verseMergeConflicts.test.mjs
//
// Not a test framework; a failed assert exits non-zero. Mirrors
// blankStubTrash.test.mjs's real-SQLite pattern for the parts that are pure
// SQL, and tests the pure grouping logic directly (no D1 needed) — same
// split as chapterLock.test.mjs.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { reviewConditionKey, verseMergeEditorConditionKey } from "./reviewAlerts.ts";
import {
  confirmAdoptedConflicts,
  deleteLostAdoptionConflicts,
  raiseVerseMergeConflictAlert,
  recordVerseMergeConflicts,
  resolveConvergedVerseMergeConflicts,
  retireVerseKeptAiMasterFlags,
  rollBackDeadAttemptConflicts,
  settleLandedConflictStmt,
} from "./verseMergeConflicts.ts";
import {
  alertMessageCarriesNoBaseWarning,
  buildEditorLookupQuery,
  buildGroupedRefsClause,
  buildMergeConflictGuidance,
  buildNoBaseSentence,
  EDITOR_LOOKUP_CHUNK,
  editLogKey,
  groupNoBaseVersesByEditor,
  groupOverwrittenVersesByEditor,
  MERGE_CONFLICT_REFS_DISPLAY,
  NO_BASE_ADMIN_FINGERPRINT,
  NO_BASE_REF_DISPLAY,
  planSystemAlertWrites,
} from "./verseMergeEditorAlerts.ts";
import {
  CONFIRM_ADOPTED_CONFLICT_SQL,
  DELETE_SPECULATIVE_CONFLICTS_SQL,
  RESTORE_SPECULATIVE_CONFLICTS_SQL,
  SETTLE_SPECULATIVE_CONFLICTS_SQL,
  RESOLVE_VERSE_MERGE_CONFLICT_SQL,
  CLEAR_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL,
  CLEAR_CONFLICT_ONLY_ALERTS_BY_USER_SQL,
  RETIRE_KEPT_AI_MASTER_CONFLICTS_SQL,
  SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL,
  SELECT_STANDING_KEPT_AI_MASTER_CONFLICT_PAIRS_SQL,
  UPSERT_VERSE_MERGE_CONFLICT_SQL,
  VERSE_PATCH_UPDATE_SQL,
} from "./verseMergeConflictSql.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Part 1: groupOverwrittenVersesByEditor — pure, no D1.
// ─────────────────────────────────────────────────────────────────────────

{
  // Two verses attributed to the same editor combine into one alert.
  const overwritten = [
    { chapter: 1, verse: 2, overwrittenVersion: 3 },
    { chapter: 1, verse: 5, overwrittenVersion: 7 },
  ];
  const usernameByKey = new Map([
    [editLogKey("ZEC", "ult", overwritten[0]), "bethoakes"],
    [editLogKey("ZEC", "ult", overwritten[1]), "bethoakes"],
  ]);
  const grouped = groupOverwrittenVersesByEditor("ZEC", "ult", overwritten, usernameByKey);
  assert(grouped.size === 1, "two verses, one editor -> one alert entry");
  const entry = grouped.get("bethoakes");
  assert(!!entry, "keyed by username");
  assert(entry.refs.length === 2, "both refs collected");
  assert(entry.refs.includes("1:2@v3") && entry.refs.includes("1:5@v7"), "refs carry chapter:verse@version");
  assert(entry.message.includes("ZEC"), "message names the book");
  assert(entry.message.includes("ULT"), "message names the resource, uppercased");
  assert(entry.message.includes("2 verse(s)"), "message states the count");
  // REVIEW FIX 4: this fires from both the 05:30 UTC cron AND the
  // user-triggered POST /:book/reimport route — "nightly" overclaims the
  // trigger on the latter, the same overclaim the admin message's own
  // "FIX I" already corrected.
  assert(!entry.message.includes("nightly"), "does not overclaim a nightly-only trigger");
  assert(entry.message.includes("Door43's sync"), "says \"sync\", not \"nightly sync\"");
}

{
  // Two different editors get two separate alert entries, not merged.
  const overwritten = [
    { chapter: 2, verse: 1, overwrittenVersion: 4 },
    { chapter: 3, verse: 9, overwrittenVersion: 2 },
  ];
  const usernameByKey = new Map([
    [editLogKey("HOS", "ust", overwritten[0]), "pjoakes"],
    [editLogKey("HOS", "ust", overwritten[1]), "Carolyn1970"],
  ]);
  const grouped = groupOverwrittenVersesByEditor("HOS", "ust", overwritten, usernameByKey);
  assert(grouped.size === 2, "two editors -> two alert entries");
  assert(grouped.get("pjoakes").refs.length === 1, "pjoakes gets only their own verse");
  assert(grouped.get("Carolyn1970").refs.length === 1, "Carolyn1970 gets only their own verse");
}

{
  // A verse with no matching edit_log user (AI edit, or ancestor aged out of
  // the 180-day sweep) is silently excluded — there is no human to alert.
  const overwritten = [{ chapter: 4, verse: 4, overwrittenVersion: 1 }];
  const grouped = groupOverwrittenVersesByEditor("MIC", "ult", overwritten, new Map());
  assert(grouped.size === 0, "no username found -> no alert entry (not a crash, not a blank-username alert)");
}

{
  // Issue #633 / #788: name what differs. Wording/punctuation are text-side
  // recovery; alignment-only must not claim the words were replaced.
  const wordingOnly = [{ chapter: 40, verse: 5, overwrittenVersion: 8, reason: "both_changed_wording" }];
  const punctuationOnly = [{ chapter: 40, verse: 6, overwrittenVersion: 9, reason: "both_changed_punctuation" }];
  const alignmentOnly = [{ chapter: 41, verse: 6, overwrittenVersion: 5, reason: "both_changed_alignment" }];
  const allAxes = [{ chapter: 40, verse: 10, overwrittenVersion: 6, reason: "both_changed_wording_punctuation_alignment" }];
  const keyW = editLogKey("JER", "ult", wordingOnly[0]);
  const keyP = editLogKey("JER", "ult", punctuationOnly[0]);
  const keyA = editLogKey("JER", "ult", alignmentOnly[0]);
  const keyB = editLogKey("JER", "ult", allAxes[0]);
  const users = new Map([
    [keyW, "translator"],
    [keyP, "translator"],
    [keyA, "translator"],
    [keyB, "translator"],
  ]);

  const wMsg = groupOverwrittenVersesByEditor("JER", "ult", wordingOnly, users).get("translator").message;
  assert(wMsg.includes("The wording changed."), "wording-only names wording");
  assert(wMsg.includes("replaced text is still recoverable"), "wording-only still points at text recovery");
  assert(!wMsg.includes("re-save"), "overwrite alert never tells the editor to re-save");

  const pMsg = groupOverwrittenVersesByEditor("JER", "ult", punctuationOnly, users).get("translator").message;
  assert(pMsg.includes("The punctuation changed (the wording did not)."), "punctuation-only names punctuation, not wording");
  assert(pMsg.includes("previous punctuation is still recoverable"), "punctuation-only points at punctuation recovery");

  const aMsg = groupOverwrittenVersesByEditor("JER", "ult", alignmentOnly, users).get("translator").message;
  assert(aMsg.includes("The alignment changed (the wording and punctuation did not)."), "alignment-only names alignment");
  assert(aMsg.includes("previous alignment is still recoverable"), "alignment-only recovers alignment, not 'replaced text'");
  assert(!aMsg.includes("replaced text"), "alignment-only must not claim the words were replaced");
  assert(!aMsg.includes("re-save"), "alignment-only never tells the editor to re-save");

  const bMsg = groupOverwrittenVersesByEditor("JER", "ult", allAxes, users).get("translator").message;
  assert(bMsg.includes("The wording, punctuation, and alignment changed."), "all axes name all three");
}

{
  // Issue #633 / #788 admin guidance: same text-side vs alignment distinction.
  // overwrittenVersion is a real pointer in each case: all of these are
  // overwrites that actually replaced text (see the #981 block below for the
  // pointer-less case).
  const w = buildMergeConflictGuidance([{ action: "adopt_conflict", reason: "both_changed_wording", overwrittenVersion: 1 }]);
  assert(w.includes("The wording changed."), "admin wording-only names wording");
  assert(w.includes("replaced text is still"), "admin wording-only keeps text recovery");

  const p = buildMergeConflictGuidance([{ action: "adopt_conflict", reason: "both_changed_punctuation", overwrittenVersion: 1 }]);
  assert(p.includes("The punctuation changed (the wording did not)."), "admin punctuation-only names punctuation");
  assert(p.includes("previous punctuation is still"), "admin punctuation-only keeps punctuation recovery");

  const a = buildMergeConflictGuidance([{ action: "adopt_conflict", reason: "both_changed_alignment", overwrittenVersion: 1 }]);
  assert(a.includes("The alignment changed (the wording and punctuation did not)."), "admin alignment-only names alignment");
  assert(a.includes("previous alignment is still"), "admin alignment-only recovers alignment");
  assert(!a.includes("replaced text"), "admin alignment-only must not claim replaced text");

  const legacy = buildMergeConflictGuidance([{ action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 1 }]);
  assert(legacy.includes("The wording and alignment changed."), "legacy both_changed keeps its original two-axis meaning");
  assert(!legacy.includes("punctuation"), "legacy both_changed does not invent a punctuation claim");

  const prototypeKey = buildMergeConflictGuidance([{ action: "adopt_conflict", reason: "__proto__", overwrittenVersion: 1 }]);
  assert(prototypeKey.includes("The wording and alignment changed."), "prototype-key reason takes the fail-safe warning");

  // adopt_no_visible_change is not alertable — if it somehow reached guidance
  // it is not an adopt_conflict, so it must not count as an overwrite.
  const silent = buildMergeConflictGuidance([{ action: "adopt_no_visible_change", reason: "both_changed_no_visible", overwrittenVersion: null }]);
  assert(!silent.includes("took Door43's version"), "no-visible-change action is not an overwrite sentence");
}

{
  // Issue #981: the #539 no-op guard (bookReimport.ts ~7609-7674) keeps a
  // conflicted byte no-op as `adopt_conflict` with `overwrittenVersion`
  // cleared to null, so the review banner still lists it. Per that guard's
  // own comment, a surviving pointer-less row is never "D1 already matched
  // Door43" — #977 already drops the case where master's arriving bytes
  // differ from D1 only in Hebrew mark order, so a row that gets here had
  // master's bytes differ from D1 by more; the final match happens because
  // canonizeAlignmentSource (canonizeHebrew.ts) maps master's \zaln-s
  // content/lemma onto D1's bytes. That mapping falls through looser tiers
  // too (stripped marks, word-joiner fold), so master's incoming copy could
  // be the WORSE one (under-pointed, cantillation-stripped, an older UHB
  // alignment) — the admin sentence must not call this an overwrite, must
  // not point at a missing @v, must not claim D1 already matched Door43, and
  // (2026-10-02 sweep, round 2) must NOT assert which side is right either:
  // no "Door43's fix" / D1's "stale" bytes framing, just that the two copies
  // differ on \zaln-s content/lemma and a human has to judge which is right.
  const pointerless = buildMergeConflictGuidance([
    { action: "adopt_conflict", reason: "both_changed", overwrittenVersion: null, chapter: 3, verse: 4 },
  ]);
  assert(!pointerless.includes("took Door43's version over the editor's"), "pointer-less adopt_conflict is not an overwrite");
  assert(
    !pointerless.includes("the version number given after @v"),
    "pointer-less adopt_conflict does not claim a recovery version number exists",
  );
  assert(!pointerless.includes("D1 already matched Door43"), "pointer-less adopt_conflict must not claim D1 already matched Door43");
  assert(!pointerless.includes("Door43's fix"), "pointer-less adopt_conflict must not assume Door43 holds the correct side");
  assert(!pointerless.includes("stale"), "pointer-less adopt_conflict must not assume D1 holds the stale side");
  assert(!pointerless.includes("morphology"), "pointer-less adopt_conflict must not claim morph changed — canonizeAlignmentSource only rewrites content/lemma");
  assert(
    pointerless.includes(
      "1 was flagged for review but no app text was replaced (3:4) — Door43's copy differs from the app's " +
        "only in the original-language source attributes on \\zaln-s (x-content / x-lemma)",
    ),
    "pointer-less adopt_conflict states only what was measured, naming its OWN ref (3:4) inline",
  );
  assert(pointerless.includes("check which side is right"), "pointer-less adopt_conflict leaves the judgment call to a human");

  // Issue #981, round 3: "the ref above with no @v" does not uniquely pick
  // out a pointer-less adopt_conflict row — keep_alignment_refused /
  // source_attr_divergent / keep_local_structure rows are stored with
  // overwritten_version NULL too (verseMergeConflictSql.ts's
  // SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL), so buildGroupedRefsClause prints
  // THEM without @v as well. A keep_alignment_refused ref sitting beside a
  // pointer-less adopt_conflict ref must not be swept into "Door43's copy
  // differs only in source attributes" — that's a live, unresolved Door43
  // change, not a source-attribute no-op.
  const ambiguous = buildMergeConflictGuidance([
    { action: "adopt_conflict", reason: "both_changed", overwrittenVersion: null, chapter: 3, verse: 4 },
    { action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null, chapter: 5, verse: 2 },
  ]);
  assert(
    ambiguous.includes("no app text was replaced (3:4)"),
    "the pointer-less clause names only its own ref (3:4), not the keep_alignment_refused ref beside it",
  );
  assert(
    !ambiguous.includes("5:2) —") && !/\(3:4, 5:2\)/.test(ambiguous),
    "5:2 (a live kept-alignment refusal) must never be folded into the source-attributes-only clause",
  );

  // A row WITH a pointer still reads as an overwrite and still gives the @v
  // recovery sentence, even mixed with a pointer-less row in the same run.
  const mixed = buildMergeConflictGuidance([
    { action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 4, chapter: 1, verse: 1 },
    { action: "adopt_conflict", reason: "both_changed", overwrittenVersion: null, chapter: 3, verse: 4 },
  ]);
  assert(mixed.includes("1 took Door43's version over the editor's"), "pointered row still counts as an overwrite");
  assert(mixed.includes("at the version number given after @v in its ref above"), "pointered row keeps its @v recovery sentence");
  assert(
    mixed.includes("1 was flagged for review but no app text was replaced (3:4)"),
    "pointer-less row in the same run still gets its own clause, naming only its own ref",
  );

  // Plural agreement: two pointer-less rows read "were", list both refs, and
  // cap/"+N more" like the shared ref clause does.
  const twoPointerless = buildMergeConflictGuidance([
    { action: "adopt_conflict", reason: "both_changed", overwrittenVersion: null, chapter: 3, verse: 4 },
    { action: "adopt_conflict", reason: "both_changed", overwrittenVersion: null, chapter: 6, verse: 1 },
  ]);
  assert(
    twoPointerless.includes("2 were flagged for review but no app text was replaced (3:4, 6:1) —"),
    "two pointer-less rows agree as 'were' and list both their own refs",
  );

  // overwrittenVersion omitted entirely (an untyped caller) reads the same as
  // an explicit null — loose equality, matching buildGroupedRefsClause's own
  // `!= null` convention, so an untyped row never silently becomes an
  // overwrite it cannot point a @v at. No chapter/verse here either: the ref
  // clause degrades to naming no refs rather than guessing.
  const omitted = buildMergeConflictGuidance([{ action: "adopt_conflict", reason: "both_changed" }]);
  assert(!omitted.includes("took Door43's version over the editor's"), "omitted overwrittenVersion is treated as pointer-less, not as an overwrite");
  assert(omitted.includes("1 was flagged for review but no app text was replaced"), "omitted overwrittenVersion gets the pointer-less clause");
}

{
  // Same chapter:verse in two different books/resources must not collide —
  // editLogKey must be scoped by book+resource, not just chapter/verse.
  const a = { chapter: 1, verse: 1, overwrittenVersion: 2 };
  const b = { chapter: 1, verse: 1, overwrittenVersion: 2 };
  assert(editLogKey("ZEC", "ult", a) !== editLogKey("HOS", "ult", b), "different book -> different key");
  assert(editLogKey("ZEC", "ult", a) !== editLogKey("ZEC", "ust", b), "different resource -> different key");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 1b: groupNoBaseVersesByEditor (issue #544) — pure, no D1. The
// keep_no_base analogue of groupOverwrittenVersesByEditor above: NOTHING was
// overwritten, so the message must never claim otherwise, and the refs carry
// no "@vN" (there is no replaced version to point a reader at).
// ─────────────────────────────────────────────────────────────────────────

{
  // Two verses attributed to the same editor combine into one alert, keyed
  // off their CURRENT version (not an overwrittenVersion — nothing was
  // overwritten).
  const noBase = [
    { chapter: 1, verse: 2, version: 3 },
    { chapter: 1, verse: 5, version: 7 },
  ];
  const usernameByKey = new Map([
    [editLogKey("ZEC", "ult", { chapter: 1, verse: 2, overwrittenVersion: 3 }), "bethoakes"],
    [editLogKey("ZEC", "ult", { chapter: 1, verse: 5, overwrittenVersion: 7 }), "bethoakes"],
  ]);
  const grouped = groupNoBaseVersesByEditor("ZEC", "ult", noBase, usernameByKey);
  assert(grouped.size === 1, "two verses, one editor -> one alert entry");
  const entry = grouped.get("bethoakes");
  assert(!!entry, "keyed by username");
  assert(entry.refs.length === 2, "both refs collected");
  assert(entry.refs.includes("1:2") && entry.refs.includes("1:5"), "refs carry bare chapter:verse");
  assert(!entry.refs.some((r) => r.includes("@v")), "…and never an '@vN' suffix — nothing was overwritten");
  assert(entry.message.includes("ZEC"), "message names the book");
  assert(entry.message.includes("ULT"), "message names the resource, uppercased");
  assert(entry.message.includes("2 verse(s)"), "message states the count");
  assert(!/overwr(itten|ote|ites)/i.test(entry.message.replace("Nothing has been overwritten", "")),
    "message never claims an overwrite happened, aside from explicitly denying one");
  assert(entry.message.includes("Nothing has been overwritten"), "message explicitly denies an overwrite");
  assert(!entry.message.includes("nightly"), "does not overclaim a nightly-only trigger");
  assert(entry.message.includes("Door43's sync"), 'says "sync", not "nightly sync"');
}

{
  // Two different editors get two separate alert entries, not merged.
  const noBase = [
    { chapter: 2, verse: 1, version: 4 },
    { chapter: 3, verse: 9, version: 2 },
  ];
  const usernameByKey = new Map([
    [editLogKey("HOS", "ust", { chapter: 2, verse: 1, overwrittenVersion: 4 }), "pjoakes"],
    [editLogKey("HOS", "ust", { chapter: 3, verse: 9, overwrittenVersion: 2 }), "Carolyn1970"],
  ]);
  const grouped = groupNoBaseVersesByEditor("HOS", "ust", noBase, usernameByKey);
  assert(grouped.size === 2, "two editors -> two alert entries");
  assert(grouped.get("pjoakes").refs.length === 1, "pjoakes gets only their own verse");
  assert(grouped.get("Carolyn1970").refs.length === 1, "Carolyn1970 gets only their own verse");
}

{
  // No matching edit_log user (an AI edit, or the ancestor aged out) -> no
  // alert entry, the same silent-exclusion behavior as the overwritten case.
  const noBase = [{ chapter: 4, verse: 4, version: 1 }];
  const grouped = groupNoBaseVersesByEditor("MIC", "ult", noBase, new Map());
  assert(grouped.size === 0, "no username found -> no alert entry");
}

{
  // Issue #1006 (ZEC UST 1:6, system_alerts 1305). A locked book is skipped by
  // the export (exportWorkflow.ts, `book_locked:*`), so the translator's
  // keep_no_base alert must not claim tonight's export will overwrite their
  // text, and must not name re-saving as the remedy: a locked book's verses
  // cannot be saved here, and nothing from it is exported anyway.
  const noBase = [{ chapter: 1, verse: 6, version: 2 }];
  const usernameByKey = new Map([
    [editLogKey("ZEC", "ust", { chapter: 1, verse: 6, overwrittenVersion: 2 }), "deferredreward"],
  ]);
  const locked = groupNoBaseVersesByEditor("ZEC", "ust", noBase, usernameByKey, true).get("deferredreward");
  assert(!!locked, "locked book: the editor is still told about the verse");
  assert(!/tonight's export/i.test(locked.message), "locked book: no claim that tonight's export overwrites anything");
  assert(!/re-?sav/i.test(locked.message), "locked book: re-saving is not named as the remedy");
  assert(/locked/i.test(locked.message), "locked book: says the book is locked");
  assert(/admin/i.test(locked.message), "locked book: names asking an admin as the remedy");
  assert(locked.message.includes("Nothing has been overwritten"), "locked book: still denies an overwrite");
  assert(alertMessageCarriesNoBaseWarning(locked.message), "locked book: keeps the no-base fingerprint");
  assert(locked.message.includes("ZEC UST: 1:6"), "locked book: still names the verse");

  // Unlocked wording is unchanged, byte for byte, whether the flag is omitted
  // or passed false.
  const unlockedText =
    "Door43's sync could not tell whether your edit or a Door43-side edit is newer, for 1 verse(s) you last " +
    "edited in ZEC UST: 1:6 — no earlier version was recoverable to compare against, so it kept your version " +
    "for now. Nothing has been overwritten — but if Door43 has changed it since, tonight's export will still " +
    "overwrite your text there unless you open and re-save the verse here first.";
  const omitted = groupNoBaseVersesByEditor("ZEC", "ust", noBase, usernameByKey).get("deferredreward");
  const explicit = groupNoBaseVersesByEditor("ZEC", "ust", noBase, usernameByKey, false).get("deferredreward");
  assert(omitted.message === unlockedText, "unlocked (flag omitted): wording unchanged");
  assert(explicit.message === unlockedText, "unlocked (flag false): wording unchanged");
}

{
  // Issue #1006, admin side: buildNoBaseSentence / buildMergeConflictGuidance
  // carry the same false "tonight's export" claim for a locked book.
  const locked = buildMergeConflictGuidance([], { noBaseCount: 1, noBaseRefs: ["1:6"], noBaseBookLocked: true });
  assert(!/tonight's export/i.test(locked), "locked book (admin): no claim that tonight's export overwrites anything");
  assert(!/re-?sav/i.test(locked), "locked book (admin): re-saving is not named as the remedy");
  assert(/locked/i.test(locked), "locked book (admin): says the book is locked");
  assert(/admin/i.test(locked), "locked book (admin): says an admin reconciles it");
  assert(locked.includes("Nothing was overwritten"), "locked book (admin): still denies an overwrite");
  assert(locked.includes("Verses (sample): 1:6."), "locked book (admin): still names the verse");
  assert(locked.includes(NO_BASE_ADMIN_FINGERPRINT), "locked book (admin): keeps the no-base fingerprint");
  assert(buildNoBaseSentence(1, ["1:6"], true) === locked, "the guidance passes the lock through to buildNoBaseSentence");

  const unlockedText =
    "1 verse(s) could not be adjudicated: no ancestor was recoverable for them from before this book+resource's " +
    "master-confirmed watermark, so the sync could not tell which side changed, and so it kept the app's " +
    "version. Verses (sample): 1:6. Nothing was overwritten in these — but a Door43-side change to them will " +
    "still be overwritten by tonight's export.";
  assert(buildNoBaseSentence(1, ["1:6"]) === unlockedText, "unlocked (flag omitted): admin wording unchanged");
  assert(buildNoBaseSentence(1, ["1:6"], false) === unlockedText, "unlocked (flag false): admin wording unchanged");
  assert(
    buildMergeConflictGuidance([], { noBaseCount: 1, noBaseRefs: ["1:6"], noBaseBookLocked: false }) === unlockedText,
    "unlocked guidance: wording unchanged",
  );
}

{
  // Issue #1110: on a locked book with keep_no_base AND kept rows
  // (keep_alignment_refused, source_attr_divergent), #1006's "the export skips
  // it" sentence sat beside older sentences that still said tonight's export
  // will write. A locked book is not exported, so none may say so.
  const rows = [
    { action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null, chapter: 1, verse: 8 },
    { action: "source_attr_divergent", reason: "source_attr_ambiguous", overwrittenVersion: null, chapter: 1, verse: 9 },
  ];
  const opts = { noBaseCount: 1, noBaseRefs: ["1:6"] };
  const locked = buildMergeConflictGuidance(rows, { ...opts, noBaseBookLocked: true, bookLocked: true });
  assert(!/tonight's export/i.test(locked), `locked book (kept rows + no-base): no sentence claims tonight's export writes (got: ${locked})`);
  assert(locked.includes("1 kept the editor's version because adopting Door43's would have cost alignment"),
    "locked book: the alignment-refused verse is still reported");
  assert(locked.includes("1 kept D1 because Door43's original-language source fix"),
    "locked book: the source-attr verse is still reported");
  assert((locked.match(/this book is locked/g) ?? []).length === 3, "locked book: each kept sentence names the lock");

  // Unlocked: byte-identical to the wording before this change.
  const unlockedText =
    "1 kept the editor's version because adopting Door43's would have cost alignment — Door43's change has NOT " +
    "been taken, so tonight's export will still write over it until someone resolves it. 1 kept D1 because " +
    "Door43's original-language source fix (the spelling/pointing/morphology on \\zaln-s) could not be placed " +
    "unambiguously — the same source word repeats in the verse — so Door43's change has NOT been taken, and " +
    "tonight's export will write over it until someone resolves it by hand. " +
    buildNoBaseSentence(1, ["1:6"]);
  assert(buildMergeConflictGuidance(rows, opts) === unlockedText, "unlocked (flags omitted): kept wording unchanged");
  assert(
    buildMergeConflictGuidance(rows, { ...opts, noBaseBookLocked: false, bookLocked: false }) === unlockedText,
    "unlocked (flags false): kept wording unchanged",
  );
}

{
  // Issue #1110 review (A3): the pointer-less adopt_conflict and the two
  // keep_local_structure sentences also promised the next export would write
  // over Door43. A locked book is skipped by the export, so none may say so.
  const rows = [
    { action: "adopt_conflict", reason: "source_attr_only", overwrittenVersion: null, chapter: 2, verse: 1 },
    { action: "keep_local_structure", reason: "no_human_commit", overwrittenVersion: null, chapter: 2, verse: 2 },
    { action: "keep_local_structure", reason: "master_moved_under_local_bridge", overwrittenVersion: null, chapter: 2, verse: 3 },
  ];
  const locked = buildMergeConflictGuidance(rows, { bookLocked: true });
  assert(!/next export|tonight's export|will write|written over|writes the app's/i.test(locked),
    `locked book (pointer-less + structure rows): no sentence claims an export will write (got: ${locked})`);
  assert((locked.match(/this book is locked/g) ?? []).length === 3, "locked book: each of the three sentences names the lock");
  assert(locked.includes("1 was flagged for review but no app text was replaced (2:1)"), "locked book: the pointer-less verse is still named");
  assert(locked.includes("1 kept the app's verse grouping"), "locked book: the kept grouping is still reported");
  assert(locked.includes("1 verse(s) changed on Door43 that a bridge made in the app"), "locked book: the absorbed verse is still reported");

  const unlockedText =
    "1 was flagged for review but no app text was replaced (2:1) — Door43's copy differs from the app's only in the " +
    "original-language source attributes on \\zaln-s (x-content / x-lemma); check which side is right before the " +
    "next export, because the export will write the app's attributes over Door43's. 1 kept the app's verse " +
    "grouping (a \\v a-b bridge, or its split) where Door43 now groups the verses differently: either no commit " +
    "from a Door43 editor's own account was found behind Door43's change, or the two groupings could not be " +
    "reconciled automatically. Door43's grouping has NOT been taken, so the next export that runs for this " +
    "resource writes the app's grouping over it. 1 verse(s) changed on Door43 that a bridge made in the app (not " +
    "yet exported) has since absorbed — the next export publishes the bridge, and Door43's change to that verse's " +
    "own text will be written over unless it is carried into the bridged verse first.";
  assert(buildMergeConflictGuidance(rows) === unlockedText, "unlocked (flag omitted): wording unchanged");
  assert(buildMergeConflictGuidance(rows, { bookLocked: false }) === unlockedText, "unlocked (flag false): wording unchanged");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 2: the ACTUAL production query (buildEditorLookupQuery, imported
// above — not a hand-duplicated copy, so this can't silently drift from what
// verseMergeConflicts.ts's lookupEditorUsernames really sends to D1), run
// against real SQLite. The concatenated `row_key || ':' || new_version` match
// is a tuple-IN() workaround — if it were done as two separate
// `row_key IN (...)` / `new_version IN (...)` clauses instead, a same-verse
// row at a DIFFERENT version would falsely match. This proves the real query
// doesn't regress to that.
// ─────────────────────────────────────────────────────────────────────────

function setupDb() {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, dcs_username TEXT)`);
  d.exec(`CREATE TABLE edit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, row_key TEXT, book TEXT,
    user_id INTEGER, prev_version INTEGER, new_version INTEGER, action TEXT
  )`);
  return d;
}

{
  const d = setupDb();
  d.prepare(`INSERT INTO users (id, dcs_username) VALUES (1, 'bethoakes'), (2, 'pjoakes')`).run();
  // Two edit_log rows for the SAME verse at DIFFERENT versions, by DIFFERENT
  // users — the exact shape a cross-product WHERE would confuse.
  d.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES
       ('verse', 'ZEC/1/2/ULT', 'ZEC', 1, 3, 'update'),
       ('verse', 'ZEC/1/2/ULT', 'ZEC', 2, 4, 'update')`,
  ).run();

  {
    const ref = { chapter: 1, verse: 2, overwrittenVersion: 3 };
    const { sql, keys } = buildEditorLookupQuery("ZEC", "ult", [ref]);
    const rows = d.prepare(sql).all("ZEC", ...keys);
    assert(rows.length === 1, "exact (verse, version) match returns exactly one row");
    assert(rows[0].username === "bethoakes", "matches the author of v3, not the author of v4");
  }
  {
    const ref4 = { chapter: 1, verse: 2, overwrittenVersion: 4 };
    const { sql, keys } = buildEditorLookupQuery("ZEC", "ult", [ref4]);
    const rows4 = d.prepare(sql).all("ZEC", ...keys);
    assert(rows4.length === 1 && rows4[0].username === "pjoakes", "the other version resolves to the other author");
  }
}

{
  // A verse with no user_id (e.g. an import-time row) must not surface as a
  // false match via the JOIN — INNER JOIN on a NULL user_id finds no user row.
  const d = setupDb();
  d.prepare(`INSERT INTO users (id, dcs_username) VALUES (1, 'bethoakes')`).run();
  d.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action)
     VALUES ('verse', 'ZEC/1/3/ULT', 'ZEC', NULL, 1, 'create')`,
  ).run();
  const ref = { chapter: 1, verse: 3, overwrittenVersion: 1 };
  const { sql, keys } = buildEditorLookupQuery("ZEC", "ult", [ref]);
  const rows = d.prepare(sql).all("ZEC", ...keys);
  assert(rows.length === 0, "NULL user_id (no human author) -> no editor alert row, not a crash");
}

{
  // Multiple verses in one query (the real batched shape) each resolve to
  // their own correct author, not to each other.
  const d = setupDb();
  d.prepare(`INSERT INTO users (id, dcs_username) VALUES (1, 'bethoakes'), (2, 'Grant_Ailie')`).run();
  d.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES
       ('verse', 'ZEC/1/2/ULT', 'ZEC', 1, 3, 'update'),
       ('verse', 'ZEC/2/5/ULT', 'ZEC', 2, 6, 'update')`,
  ).run();
  const refs = [
    { chapter: 1, verse: 2, overwrittenVersion: 3 },
    { chapter: 2, verse: 5, overwrittenVersion: 6 },
  ];
  const { sql, keys } = buildEditorLookupQuery("ZEC", "ult", refs);
  const rows = d.prepare(sql).all("ZEC", ...keys);
  const byKey = new Map(rows.map((r) => [r.key, r.username]));
  assert(byKey.get(keys[0]) === "bethoakes", "first verse -> its own author");
  assert(byKey.get(keys[1]) === "Grant_Ailie", "second verse -> its own author");
}

{
  // The bind-parameter budget itself: D1 caps a prepared statement at 100
  // bind vars, and this query binds `book` + one key per ref. At
  // EDITOR_LOOKUP_CHUNK refs (90), total binds must stay comfortably under
  // that cap — this is the guard that lookupEditorUsernames's chunking loop
  // exists to enforce (a "1CH-scale" run has hit 174 verses in one night in
  // this codebase's own history, well past the un-chunked limit).
  const refs = Array.from({ length: EDITOR_LOOKUP_CHUNK }, (_, i) => ({
    chapter: 1,
    verse: i + 1,
    overwrittenVersion: 1,
  }));
  const { keys } = buildEditorLookupQuery("ZEC", "ult", refs);
  assert(keys.length === EDITOR_LOOKUP_CHUNK, "one key per ref");
  assert(1 + keys.length <= 100, "book + one chunk of keys stays under D1's 100 bind-variable cap");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 3: verses.ts's PATCH route resolve-not-delete clause, against real
// SQLite. Uses the ACTUAL production SQL text (RESOLVE_VERSE_MERGE_CONFLICT_SQL,
// imported above from verseMergeConflictResolve.ts — the same pure-module
// split blankStub.ts uses for blankStubTrash.test.mjs) so this can't silently
// drift from what verses.ts really runs.
// ─────────────────────────────────────────────────────────────────────────

function verseDb() {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE verse_merge_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, book TEXT, resource TEXT, chapter INTEGER,
    verse INTEGER, action TEXT, reason TEXT, overwritten_version INTEGER, alignment TEXT,
    detected_at INTEGER, resolved_at INTEGER, resolved_by INTEGER, last_recorded_at INTEGER,
    recorded_generation INTEGER NOT NULL DEFAULT 0,
    prior_json TEXT, prior_run TEXT
  )`);
  // Required for UPSERT_VERSE_MERGE_CONFLICT_SQL's `ON CONFLICT (book,
  // resource, chapter, verse)` clause to have anything to conflict against —
  // mirrors migration 0044's real verse_merge_conflicts_unique index.
  d.exec(
    `CREATE UNIQUE INDEX verse_merge_conflicts_unique ON verse_merge_conflicts (book, resource, chapter, verse)`,
  );
  d.exec(`CREATE TABLE verses (
    book TEXT, chapter INTEGER, verse INTEGER, bible_version TEXT, version INTEGER,
    content_json TEXT, plain_text TEXT, updated_at INTEGER, updated_by INTEGER,
    last_change_action TEXT, last_change_source TEXT, last_change_actor TEXT
  )`);
  // Migration 0023's real schema, for the #626 resolved-banner-clear tests below.
  d.exec(`CREATE TABLE system_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, severity TEXT NOT NULL,
    source TEXT NOT NULL, message TEXT NOT NULL, link_url TEXT,
    created_at INTEGER, dismissed_at INTEGER
  )`);
  return d;
}

// Replicates clearResolvedConflictBannerIfLast's exact decision (verses.ts's
// PATCH route, issue #626) against real SQLite, using the ACTUAL
// SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL text so this can't silently drift
// from what that function really queries. The DELETE mirrors
// the ACTUAL CLEAR_CONFLICT_ONLY_ALERTS_BY_* text — source-wide when every
// undismissed row is conflict-only, per-username when a keep_no_base message
// must stay (PR #631 review P1).
function clearResolvedBanner(d, book, resource, raceHook) {
  const active = d.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL).all(book, resource);
  if (active.length > 0) return { cleared: false, preservedNoBase: false };
  const source = `verse_merge_conflict:${book}:${resource}`;
  const alerts = d
    .prepare(`SELECT username, message FROM system_alerts WHERE source = ? AND dismissed_at IS NULL`)
    .all(source);
  const toClear = alerts.filter((a) => !alertMessageCarriesNoBaseWarning(a.message));
  if (toClear.length === 0) {
    // Nothing undismissed to delete (only-dismissed history, or every
    // remaining row carries keep_no_base). The former is vacuously "cleared";
    // the latter is an intentional preserve.
    return { cleared: alerts.length === 0, preservedNoBase: alerts.length > 0 };
  }
  // `raceHook` lets a test simulate a reimport landing in the gap between the
  // decision above and the DELETE below (PR #631 Codex review) — the exact
  // window the NOT EXISTS inside both statements exists to close.
  if (raceHook) raceHook(d);
  let changes = 0;
  if (toClear.length === alerts.length) {
    changes = d.prepare(CLEAR_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL).run(source, book, resource).changes;
  } else {
    const del = d.prepare(CLEAR_CONFLICT_ONLY_ALERTS_BY_USER_SQL);
    for (const a of toClear) changes += del.run(a.username, source, book, resource).changes;
  }
  return { cleared: changes > 0, preservedNoBase: toClear.length < alerts.length };
}

// Runs the REAL verses.ts PATCH-route UPDATE (VERSE_PATCH_UPDATE_SQL) first
// (so changes() reflects it), then the REAL resolve-clause SQL gated on
// `changes() > 0 AND resolved_at IS NULL`. The real batch has an edit_log
// INSERT in between (also gated on `changes() > 0` from the verses UPDATE)
// that this omits — safe to omit because that INSERT's own row count exactly
// mirrors the verses UPDATE's (`SELECT ... WHERE changes() > 0`, 0-or-1
// either way), so `changes()` as seen by the resolve statement is identical
// whether or not the INSERT ran.
function saveVerse(d, { book, resource, chapter, verse, matchVersion, userId, now, contentJson = "{}" }) {
  const verseRes = d
    .prepare(VERSE_PATCH_UPDATE_SQL)
    .run(contentJson, null, now, userId, "update", "user", "test-actor", book, chapter, verse, resource.toUpperCase(), matchVersion);
  const resolveRes = d
    .prepare(RESOLVE_VERSE_MERGE_CONFLICT_SQL)
    .run(now, userId, book, resource, chapter, verse);
  return { verseChanged: verseRes.changes, conflictResolved: resolveRes.changes };
}

{
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('ZEC', 1, 2, 'ULT', 3)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('ZEC', 'ult', 1, 2, 'adopt_conflict', 'both_changed', 2, 100)`,
  ).run();

  const result = saveVerse(d, { book: "ZEC", resource: "ult", chapter: 1, verse: 2, matchVersion: 3, userId: 30, now: 200 });
  assert(result.verseChanged === 1 && result.conflictResolved === 1, "matching-version save resolves the conflict");

  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book = 'ZEC' AND chapter = 1 AND verse = 2`).get();
  assert(!!row, "the row still EXISTS — not deleted (the defect this fixes)");
  assert(row.resolved_at === 200, "resolved_at stamped with the save time");
  assert(row.resolved_by === 30, "resolved_by stamped with the saving user");
  assert(row.overwritten_version === 2, "overwritten_version recovery pointer is preserved, not erased");

  const activeCount = d
    .prepare(`SELECT COUNT(*) c FROM verse_merge_conflicts WHERE book = 'ZEC' AND resolved_at IS NULL`)
    .get().c;
  assert(activeCount === 0, "resolved row no longer counts as an ACTIVE conflict");
}

{
  // Version mismatch (the save loses the CAS race / a stale client) must not
  // resolve the conflict — see the comment in verses.ts about why this is
  // NOT equivalent to testing verses.version = newVersion.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('ZEC', 1, 2, 'ULT', 5)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('ZEC', 'ult', 1, 2, 'adopt_conflict', 'both_changed', 4, 100)`,
  ).run();

  const result = saveVerse(d, { book: "ZEC", resource: "ult", chapter: 1, verse: 2, matchVersion: 3, userId: 30, now: 200 });
  assert(result.verseChanged === 0, "stale If-Match: the verse UPDATE itself changes nothing");
  assert(result.conflictResolved === 0, "…so the conflict is NOT resolved on a save that never landed");

  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book = 'ZEC' AND chapter = 1 AND verse = 2`).get();
  assert(row.resolved_at === null, "conflict remains unresolved");
}

{
  // A second save after the conflict is already resolved must not reassign
  // resolved_by to a different (later) user.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('ZEC', 1, 2, 'ULT', 3)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('ZEC', 'ult', 1, 2, 'adopt_conflict', 'both_changed', 2, 100)`,
  ).run();

  saveVerse(d, { book: "ZEC", resource: "ult", chapter: 1, verse: 2, matchVersion: 3, userId: 30, now: 200 });
  const second = saveVerse(d, { book: "ZEC", resource: "ult", chapter: 1, verse: 2, matchVersion: 4, userId: 45, now: 300 });
  assert(second.verseChanged === 1, "second save lands (version now 4)");
  assert(second.conflictResolved === 0, "already-resolved row is not touched again");

  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book = 'ZEC' AND chapter = 1 AND verse = 2`).get();
  assert(row.resolved_at === 200 && row.resolved_by === 30, "first resolver's stamp is preserved, not overwritten");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 3b: clearResolvedConflictBannerIfLast (issue #626). The banner alert
// used to be frozen at whatever the last sync run wrote, even after a human
// resolved every conflict it named — nothing rewrote it until the next
// reimport. verses.ts's PATCH route now calls this after a save resolves a
// conflict row, to clear the (book, resource) banner immediately when that
// was the LAST active alertable conflict outstanding.
// ─────────────────────────────────────────────────────────────────────────

{
  // The measured case from the issue: JER ULT had 3 active conflicts; a
  // human resolves one of them; two alertable rows remain. The banner must NOT
  // be cleared — a partially-stale banner (still correctly naming the two
  // survivors, if stale on the exact count) beats fabricating a fresh count from
  // a fragment.
  //
  // The two survivors were both_changed_ai_master rows when this case was
  // written; issue #749 took that action out of the alertable set (nothing is
  // waiting to be reverted there), so the survivors here are the alignment
  // refusal — which still is one — and the shape under test is unchanged.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at)
     VALUES ('JER', 'ult', 42, 6, 'keep_alignment_refused', 'alignment_shrink', NULL, 100, NULL)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at)
     VALUES ('JER', 'ult', 42, 11, 'keep_alignment_refused', 'alignment_shrink', NULL, 100, NULL)`,
  ).run();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', 'Sync flagged 3 verse(s)...')`,
  ).run();

  const cleared = clearResolvedBanner(d, "JER", "ult");
  assert(!cleared.cleared, "two conflicts still outstanding -> banner is left alone, not cleared");
  const alert = d.prepare(`SELECT * FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ult'`).get();
  assert(!!alert, "the (stale but not wrong-count) banner row still exists");
}

{
  // The success case: the one remaining conflict for (book, resource) gets
  // resolved. The banner — both the admin's row and an editor's fan-out row,
  // same source — disappears immediately, not on the next sync.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at)
     VALUES ('JER', 'ult', 41, 8, 'source_attr_divergent', 'source_attr_ambiguous', NULL, 100, 12345)`,
  ).run();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', 'Sync flagged 1 verse(s)...')`,
  ).run();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('bethoakes', 'warning', 'verse_merge_conflict:JER:ult', 'Your edit at JER 41:8 was overwritten...')`,
  ).run();

  const cleared = clearResolvedBanner(d, "JER", "ult");
  assert(cleared.cleared, "the last active conflict just resolved -> banner is cleared");
  const remaining = d.prepare(`SELECT * FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ult'`).all();
  assert(remaining.length === 0, "cleared by SOURCE — both the admin's row and the editor's fan-out row are gone");
}

{
  // PR #631 Codex review: the "is this the last one?" decision and the DELETE
  // are separate round-trips. A reimport landing in that gap records a fresh
  // conflict and raises its banner — and the now-stale clear used to delete
  // that brand-new warning, leaving a real divergence unannounced until the
  // next sync. The NOT EXISTS inside the DELETE must make the clear a no-op.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at)
     VALUES ('JER', 'ult', 41, 8, 'source_attr_divergent', 'source_attr_ambiguous', NULL, 100, 12345)`,
  ).run();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', 'Sync flagged 1 verse(s)...')`,
  ).run();

  const cleared = clearResolvedBanner(d, "JER", "ult", (db) => {
    // The interleaved reimport: a new conflict row, then its refreshed banner.
    db.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at)
       VALUES ('JER', 'ult', 43, 2, 'adopt_conflict', 'both_changed', 7, 200, NULL)`,
    ).run();
    db.prepare(`DELETE FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ult' AND dismissed_at IS NULL`).run();
    db.prepare(
      `INSERT INTO system_alerts (username, severity, source, message)
       VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', 'Sync flagged 1 verse(s) in JER ULT... Refs: 43:2.')`,
    ).run();
  });

  assert(!cleared.cleared, "a conflict recorded mid-flight makes the stale clear a no-op");
  const alert = d.prepare(`SELECT * FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ult'`).get();
  assert(!!alert, "the reimport's fresh banner survives the racing clear");
  assert(alert.message.includes("43:2"), "…and it is the NEW banner, naming the newly-flagged verse");
}

{
  // A dismissed banner row must be left alone even when every conflict for
  // that (book, resource) resolves — the same invariant
  // clearUndismissedAlertsStmt documents for every other clear in this file.
  const d = verseDb();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message, dismissed_at)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', 'Sync flagged 1 verse(s)...', 999)`,
  ).run();

  const cleared = clearResolvedBanner(d, "JER", "ult");
  assert(cleared.cleared, "zero active conflicts -> the clear still runs");
  const alert = d.prepare(`SELECT * FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ult'`).get();
  assert(!!alert && alert.dismissed_at === 999, "…but a DISMISSED row is never touched — it stays as history");
}

{
  // A banner for a DIFFERENT (book, resource) sharing no active conflicts
  // must not be collaterally cleared just because JER ULT's own resolve ran
  // through this same call.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at)
     VALUES ('EZK', 'ust', 26, 17, 'source_attr_divergent', 'source_attr_ambiguous', NULL, 100, NULL)`,
  ).run();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:EZK:ust', 'Sync flagged 1 verse(s)...')`,
  ).run();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', 'stale JER banner, nothing active')`,
  ).run();

  const cleared = clearResolvedBanner(d, "JER", "ult");
  assert(cleared.cleared, "JER ult has zero active conflicts -> its own banner clears");
  const ezkAlert = d.prepare(`SELECT * FROM system_alerts WHERE source = 'verse_merge_conflict:EZK:ust'`).get();
  assert(!!ezkAlert, "EZK ust's own still-active banner is untouched by JER ult's clear");
}

{
  // PR #631 review P1: keep_no_base warnings ride in the banner message via
  // noBaseCount at raise time and have NO verse_merge_conflicts row. Resolving
  // the last ordinary conflict must NOT erase an alert that still warns about
  // unresolved no-ancestor verses.
  const d = verseDb();
  const adminMsg =
    `Sync flagged 1 verse(s) in JER ULT for review (1 source_attr_ambiguous). Refs: 41:8. ` +
    buildNoBaseSentence(2, ["42:2", "42:3"]);
  const editorOverwrite = "Your edit at JER 41:8 was overwritten by Door43's sync...";
  const editorNoBase = groupNoBaseVersesByEditor(
    "JER",
    "ult",
    [{ chapter: 42, verse: 2, version: 5 }],
    new Map([[editLogKey("JER", "ult", { chapter: 42, verse: 2, overwrittenVersion: 5 }), "bethoakes"]]),
  ).get("bethoakes").message;

  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', ?)`,
  ).run(adminMsg);
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('grant', 'warning', 'verse_merge_conflict:JER:ult', ?)`,
  ).run(editorOverwrite);
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('bethoakes', 'warning', 'verse_merge_conflict:JER:ult', ?)`,
  ).run(editorNoBase);

  assert(alertMessageCarriesNoBaseWarning(adminMsg), "admin mixed message carries the no-base fingerprint");
  assert(alertMessageCarriesNoBaseWarning(editorNoBase), "editor no-base fan-out carries its fingerprint");
  assert(!alertMessageCarriesNoBaseWarning(editorOverwrite), "overwrite-only fan-out does not");

  const result = clearResolvedBanner(d, "JER", "ult");
  assert(result.cleared && result.preservedNoBase, "cleared conflict-only rows but preserved keep_no_base carriers");

  const remaining = d
    .prepare(`SELECT username, message FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ult' ORDER BY username`)
    .all();
  assert(remaining.length === 2, "admin + bethoakes kept; grant's overwrite-only alert dropped");
  assert(
    remaining.map((r) => r.username).join(",") === "bethoakes,deferredreward",
    "preserved usernames are the keep_no_base carriers",
  );
  assert(
    remaining.every((r) => alertMessageCarriesNoBaseWarning(r.message)),
    "every surviving alert still carries the outstanding no-base condition",
  );
}

{
  // Pure keep_no_base banner (zero adjudicated conflicts at raise time): zero
  // active table rows must leave it untouched — there was never a conflict row
  // to resolve, and clearing would drop the only warning that exists.
  const d = verseDb();
  const msg = `Sync flagged 0 verse(s) in EZK UST for adjudicated review. ${buildNoBaseSentence(3, ["21:9"])}`;
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:EZK:ust', ?)`,
  ).run(msg);

  const result = clearResolvedBanner(d, "EZK", "ust");
  assert(!result.cleared && result.preservedNoBase, "pure keep_no_base banner is not cleared");
  const alert = d.prepare(`SELECT * FROM system_alerts WHERE source = 'verse_merge_conflict:EZK:ust'`).get();
  assert(!!alert, "…the row is still there");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 4: TWO-PHASE REACTIVATION (Codex second-opinion review fix). The
// speculative upsert (UPSERT_VERSE_MERGE_CONFLICT_SQL, step 6b — runs BEFORE
// the master-adoption CAS batch) must NEVER touch resolved_at/resolved_by.
// Only confirmAdoptedConflicts (CONFIRM_ADOPTED_CONFLICT_SQL), called AFTER
// the CAS batch confirms which adoptions actually landed, may clear them.
// This is what makes a lost CAS race safe: nothing was cleared speculatively,
// so there is nothing to undo.
// ─────────────────────────────────────────────────────────────────────────

function upsertConflict(
  d,
  { book, resource, chapter, verse, action, reason, overwrittenVersion, now, bibleVersion = null, observedVersion = null, runId = null },
) {
  return d
    .prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL)
    .run(book, resource, chapter, verse, action, reason, overwrittenVersion, null, now, bibleVersion, observedVersion, runId);
}

// The lost-race cleanup's three statements (issue #1137), in production order,
// for one ref and the run that lost.
function lostCleanup(d, book, resource, chapter, verse, runId) {
  const scope = [book, resource, chapter, chapter, JSON.stringify([`${chapter}:${verse}`]), runId];
  for (const sql of [RESTORE_SPECULATIVE_CONFLICTS_SQL, DELETE_SPECULATIVE_CONFLICTS_SQL, SETTLE_SPECULATIVE_CONFLICTS_SQL]) {
    d.prepare(sql).run(...scope);
  }
}

function confirmAdopted(d, { book, resource, chapter, verse, now, overwrittenVersion = null, alignment = null }) {
  return d.prepare(CONFIRM_ADOPTED_CONFLICT_SQL).run(book, resource, chapter, verse, now, overwrittenVersion, alignment);
}

{
  // *** THE EXACT CODEX SCENARIO — CAS LOSES ***
  // A verse has an OLD, human-resolved conflict (real audit history: a real
  // resolved_by and overwritten_version). A later sync computes a fresh
  // adopt_conflict and step 6b's speculative upsert runs — but the
  // adoption's CAS write then LOSES its race (a human saved first; nothing
  // was actually overwritten). The row must end up STILL RESOLVED, with its
  // ORIGINAL resolved_at/resolved_by intact, and NOT active.
  const d = verseDb();
  upsertConflict(d, {
    book: "ZEC", resource: "ult", chapter: 6, verse: 1,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 2, now: 100,
  });
  d.prepare(RESOLVE_VERSE_MERGE_CONFLICT_SQL).run(150, 30, "ZEC", "ult", 6, 1);
  {
    const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=6 AND verse=1`).get();
    assert(row.resolved_at === 150 && row.resolved_by === 30, "sanity: resolved before tonight's re-detection");
  }

  // Tonight: step 6b's speculative upsert runs BEFORE the CAS attempt.
  const tonight = 5000;
  upsertConflict(d, {
    book: "ZEC", resource: "ult", chapter: 6, verse: 1,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 9, now: tonight, runId: "run-tonight",
  });
  {
    // Immediately after the SPECULATIVE upsert — before we know whether the
    // CAS will land — resolved_at/resolved_by must be COMPLETELY UNCHANGED.
    // This is the core two-phase guarantee: the speculative step never
    // clears them, so there is nothing to falsely reactivate.
    const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=6 AND verse=1`).get();
    assert(row.resolved_at === 150 && row.resolved_by === 30, "speculative upsert alone does NOT touch resolved_at/resolved_by");
  }

  // Tonight's CAS attempt LOSES its race (a human saved first).
  lostCleanup(d, "ZEC", "ult", 6, 1, "run-tonight");

  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=6 AND verse=1`).get();
  assert(!!row, "row SURVIVES a lost CAS on a previously-resolved verse");
  assert(row.resolved_at === 150, "ORIGINAL resolved_at is intact — not cleared, not re-stamped");
  assert(row.resolved_by === 30, "ORIGINAL resolved_by is intact — the true resolver, not lost");
  const activeCount = d
    .prepare(`SELECT COUNT(*) c FROM verse_merge_conflicts WHERE book='ZEC' AND resolved_at IS NULL`)
    .get().c;
  assert(activeCount === 0, "row does NOT show as an active conflict — no false alert for an overwrite that never happened");
}

{
  // *** THE SIBLING SCENARIO — CAS WINS ***
  // Same starting state (a resolved conflict with real history), but this
  // time the adoption's CAS write actually LANDS. The row must become
  // genuinely active — this is the re-detection-visibility guarantee from
  // the six-angle review, now delivered via the CONFIRMING phase instead of
  // the unsafe eager clear.
  const d = verseDb();
  upsertConflict(d, {
    book: "ZEC", resource: "ult", chapter: 6, verse: 2,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 2, now: 100,
  });
  d.prepare(RESOLVE_VERSE_MERGE_CONFLICT_SQL).run(150, 30, "ZEC", "ult", 6, 2);

  const tonight = 5000;
  upsertConflict(d, {
    book: "ZEC", resource: "ult", chapter: 6, verse: 2,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 9, now: tonight,
  });
  {
    const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=6 AND verse=2`).get();
    assert(row.resolved_at === 150, "still dormant immediately after the speculative upsert, CAS not yet attempted");
  }

  // Tonight's CAS attempt LANDS — confirmAdoptedConflicts is called for
  // exactly this ref (bookReimport.ts's landedAdoptions).
  confirmAdopted(d, { book: "ZEC", resource: "ult", chapter: 6, verse: 2, now: tonight, overwrittenVersion: 9 });

  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=6 AND verse=2`).get();
  assert(row.resolved_at === null, "CONFIRMED landed adoption -> resolved_at cleared, genuinely active");
  assert(row.resolved_by === null, "resolved_by cleared alongside resolved_at");
  const activeCount = d
    .prepare(`SELECT COUNT(*) c FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=6 AND verse=2 AND resolved_at IS NULL`)
    .get().c;
  assert(activeCount === 1, "now visible to the same query the banner and GET route use");

  // Issue #1112 (this used to pin the old pointer as a known limitation): the
  // confirm that reactivates a RESOLVED row takes tonight's real overwrite
  // (v9), not the resolved v2 pointer.
  assert(row.overwritten_version === 9, `reactivated row points at tonight's overwrite (v9), not the resolved v2 (got v${row.overwritten_version})`);
}

{
  // A verse that was NEVER resolved just continues normally — resolved_at
  // stays NULL throughout (the common, everyday case). The speculative
  // upsert never touches resolved_at at all, so there's nothing to reset.
  const d = verseDb();
  upsertConflict(d, {
    book: "HOS", resource: "ust", chapter: 2, verse: 1,
    action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null, now: 100,
  });
  upsertConflict(d, {
    book: "HOS", resource: "ust", chapter: 2, verse: 1,
    action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null, now: 200,
  });
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='HOS' AND chapter=2 AND verse=1`).get();
  assert(row.resolved_at === null, "never-resolved row: stays active, untouched");
  assert(row.detected_at === 100, "detected_at preserved across a still-unresolved re-detection (its ORIGINAL, unchanged meaning)");
  assert(row.last_recorded_at === 200, "last_recorded_at DOES refresh on every upsert — that's its whole job");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 5: lost-adoption cleanup must not destroy a row's prior history just
// because a LATER, unrelated CAS attempt on the same verse lost its race.
// Since issue #1137 the cleanup touches only rows whose speculation the losing
// run still owns (prior_run), restores a row that existed before it from the
// capture its upsert stored, and deletes only a row it created that nobody
// has resolved (verseMergeConflictSql.ts's *_SPECULATIVE_CONFLICTS_SQL).
// ─────────────────────────────────────────────────────────────────────────

{
  // Case A (the case this cleanup exists for): a BRAND NEW row this run,
  // whose speculative adopt attempt then loses its CAS race. last_recorded_at
  // was set to THIS run's `now` on insert, so it matches and is deleted —
  // identical to the pre-review-round behavior for a genuinely fresh row.
  const d = verseDb();
  const now = 9999;
  upsertConflict(d, {
    book: "ZEC", resource: "ult", chapter: 5, verse: 5,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 3, now, runId: "run-tonight",
  });
  lostCleanup(d, "ZEC", "ult", 5, 5, "run-tonight");
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=5 AND verse=5`).get();
  assert(!row, "brand-new-this-run speculative row: still deleted when its CAS is lost (matches original behavior)");
}

{
  // Case B: a row still-active (never resolved) from a prior night, re-hit
  // by a fresh event this run whose CAS attempt loses. Until issue #1132 it
  // was deleted, taking a pending alert with it; now it is put back exactly
  // as the prior night left it (cases (j)-(y) below cover the details).
  const d = verseDb();
  upsertConflict(d, {
    book: "MIC", resource: "ult", chapter: 1, verse: 1,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 4, now: 100,
  });
  const tonight = 5000;
  upsertConflict(d, {
    book: "MIC", resource: "ult", chapter: 1, verse: 1,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 4, now: tonight, runId: "run-tonight",
  });
  lostCleanup(d, "MIC", "ult", 1, 1, "run-tonight");
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='MIC' AND chapter=1 AND verse=1`).get();
  assert(
    !!row && row.last_recorded_at === 100 && row.prior_run === null,
    "never-resolved row re-touched this run: put back as the prior night left it on a lost CAS, its capture cleared",
  );
}

{
  // Case C: the resolved-row protection from Part 4, restated here to
  // confirm it holds via the DELETE statement directly (not just via the
  // full upsert-then-delete sequence already exercised above): a resolved
  // row's resolved_at IS NULL exclusion means the delete never matches it,
  // even for a row this run's speculation created.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at, prior_run)
     VALUES ('ZEC', 'ult', 7, 7, 'adopt_conflict', 'both_changed', 2, 50, 150, 30, 5000, 'run-tonight')`,
  ).run();
  lostCleanup(d, "ZEC", "ult", 7, 7, "run-tonight");
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=7 AND verse=7`).get();
  assert(!!row && row.resolved_at === 150, "a resolved row is excluded from the delete purely by resolved_at IS NULL, even one this run created");
  assert(row?.prior_run === null, "the resolved row the delete left is settled");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 6: REVIEW FIX 6 — dismissal stickiness. planSystemAlertWrites is
// pure, no D1 needed.
// ─────────────────────────────────────────────────────────────────────────

{
  // Nothing existed before: everything in `desired` must be inserted.
  const desired = new Map([["deferredreward", "admin message"], ["bethoakes", "editor message"]]);
  const { toDelete, toInsert } = planSystemAlertWrites(new Map(), desired);
  assert(toDelete.length === 0, "nothing to delete on a clean slate");
  assert(toInsert.length === 2, "both desired alerts get inserted");
}

{
  // The exact bug: a dismissed alert with IDENTICAL content must NOT
  // reappear just because this run re-derived the same conclusion again.
  const existing = new Map([["deferredreward", { message: "same message", dismissedAt: 12345 }]]);
  const desired = new Map([["deferredreward", "same message"]]);
  const { toDelete, toInsert } = planSystemAlertWrites(existing, desired);
  assert(toInsert.length === 0, "sticky: identical dismissed content is not resurrected");
  assert(toDelete.length === 0, "a dismissed row is never deleted either (stays as history)");
}

{
  // Content genuinely CHANGED since the dismissal (e.g. more verses now
  // affected) — this is new information the user hasn't seen, so it must
  // surface again despite the earlier dismissal.
  const existing = new Map([["deferredreward", { message: "1 verse affected", dismissedAt: 12345 }]]);
  const desired = new Map([["deferredreward", "3 verses affected"]]);
  const { toDelete, toInsert } = planSystemAlertWrites(existing, desired);
  assert(toInsert.length === 1 && toInsert[0].message === "3 verses affected", "changed content re-surfaces");
  assert(toDelete.length === 0, "the OLD dismissed row is left alone, not deleted (it's history, not being replaced)");
}

{
  // An UNDISMISSED alert with identical content: no-op, avoid pointless
  // churn (no fresh created_at, no wasted write).
  const existing = new Map([["deferredreward", { message: "same message", dismissedAt: null }]]);
  const desired = new Map([["deferredreward", "same message"]]);
  const { toDelete, toInsert } = planSystemAlertWrites(existing, desired);
  assert(toDelete.length === 0 && toInsert.length === 0, "identical undismissed content: touch nothing");
}

{
  // An UNDISMISSED alert whose content changed: replace it (delete then
  // insert) — this is the ordinary "conditions changed" refresh path.
  const existing = new Map([["deferredreward", { message: "1 verse affected", dismissedAt: null }]]);
  const desired = new Map([["deferredreward", "2 verses affected"]]);
  const { toDelete, toInsert } = planSystemAlertWrites(existing, desired);
  assert(toDelete.length === 1 && toDelete[0] === "deferredreward", "stale undismissed content is cleared");
  assert(toInsert.length === 1 && toInsert[0].message === "2 verses affected", "fresh content is inserted");
}

{
  // A username no longer in `desired` at all (their conflicts all resolved
  // or converged) with an UNDISMISSED row: must be cleared, not left stale.
  const existing = new Map([["bethoakes", { message: "old message", dismissedAt: null }]]);
  const { toDelete, toInsert } = planSystemAlertWrites(existing, new Map());
  assert(toDelete.length === 1 && toDelete[0] === "bethoakes", "stale undismissed alert for a resolved user is cleared");
  assert(toInsert.length === 0, "nothing to insert — they have no active conflicts anymore");
}

{
  // Same, but the row was already DISMISSED: leave it as historical record,
  // don't touch it either way.
  const existing = new Map([["bethoakes", { message: "old message", dismissedAt: 999 }]]);
  const { toDelete, toInsert } = planSystemAlertWrites(existing, new Map());
  assert(toDelete.length === 0, "a dismissed, now-irrelevant alert is left alone as history");
  assert(toInsert.length === 0, "nothing to insert for a dismissed, now-irrelevant alert");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 7: 'source_attr_divergent' — surfacing the un-adopted master
// original-language source fix on an edited verse (the EZK 40
// repeated-architecture-terms case). The reconcile can't place master's
// curated x-content/x-lemma/x-morph fix when the same source word repeats, so
// it keeps D1 and (this change) records a keep-D1 conflict for review instead
// of only a counter + log line. Nothing was overwritten, so it must behave
// like keep_alignment_refused: NULL recovery pointer, surfaced in the banner,
// classified as "kept D1" (never "took Door43's version"), cleared on re-save.
// ─────────────────────────────────────────────────────────────────────────

{
  // The UPSERT stores a keep-D1 divergence with a NULL recovery pointer even
  // if a null overwrittenVersion is bound — and the CASE forces NULL for this
  // action, so a verse that carried an OLD adopt_conflict pointer can never
  // report a stale @v recovery pointer once it becomes source_attr_divergent.
  const d = verseDb();
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 21, "source_attr_divergent", "source_attr_ambiguous", null, null, 1000, null, null,
  );
  let row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=21`).get();
  assert(row.action === "source_attr_divergent" && row.overwritten_version === null,
    "source_attr_divergent stored with a NULL overwritten_version (nothing was replaced)");

  // Re-upsert the SAME verse as if it had earlier been an adopt_conflict with a
  // real pointer, then diverge again: the pointer must be forced back to NULL.
  const d2 = verseDb();
  d2.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 21, "adopt_conflict", "both_changed", 7, null, 1000, null, null,
  );
  d2.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 21, "source_attr_divergent", "source_attr_ambiguous", null, null, 2000, null, null,
  );
  row = d2.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=21`).get();
  assert(row.action === "source_attr_divergent" && row.overwritten_version === null,
    "a verse that becomes source_attr_divergent drops any prior overwritten_version pointer (never misdirects a reviewer)");
}

{
  // The banner's active-conflict filter (the REAL production constant) surfaces
  // a source_attr_divergent row, EXCLUDES a clean 'adopt' (audit-only), and
  // EXCLUDES a resolved row.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('EZK','ult',40,21,'source_attr_divergent','source_attr_ambiguous',NULL,100)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('EZK','ult',40,22,'adopt','master_unchanged',5,100)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by)
     VALUES ('EZK','ult',40,23,'source_attr_divergent','source_attr_ambiguous',NULL,100,150,30)`,
  ).run();
  const rows = d.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL).all("EZK", "ult");
  assert(rows.length === 1, "banner filter returns exactly the one active, alertable row");
  assert(rows[0].verse === 21 && rows[0].action === "source_attr_divergent",
    "…which is the unresolved source_attr_divergent row (not the audit-only 'adopt', not the resolved one)");

  // Issue #749 (was #540 item 2): a keep_ai_master row is NOT alertable. The
  // outcome rests on a complete lineage walk that found no Door43 editor's
  // commit behind master's side — nothing was taken, the next export publishes
  // the kept version, and the banner's own sentence said so while asking a
  // translator to look anyway. No new row is written (bookReimport.ts), and any
  // standing one stays out of the banner until the nightly retire stamps it
  // resolved. Prod 2026-09-09: 37 such rows, the oldest three weeks old.
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('EZK','ult',40,24,'keep_ai_master','both_changed_ai_master',NULL,100)`,
  ).run();
  const withAi = d.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL).all("EZK", "ult");
  assert(!withAi.some((r) => r.verse === 24),
    "the banner filter no longer surfaces a keep_ai_master row (#749)");
  assert(withAi.length === 1 && withAi[0].verse === 21,
    "…without dropping the source_attr_divergent row beside it");

  // The kept-D1 actions that DO still need a human are untouched by that removal
  // — the regression this pass most needs to not cause. (source_attr_divergent
  // is already proved alertable by the row at verse 21 above.)
  for (const [verse, action] of [[26, "keep_alignment_refused"], [27, "keep_local_structure"]]) {
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('EZK','ult',40,?,?,'reason',NULL,100)`,
    ).run(verse, action);
  }
  const withKeeps = d.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL).all("EZK", "ult");
  assert(withKeeps.some((r) => r.action === "keep_alignment_refused"), "keep_alignment_refused is still alertable");
  assert(withKeeps.some((r) => r.action === "keep_local_structure"), "keep_local_structure is still alertable");

  // Issue #633: adopt_no_visible_change is audit-only, same as clean adopt —
  // wording + alignment groups matched, so it must never reach the banner.
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('EZK','ult',40,25,'adopt_no_visible_change','both_changed_no_visible',8,100)`,
  ).run();
  const withSilent = d.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL).all("EZK", "ult");
  assert(!withSilent.some((r) => r.verse === 25),
    "adopt_no_visible_change is excluded from the banner filter (audit only)");
  assert(withSilent.some((r) => r.verse === 21),
    "…without dropping other alertable rows");
}

{
  // Issue #749: the nightly retire. Every STANDING keep_ai_master row comes down
  // — D1-only, one statement, no Door43 walk, because the mint itself was the
  // complete measurement that justifies the clear (same argument as #703's
  // retireMergeKeptFlags on the TSV side).
  const d = verseDb();
  const seed = (chapter, verse, action, resolvedAt = null, resolvedBy = null) =>
    d
      .prepare(
        `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version,
                                            detected_at, resolved_at, resolved_by)
         VALUES ('EZK','ust',?,?,?,'reason',NULL,100,?,?)`,
      )
      .run(chapter, verse, action, resolvedAt, resolvedBy);
  seed(22, 26, "keep_ai_master");
  seed(33, 9, "keep_ai_master");
  seed(45, 11, "keep_ai_master", 150, 30); // already resolved BY A HUMAN
  seed(40, 21, "source_attr_divergent");
  seed(40, 22, "keep_alignment_refused");
  seed(40, 23, "adopt_conflict");
  seed(40, 24, "keep_local_structure");

  const first = d.prepare(RETIRE_KEPT_AI_MASTER_CONFLICTS_SQL).run(9000);
  assert(Number(first.changes) === 2, "the two standing keep_ai_master rows are retired");

  const byRef = Object.fromEntries(
    d
      .prepare(`SELECT chapter, verse, action, resolved_at, resolved_by FROM verse_merge_conflicts`)
      .all()
      .map((r) => [`${r.chapter}:${r.verse}`, r]),
  );
  assert(byRef["22:26"].resolved_at === 9000 && byRef["22:26"].resolved_by === null,
    "a retired row is stamped resolved_at with resolved_by NULL — the system-retired signature");
  assert(byRef["33:9"].resolved_at === 9000 && byRef["33:9"].resolved_by === null, "…for every standing row");
  assert(byRef["22:26"].action === "keep_ai_master",
    "…and the action is preserved: the row IS the audit trail, so it is never rewritten or deleted");
  // resolved_by IS NULL AND resolved_at IS NOT NULL is what makes a retirement
  // distinguishable from a human resolve forever after. A human resolve always
  // carries the saving user's id (RESOLVE_VERSE_MERGE_CONFLICT_SQL).
  assert(byRef["45:11"].resolved_at === 150 && byRef["45:11"].resolved_by === 30,
    "a row a human already resolved keeps THEIR resolution — the retire never overwrites it");
  for (const ref of ["40:21", "40:22", "40:23", "40:24"]) {
    assert(byRef[ref].resolved_at === null, `${byRef[ref].action} at ${ref} is untouched by the retire`);
  }

  // Idempotent: once the backlog is gone, every later night matches nothing.
  const second = d.prepare(RETIRE_KEPT_AI_MASTER_CONFLICTS_SQL).run(9999);
  assert(Number(second.changes) === 0, "a second pass retires nothing (idempotent)");
  assert(
    d.prepare(`SELECT resolved_at FROM verse_merge_conflicts WHERE chapter = 22 AND verse = 26`).get().resolved_at === 9000,
    "…and does not re-stamp the rows the first pass retired",
  );

  // And the retired rows are out of the banner, which is the point of all this.
  const active = d.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL).all("EZK", "ust");
  assert(!active.some((r) => r.action === "keep_ai_master"), "no keep_ai_master row remains in the banner filter");
  assert(active.length === 4, "…and the four genuinely alertable rows still are");
}

{
  // Issue #760 (#754 P1 follow-up). Retiring the ROWS above is not enough: the
  // "Sync flagged N verse(s)" banner is a MATERIALIZED system_alerts row that
  // only raiseVerseMergeConflictAlert re-derives, and the unscoped nightly
  // sweep never calls it for a resource whose Door43 SHA didn't change this
  // run. retireVerseKeptAiMasterFlags now reads the distinct (book, resource)
  // pairs it's about to retire BEFORE the UPDATE
  // (SELECT_STANDING_KEPT_AI_MASTER_CONFLICT_PAIRS_SQL) and runs
  // clearResolvedConflictBannerIfLast (replicated here by clearResolvedBanner,
  // against the ACTUAL SQL constants) for each. This block drives that exact
  // sequence and asserts all three cases from the issue's success check.

  // Case 1: a standing keep_ai_master row plus its banner, for a resource that
  // is NOT reimported this run (nothing else outstanding) — banner must come
  // down along with the row.
  {
    const d = verseDb();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('JER','ult',3,5,'keep_ai_master','both_changed_ai_master',NULL,100)`,
    ).run();
    d.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, created_at)
       VALUES ('deferredreward','warning','verse_merge_conflict:JER:ult','Sync flagged 1 verse(s) in JER ULT...',100)`,
    ).run();

    const pairs = d.prepare(SELECT_STANDING_KEPT_AI_MASTER_CONFLICT_PAIRS_SQL).all();
    assert(pairs.length === 1 && pairs[0].book === "JER" && pairs[0].resource === "ult",
      "the pair lookup finds JER/ult before the retire UPDATE runs");

    d.prepare(RETIRE_KEPT_AI_MASTER_CONFLICTS_SQL).run(9000);
    for (const p of pairs) clearResolvedBanner(d, p.book, p.resource);

    const remaining = d
      .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ult'`)
      .all()[0].n;
    assert(remaining === 0, "a pure keep_ai_master-backlog banner is cleared by the retire sweep");
  }

  // Case 2: a keep_ai_master row retired alongside a REAL alertable conflict
  // (adopt_conflict) sharing the same banner source — the banner must survive,
  // still naming the genuinely outstanding row.
  {
    const d = verseDb();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('JER','ust',3,5,'keep_ai_master','both_changed_ai_master',NULL,100)`,
    ).run();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('JER','ust',4,1,'adopt_conflict','both_changed',7,100)`,
    ).run();
    d.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, created_at)
       VALUES ('deferredreward','warning','verse_merge_conflict:JER:ust','Sync flagged 1 verse(s) in JER UST...',100)`,
    ).run();

    const pairs = d.prepare(SELECT_STANDING_KEPT_AI_MASTER_CONFLICT_PAIRS_SQL).all();
    d.prepare(RETIRE_KEPT_AI_MASTER_CONFLICTS_SQL).run(9000);
    for (const p of pairs) clearResolvedBanner(d, p.book, p.resource);

    const remaining = d
      .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ust'`)
      .all()[0].n;
    assert(remaining === 1, "a banner with a real outstanding adopt_conflict row survives the retire sweep");
    const kept = d
      .prepare(`SELECT resolved_at FROM verse_merge_conflicts WHERE book='JER' AND resource='ust' AND verse=5`)
      .all()[0];
    assert(kept.resolved_at === 9000, "…even though the keep_ai_master row itself was still retired");
  }

  // Case 3: a banner carrying a keep_no_base warning (no verse_merge_conflicts
  // row at all — it lives only in the message, see
  // alertMessageCarriesNoBaseWarning) must be preserved, same as
  // clearResolvedConflictBannerIfLast's own per-username carve-out.
  {
    const d = verseDb();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('NUM','ult',9,2,'keep_ai_master','both_changed_ai_master',NULL,100)`,
    ).run();
    d.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, created_at)
       VALUES ('deferredreward','warning','verse_merge_conflict:NUM:ult',
               'Sync flagged 0 verse(s) in NUM ULT for adjudicated review. 1 verse(s) could not be adjudicated: no ancestor was recoverable for them from before this sync (9:9).',100)`,
    ).run();

    const pairs = d.prepare(SELECT_STANDING_KEPT_AI_MASTER_CONFLICT_PAIRS_SQL).all();
    d.prepare(RETIRE_KEPT_AI_MASTER_CONFLICTS_SQL).run(9000);
    for (const p of pairs) clearResolvedBanner(d, p.book, p.resource);

    const remaining = d
      .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = 'verse_merge_conflict:NUM:ult'`)
      .all()[0].n;
    assert(remaining === 1, "a keep_no_base warning banner is preserved by the retire sweep, not erased");
  }

  // Case 4 (Codex review on #761): the pair lookup must fail CLOSED. If
  // SELECT_STANDING_KEPT_AI_MASTER_CONFLICT_PAIRS_SQL throws, the retire
  // UPDATE must NOT run at all this call — running it anyway (with an empty
  // pairs list, so no banner clear) would stamp resolved_at on every
  // standing row, and the pairs SELECT's own `resolved_at IS NULL` filter
  // then means no LATER night's lookup can ever find those rows again,
  // permanently losing the banner clear. Drives the REAL async
  // retireVerseKeptAiMasterFlags (not the SQL-replica pattern above) against
  // a minimal D1 shim so the throw actually exercises its try/catch control
  // flow, not just a hand replica of it.
  {
    const d = verseDb();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('MIC','ust',5,14,'keep_ai_master','both_changed_ai_master',NULL,100)`,
    ).run();
    d.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, created_at)
       VALUES ('deferredreward','warning','verse_merge_conflict:MIC:ust','Sync flagged 1 verse(s) in MIC UST...',100)`,
    ).run();

    const env = {
      DB: {
        prepare(sql) {
          const isPairLookup = sql === SELECT_STANDING_KEPT_AI_MASTER_CONFLICT_PAIRS_SQL;
          return {
            bind: (...args) => ({
              all: async () => ({ results: d.prepare(sql).all(...args) }),
              run: async () => {
                const r = d.prepare(sql).run(...args);
                return { meta: { changes: Number(r.changes) } };
              },
            }),
            all: async () => {
              if (isPairLookup) throw new Error("simulated transient D1 error");
              return { results: d.prepare(sql).all() };
            },
          };
        },
      },
    };

    const result = await retireVerseKeptAiMasterFlags(env);
    assert(result.cleared === 0, "a failed pair lookup reports 0 cleared, never a partial retire");

    const row = d
      .prepare(`SELECT resolved_at FROM verse_merge_conflicts WHERE book='MIC' AND resource='ust' AND verse=14`)
      .all()[0];
    assert(row.resolved_at === null,
      "the retire UPDATE never ran — the row is left standing so the next sweep can find it again");
    const remaining = d
      .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = 'verse_merge_conflict:MIC:ust'`)
      .all()[0].n;
    assert(remaining === 1, "…and the banner is untouched too, consistent with the row it names still standing");
  }

  // Cases 5-7 (Codex 2nd-pass review on #761): each pair's scoped retire and its
  // banner clears commit as ONE atomic D1 batch PER PAIR, so a failure after the
  // retire can no longer strand a resolved row whose banner never came down, and
  // no single batch grows past D1's 100-statement cap. All drive the REAL async
  // retireVerseKeptAiMasterFlags against a D1 shim whose .batch() runs the
  // statements (or, with failBatch, throws before applying any of them — the way
  // an all-or-nothing D1 batch rolls back; or, with capLimit, throws when a batch
  // exceeds the cap — the way real D1 rejects an over-limit batch).
  const mkBatchEnv = (d, failBatch = false, capLimit = Infinity) => {
    const make = (sql) => ({
      bind: (...args) => ({
        _sql: sql,
        _args: args,
        all: async () => ({ results: d.prepare(sql).all(...args) }),
        run: async () => ({ meta: { changes: Number(d.prepare(sql).run(...args).changes) } }),
      }),
      all: async () => ({ results: d.prepare(sql).all() }),
      run: async () => ({ meta: { changes: Number(d.prepare(sql).run().changes) } }),
    });
    return {
      DB: {
        prepare: (sql) => make(sql),
        batch: async (stmts) => {
          if (failBatch) throw new Error("simulated transient D1 batch error");
          if (stmts.length > capLimit) throw new Error(`batch of ${stmts.length} exceeds D1 cap ${capLimit}`);
          return stmts.map((s) => ({ meta: { changes: Number(d.prepare(s._sql).run(...(s._args ?? [])).changes) } }));
        },
      },
    };
  };

  // Case 5 — happy path: a pure keep_ai_master backlog row + its banner are
  // retired and cleared together in the batch.
  {
    const d = verseDb();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('HAG','ult',2,9,'keep_ai_master','both_changed_ai_master',NULL,100)`,
    ).run();
    d.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, created_at)
       VALUES ('deferredreward','warning','verse_merge_conflict:HAG:ult','Sync flagged 1 verse(s) in HAG ULT...',100)`,
    ).run();

    const result = await retireVerseKeptAiMasterFlags(mkBatchEnv(d));
    assert(result.cleared === 1, "the atomic batch retires the one standing keep_ai_master row");
    const row = d
      .prepare(`SELECT resolved_at FROM verse_merge_conflicts WHERE book='HAG' AND resource='ult' AND verse=9`)
      .all()[0];
    assert(row.resolved_at !== null, "the row is marked resolved by the batch's retire UPDATE");
    const remaining = d
      .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = 'verse_merge_conflict:HAG:ult'`)
      .all()[0].n;
    assert(remaining === 0, "…and its banner is cleared in the SAME batch");
  }

  // Case 6 — atomicity: if the batch fails, NOTHING commits. The row stays
  // standing (resolved_at NULL) so the next sweep finds it again, and the
  // banner stays up — never the resolved-row-with-live-banner limbo the first
  // pass of this PR could leave on a post-UPDATE failure.
  {
    const d = verseDb();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('HAG','ult',2,9,'keep_ai_master','both_changed_ai_master',NULL,100)`,
    ).run();
    d.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, created_at)
       VALUES ('deferredreward','warning','verse_merge_conflict:HAG:ult','Sync flagged 1 verse(s) in HAG ULT...',100)`,
    ).run();

    const result = await retireVerseKeptAiMasterFlags(mkBatchEnv(d, true));
    assert(result.cleared === 0, "a failed batch reports 0 cleared");
    const row = d
      .prepare(`SELECT resolved_at FROM verse_merge_conflicts WHERE book='HAG' AND resource='ult' AND verse=9`)
      .all()[0];
    assert(row.resolved_at === null,
      "the row is left STANDING on a batch failure — retryable next sweep, not stranded resolved");
    const remaining = d
      .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = 'verse_merge_conflict:HAG:ult'`)
      .all()[0].n;
    assert(remaining === 1, "…and the banner is still up, consistent with the still-standing row");
  }

  // Case 7 — batch cap: with 150 distinct (book, resource) pairs, a single
  // global batch (retire + 150 DELETEs) would be 151 statements and breach
  // D1's 100-statement cap, failing forever. Per-pair batching keeps every
  // batch at 2 statements, so all 150 retire and clear. The shim throws if any
  // batch exceeds 100, so this test FAILS against a one-global-batch impl.
  {
    const d = verseDb();
    for (let i = 0; i < 150; i++) {
      const book = `B${i}`;
      d.prepare(
        `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
         VALUES (?, 'ult', 1, 1, 'keep_ai_master', 'both_changed_ai_master', NULL, 100)`,
      ).run(book);
      d.prepare(
        `INSERT INTO system_alerts (username, severity, source, message, created_at)
         VALUES ('deferredreward', 'warning', ?, 'Sync flagged 1 verse(s)...', 100)`,
      ).run(`verse_merge_conflict:${book}:ult`);
    }

    const result = await retireVerseKeptAiMasterFlags(mkBatchEnv(d, false, 100));
    assert(result.cleared === 150, "all 150 pairs retire under the 100-statement batch cap (per-pair batching)");
    const standing = d
      .prepare(`SELECT COUNT(*) AS n FROM verse_merge_conflicts WHERE action='keep_ai_master' AND resolved_at IS NULL`)
      .all()[0].n;
    assert(standing === 0, "no keep_ai_master row is left standing");
    const banners = d.prepare(`SELECT COUNT(*) AS n FROM system_alerts`).all()[0].n;
    assert(banners === 0, "every pair's banner is cleared");
  }

  // Case 8 — P1 (Codex #761 3rd-pass review): the source-wide clear must NOT
  // erase a keep_no_base warning that lands in the read→batch race window.
  // keep_no_base writes no verse_merge_conflicts row, so the DELETE's NOT EXISTS
  // guard cannot see it; the message-fingerprint guards are what protect it.
  // Driven at the SQL level (like clearResolvedBanner above) so it pins the
  // exact production DELETE text: a source with one conflict-only alert and one
  // no-base alert, no active conflict row — the DELETE removes only the
  // conflict-only one.
  {
    const d = verseDb();
    const source = "verse_merge_conflict:HAG:ult";
    d.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, created_at)
       VALUES ('editorA','warning',?, 'Sync flagged 1 verse(s) in HAG ULT that were overwritten.',100)`,
    ).run(source);
    d.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, created_at)
       VALUES ('deferredreward','warning',?, ?,100)`,
    ).run(source, `2 verse(s) could not be adjudicated: ${NO_BASE_ADMIN_FINGERPRINT} for them.`);
    const changes = d.prepare(CLEAR_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL).run(source, "HAG", "ult").changes;
    assert(changes === 1, "source-wide clear deletes exactly the conflict-only alert");
    const rows = d.prepare(`SELECT message FROM system_alerts WHERE source = ?`).all(source);
    assert(
      rows.length === 1 && alertMessageCarriesNoBaseWarning(rows[0].message),
      "the keep_no_base warning survives the source-wide clear (P1)",
    );
  }

  // Case 9 — P2 (Codex #761 3rd-pass review): a single high-fan-out pair — one
  // no-base alert plus 100+ conflict-only alerts — must still retire and clear
  // under D1's 100-statement cap. The old mixed branch emitted one DELETE per
  // conflict-only username, so retire + 120 DELETEs = 121 statements breached
  // the cap, failed, and retried the same oversized batch forever. One
  // source-wide DELETE (now no-base-safe) keeps the batch at 2 statements. The
  // shim throws if any batch exceeds 100, so this FAILS against the old impl.
  {
    const d = verseDb();
    const source = "verse_merge_conflict:HAG:ult";
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('HAG','ult',2,9,'keep_ai_master','both_changed_ai_master',NULL,100)`,
    ).run();
    d.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, created_at)
       VALUES ('nobaseuser','warning',?, ?,100)`,
    ).run(source, `1 verse(s) could not be adjudicated: ${NO_BASE_ADMIN_FINGERPRINT}.`);
    for (let i = 0; i < 120; i++) {
      d.prepare(
        `INSERT INTO system_alerts (username, severity, source, message, created_at)
         VALUES (?, 'warning', ?, 'Sync flagged 1 verse(s) overwritten.', 100)`,
      ).run(`ed${i}`, source);
    }

    const result = await retireVerseKeptAiMasterFlags(mkBatchEnv(d, false, 100));
    assert(
      result.cleared === 1,
      "the pair retires under the 100-statement cap despite 120 conflict alerts + a no-base alert (P2)",
    );
    const remaining = d.prepare(`SELECT message FROM system_alerts WHERE source = ?`).all(source);
    assert(
      remaining.length === 1 && alertMessageCarriesNoBaseWarning(remaining[0].message),
      "only the no-base warning remains; all 120 conflict-only alerts cleared in one source-wide DELETE",
    );
  }
}

{
  // The two upsert rules the kept-D1 CONTENT outcomes share: such a row never
  // carries an overwritten_version pointer (nothing was overwritten, so the
  // pointer would misdirect a reviewer), and re-detecting it REACTIVATES a row a
  // human resolved without fixing the underlying disagreement — the condition is
  // still live, and unlike an adoption there is no CAS that could lose its race
  // and falsely reactivate.
  //
  // Issue #749: this block used to drive 'keep_ai_master' through both rules.
  // That action is retired (no new row is ever written), so the coverage moves
  // to 'source_attr_divergent', which shares the same carve-outs and IS still
  // written. The keep_ai_master-specific assertion that remains is the one that
  // matters now: it is no longer in either CASE list.
  const d = verseDb();
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 4, 2, "adopt_conflict", "both_changed", 9, null, 1000,
  );
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 4, 2, "source_attr_divergent", "source_attr_ambiguous", null, null, 2000,
  );
  let row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='AMO' AND chapter=4 AND verse=2`).get();
  assert(row.action === "source_attr_divergent" && row.overwritten_version === null,
    "a verse that becomes a kept-D1 content outcome drops any prior overwritten_version pointer");

  d.prepare(`UPDATE verse_merge_conflicts SET resolved_at=1500, resolved_by=30 WHERE book='AMO'`).run();
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 4, 2, "source_attr_divergent", "source_attr_ambiguous", null, null, 3000,
  );
  row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='AMO' AND chapter=4 AND verse=2`).get();
  assert(row.resolved_at === null && row.resolved_by === null,
    "re-detecting a kept-D1 content outcome reactivates a row resolved while the disagreement persists");

  // …and 'keep_ai_master' is out of both CASE lists (#749). Were a row of that
  // action to arrive now, it would neither NULL a live recovery pointer nor
  // reactivate a human's resolution — nothing writes it, and the nightly retire
  // is what takes the standing ones down.
  const d3 = verseDb();
  d3.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 6, 3, "adopt_conflict", "both_changed", 9, null, 1000,
  );
  d3.prepare(`UPDATE verse_merge_conflicts SET resolved_at=1500, resolved_by=30 WHERE book='AMO'`).run();
  d3.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 6, 3, "keep_ai_master", "both_changed_ai_master", null, null, 2000,
  );
  const aiRow = d3.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='AMO' AND chapter=6 AND verse=3`).get();
  assert(aiRow.overwritten_version === 9,
    "keep_ai_master no longer NULLs a recovery pointer (it is out of the overwritten_version CASE)");
  assert(aiRow.resolved_at === 1500 && aiRow.resolved_by === 30,
    "…and no longer reactivates a human's resolution (it is out of the reactivation carve-out)");

  // A later clean 'adopt' still takes a kept-D1 content row out of the banner —
  // the opposite of adopt_conflict's anti-downgrade rule, and deliberately so:
  // nothing was overwritten, so there is nothing to recover, and master's value
  // having been adopted since means the disagreement resolved.
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 4, 2, "adopt", "master_only", 11, null, 4000,
  );
  row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='AMO' AND chapter=4 AND verse=2`).get();
  assert(row.action === "adopt",
    "a later clean 'adopt' retires a kept-D1 content row from the banner");

  // …while adopt_conflict's own anti-downgrade is untouched by that.
  const d2 = verseDb();
  d2.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 5, 1, "adopt_conflict", "both_changed", 4, null, 1000,
  );
  d2.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 5, 1, "adopt", "master_only", 6, null, 2000,
  );
  assert(
    d2.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='AMO' AND chapter=5`).get().action === "adopt_conflict",
    "an adopt_conflict is still protected from a later routine adoption",
  );
}

{
  // Issue #728 review F5: 'keep_local_structure' is a STRUCTURE-dimension flag
  // (the nightly sync kept D1's verse-bridge shape, wrote nothing). Landing on a
  // verse whose UNRESOLVED adopt_conflict still waits for a human, it must not
  // relabel that row and NULL the recovery pointer the human needs — the other
  // keep actions do (they supersede the content decision); this one does not.
  const d = verseDb();
  d.prepare(`INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('PSA', 21, 1, 'ULT', 6)`).run();
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "PSA", "ult", 21, 1, "adopt_conflict", "both_changed", 5, null, 1000, null, null,
  );
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "PSA", "ult", 21, 1, "keep_local_structure", "master_moved_non_human", null, null, 2000, "ULT", 6,
  );
  let row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='PSA' AND chapter=21 AND verse=1`).get();
  assert(row.action === "adopt_conflict" && row.reason === "both_changed",
    "an UNRESOLVED adopt_conflict stays sticky against a later keep_local_structure");
  assert(row.overwritten_version === 5, "…and keeps its overwritten_version recovery pointer");
  assert(row.resolved_at === null && row.last_recorded_at === 2000, "…still active, and re-recorded tonight");

  // A RESOLVED adopt_conflict is NOT held sticky: keep_local_structure's
  // reactivation carve-out clears resolved_at (no CAS can make it lie), and
  // doing that on a row still labelled adopt_conflict would falsely claim
  // Door43 replaced the edit again. It becomes a keep_local_structure row like
  // any other kept-D1 flag: pointer NULL, active.
  d.prepare(`UPDATE verse_merge_conflicts SET resolved_at = 2500, resolved_by = 30 WHERE book='PSA'`).run();
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "PSA", "ult", 21, 1, "keep_local_structure", "master_moved_non_human", null, null, 3000, "ULT", 6,
  );
  row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='PSA' AND chapter=21 AND verse=1`).get();
  assert(row.action === "keep_local_structure" && row.reason === "master_moved_non_human",
    "a RESOLVED adopt_conflict gives way to the new keep_local_structure flag");
  assert(row.overwritten_version === null, "…with a NULL pointer (nothing was replaced tonight)");
  assert(row.resolved_at === null && row.resolved_by === null, "…reactivated, since the structural disagreement is live");
}

{
  // Re-saving the flagged verse resolves it, via the SAME action-agnostic
  // RESOLVE SQL every other conflict uses — no special path needed.
  const d = verseDb();
  d.prepare(`INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('EZK', 40, 21, 'ULT', 4)`).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('EZK','ult',40,21,'source_attr_divergent','source_attr_ambiguous',NULL,100)`,
  ).run();
  const res = saveVerse(d, { book: "EZK", resource: "ult", chapter: 40, verse: 21, matchVersion: 4, userId: 30, now: 200 });
  assert(res.verseChanged === 1 && res.conflictResolved === 1, "saving the verse resolves the source_attr_divergent flag");
  const active = d
    .prepare(`SELECT COUNT(*) c FROM verse_merge_conflicts WHERE book='EZK' AND resolved_at IS NULL`)
    .get().c;
  assert(active === 0, "no active conflict remains after the human re-saves");
}

{
  // REACTIVATION: a source_attr_divergent flag that a human resolved with an
  // UNRELATED save, while the divergence PERSISTS, must re-surface on the next
  // night's re-detection (this action has no CAS race, so reactivating in the
  // speculative upsert is safe — unlike adoptions). Without this it would go
  // silent forever and the export would keep reverting master's source fix.
  const d = verseDb();
  // Night 1: flagged, then resolved by an unrelated save.
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ult',40,21,'source_attr_divergent','source_attr_ambiguous',NULL,100,150,30,100)`,
  ).run();
  // Night 2: re-detected (divergence still present) → speculative re-upsert.
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 21, "source_attr_divergent", "source_attr_ambiguous", null, null, 2000, null, null,
  );
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=21`).get();
  assert(row.resolved_at === null && row.resolved_by === null,
    "re-detecting a resolved source_attr_divergent reactivates it (no CAS race → safe to clear in the upsert)");
  assert(row.detected_at === 100, "detected_at (age of the streak) is preserved across reactivation");

  // CONTROL: the carve-out is scoped — a re-upserted ADOPTION must NOT be
  // reactivated by the speculative upsert (the two-phase invariant stands).
  const d2 = verseDb();
  d2.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ult',40,22,'adopt_conflict','both_changed',7,100,150,30,100)`,
  ).run();
  d2.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 22, "adopt_conflict", "both_changed", 7, null, 2000, null, null,
  );
  const row2 = d2.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=22`).get();
  assert(row2.resolved_at === 150 && row2.resolved_by === 30,
    "an adoption's speculative re-upsert still leaves resolved_at/resolved_by untouched (carve-out does not leak)");
}

{
  // REACTIVATION (issue #457): 'keep_alignment_refused' shares the same
  // no-CAS-race safety as 'source_attr_divergent', so it gets the same
  // carve-out — a refusal a human resolved with an UNRELATED save, while the
  // alignment conflict PERSISTS, must re-surface on the next night's
  // re-detection instead of going silent forever.
  const d = verseDb();
  // Night 1: flagged, then resolved by an unrelated save.
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ult',40,21,'keep_alignment_refused','alignment_loss',NULL,100,150,30,100)`,
  ).run();
  // Night 2: re-detected (refusal still holds) → speculative re-upsert.
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 21, "keep_alignment_refused", "alignment_loss", null, null, 2000, null, null,
  );
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=21`).get();
  assert(row.resolved_at === null && row.resolved_by === null,
    "re-detecting a resolved keep_alignment_refused reactivates it (no CAS race → safe to clear in the upsert)");
  assert(row.detected_at === 100, "detected_at (age of the streak) is preserved across reactivation");

  // CONTROL: an adoption re-upserted alongside is still untouched — the
  // widened carve-out must not leak into 'adopt' / 'adopt_conflict'.
  const d2 = verseDb();
  d2.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ult',40,22,'adopt_conflict','both_changed',7,100,150,30,100)`,
  ).run();
  d2.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 22, "adopt_conflict", "both_changed", 7, null, 2000, null, null,
  );
  const row2 = d2.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=22`).get();
  assert(row2.resolved_at === 150 && row2.resolved_by === 30,
    "an adoption's speculative re-upsert still leaves resolved_at/resolved_by untouched (widened carve-out does not leak)");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 8 (issue #507): VERSION GUARD on the reactivation carve-out. The
// speculative upsert's detection was read EARLIER in the same
// applyVerseRows call (bookReimport.ts's `ex.version`) than the moment this
// statement executes. If a human saves the verse AND resolves the conflict
// row in that window, the detection is stale — reactivating would destroy a
// fresh, legitimate resolution and raise a false alert for a condition that
// may already be gone. The guard: only reactivate when the verse's CURRENT
// version (read live, at upsert time) still matches the version the
// detection was read at.
// ─────────────────────────────────────────────────────────────────────────

{
  // *** THE EXACT #507 SCENARIO ***: a human saves a fix (bumping the verse's
  // version) AND resolves the conflict row, in the window between the
  // detection read and the speculative upsert. The upsert's observedVersion
  // (the STALE version from the detection read) no longer matches the verse's
  // CURRENT version — reactivation must be withheld, preserving the fresh
  // resolution's audit trail intact.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('EZK', 40, 21, 'ULT', 5)`,
  ).run();
  // A human resolves the conflict (their save bumped the verse to version 5).
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ult',40,21,'source_attr_divergent','source_attr_ambiguous',NULL,100,150,30,100)`,
  ).run();
  // Tonight's sync re-detects the SAME condition, but its detection read
  // happened BEFORE the human's save landed — it observed version 4, not the
  // verse's current version (5).
  upsertConflict(d, {
    book: "EZK", resource: "ult", chapter: 40, verse: 21,
    action: "source_attr_divergent", reason: "source_attr_ambiguous", overwrittenVersion: null,
    now: 2000, bibleVersion: "ULT", observedVersion: 4,
  });
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=21`).get();
  assert(row.resolved_at === 150 && row.resolved_by === 30,
    "stale detection (observedVersion != current verses.version) does NOT reactivate — the fresh resolution survives");
}

{
  // CONTROL: same shape, but NOTHING raced — the detection's observedVersion
  // matches the verse's current version (no save happened in the window).
  // Reactivation must proceed normally, exactly as the pre-#507 behavior did.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('EZK', 40, 21, 'ULT', 4)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ult',40,21,'source_attr_divergent','source_attr_ambiguous',NULL,100,150,30,100)`,
  ).run();
  upsertConflict(d, {
    book: "EZK", resource: "ult", chapter: 40, verse: 21,
    action: "source_attr_divergent", reason: "source_attr_ambiguous", overwrittenVersion: null,
    now: 2000, bibleVersion: "ULT", observedVersion: 4,
  });
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=21`).get();
  assert(row.resolved_at === null && row.resolved_by === null,
    "matching observedVersion (no race) reactivates normally, unregressed from the pre-#507 behavior");
}

{
  // Same race scenario, for 'keep_alignment_refused' — the other action the
  // carve-out (and therefore the version guard) applies to.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('EZK', 41, 3, 'UST', 9)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ust',41,3,'keep_alignment_refused','alignment_shrink',NULL,100,150,30,100)`,
  ).run();
  upsertConflict(d, {
    book: "EZK", resource: "ust", chapter: 41, verse: 3,
    action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null,
    now: 2000, bibleVersion: "UST", observedVersion: 8,
  });
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=41 AND verse=3`).get();
  assert(row.resolved_at === 150 && row.resolved_by === 30,
    "keep_alignment_refused: stale detection also withholds reactivation, preserving the fresh resolution");
}

{
  // Same race scenario, for 'keep_local_structure' (#728) — the third action the
  // reactivation carve-out (and therefore the version guard) applies to. Same
  // no-CAS-race shape as the other two, so it must get the same protection.
  // (This case covered 'keep_ai_master' until #749 retired that action out of
  // the carve-out entirely; the block above proves it is gone from it.)
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('AMO', 4, 2, 'ULT', 6)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('AMO','ult',4,2,'keep_local_structure','master_moved_non_human',NULL,100,150,30,100)`,
  ).run();
  upsertConflict(d, {
    book: "AMO", resource: "ult", chapter: 4, verse: 2,
    action: "keep_local_structure", reason: "master_moved_non_human", overwrittenVersion: null,
    now: 2000, bibleVersion: "ULT", observedVersion: 5,
  });
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='AMO' AND chapter=4 AND verse=2`).get();
  assert(row.resolved_at === 150 && row.resolved_by === 30,
    "keep_local_structure: stale detection also withholds reactivation, preserving the fresh resolution");
}

{
  // buildMergeConflictGuidance classifies by ACTION: a source_attr_divergent
  // row is a KEPT-D1 outcome — it must say "kept D1" / "NOT been taken" and
  // must NEVER claim "took Door43's version" (the misdirection bug the
  // action-keyed classification exists to prevent).
  const g = buildMergeConflictGuidance([{ action: "source_attr_divergent" }]);
  assert(g.includes("kept D1"), "source_attr_divergent guidance says the editor's D1 was kept");
  assert(g.includes("NOT been taken"), "…and warns the export will still revert master until resolved");
  assert(!g.includes("took Door43's version"), "…and never reports it as an overwrite");

  // A mixed set is counted per-action, not lumped: one adopt_conflict is an
  // overwrite, one source_attr_divergent is a kept-D1 divergence. A real
  // pointer (overwrittenVersion set) so this exercises the overwrite branch,
  // not the #981 pointer-less one tested above.
  const mixed = buildMergeConflictGuidance([
    { action: "adopt_conflict", overwrittenVersion: 1 },
    { action: "source_attr_divergent", overwrittenVersion: null },
    { action: "keep_alignment_refused", overwrittenVersion: null },
  ]);
  assert(mixed.includes("1 took Door43's version"), "adopt_conflict counted as an overwrite");
  assert(mixed.includes("1 kept the editor's version because adopting Door43's would have cost alignment"),
    "keep_alignment_refused counted as an alignment refusal");
  assert(mixed.includes("1 kept D1 because Door43's original-language source fix"),
    "source_attr_divergent counted as a source-attr divergence, separately from the alignment refusal");

  // Issue #749: keep_ai_master no longer has a sentence here, because it no
  // longer has a row. It was the one kept-D1 outcome where nothing is waiting to
  // be reverted — the export publishes the kept version — so the banner had
  // nothing to ask, yet the verse stayed in the flagged count until a human
  // edited or dismissed it. The dead branch is removed rather than left inert.
  const ai = buildMergeConflictGuidance([{ action: "keep_ai_master" }]);
  assert(ai === "", "a keep_ai_master row produces no guidance sentence at all (#749)");

  const withAi = buildMergeConflictGuidance([{ action: "adopt_conflict", overwrittenVersion: 1 }, { action: "keep_ai_master" }]);
  assert(withAi.includes("1 took Door43's version"),
    "…and its presence does not disturb the adopt_conflict count beside it");
  assert(!withAi.includes("kept the editor's version even though Door43 changed too"),
    "…with no kept-over-Door43 sentence added for it");

  // The per-run admin alert for the same outcome at scale
  // (reimportSyncGate.ts's `reimport_kept_over_door43`) is a separate,
  // dismissable surface and is deliberately out of scope here.
}

{
  // Issue #537. The keep_no_base sentence must NAME the verses it says tonight's
  // export may overwrite, and must not assert a cause we did not measure.
  const g = buildMergeConflictGuidance([], { noBaseCount: 3, noBaseRefs: ["40:5", "42:2", "42:3"] });
  assert(g.includes("40:5, 42:2, 42:3"), "no-ancestor sentence lists the refs it is talking about");
  assert(g.includes("3 verse(s) could not be adjudicated"), "…and still reports the count");
  assert(!g.includes("more"), "…with no '+N more' when every ref was listed");

  // The cause claim. Prod on 2026-08-19: edit_log spanned 93 days, so the
  // 180-day sweep had deleted nothing and "aged out" described none of the 190
  // verses then in this state. The sentence may only say what is measured.
  assert(!/aged out/i.test(g), "…and never claims the history 'aged out' (a cause we did not measure)");
  // Nor may the replacement overclaim: `base === null` also covers a payload
  // that exists but carries no parseable content, where the ancestor DID
  // survive and merely wasn't recoverable. "recoverable" is the measured word.
  assert(g.includes("no ancestor was recoverable"), "…it states only the measured fact: not recoverable");
  assert(!/survives/i.test(g), "…and does not claim the ancestor is gone, only that it could not be recovered");
  // The lookup is per verse (row_key = book/chapter/verse/RESOURCE), so the
  // sentence must not read as "this book's history is lost".
  assert(!/this book's edit history/i.test(g), "…and does not overstate the lookup as book-wide");
  // Nothing was overwritten in a keep_no_base verse — the reader must not go
  // hunting version history for a replaced value that does not exist.
  assert(g.includes("Nothing was overwritten"), "…and says nothing was overwritten yet");

  // The ref list is a capped sample; '+N more' counts against what was actually
  // listed, never against the cap, and the authoritative count still leads.
  const OVER = NO_BASE_REF_DISPLAY + 2;
  const many = buildMergeConflictGuidance([], {
    noBaseCount: 59,
    noBaseRefs: Array.from({ length: OVER }, (_, i) => `28:${i + 1}`),
  });
  assert(many.includes("59 verse(s)"), "count stays authoritative when the ref sample is short");
  assert(many.includes(`28:${NO_BASE_REF_DISPLAY}`), "…lists up to the display cap");
  assert(!many.includes(`28:${NO_BASE_REF_DISPLAY + 1}`), "…and no further");
  assert(many.includes(`+${59 - NO_BASE_REF_DISPLAY} more`), "…and '+N more' is the count minus what was actually listed");
  // "sample", not a plain list: on a mixed run the listed refs are not
  // necessarily the first N, so the remainder is not a contiguous tail.
  assert(many.includes("Verses (sample):"), "…and labels the list as a sample, not an ordered prefix");

  // Never list more refs than the count claims (the helper is exported, so the
  // invariant is enforced rather than assumed from its only caller).
  const overListed = buildMergeConflictGuidance([], { noBaseCount: 2, noBaseRefs: ["1:1", "1:2", "1:3", "1:4"] });
  assert(overListed.includes("1:1, 1:2."), "lists at most `count` refs…");
  assert(!overListed.includes("1:3"), "…never more than it claims");

  // A Workflow chunk memoized before refs were collected contributes a count and
  // no refs. Say nothing about where, rather than guess.
  const noRefs = buildMergeConflictGuidance([], { noBaseCount: 5 });
  assert(noRefs.includes("5 verse(s) could not be adjudicated"), "count-only still reports the count");
  assert(!noRefs.includes("Verses:"), "…and omits the ref clause rather than printing an empty one");
  assert(!noRefs.includes("more"), "…and claims no '+N more' it cannot substantiate");

  // Zero is not a story: no sentence at all.
  assert(buildMergeConflictGuidance([], { noBaseCount: 0 }) === "", "no no-ancestor sentence when the count is 0");
}

// ─────────────────────────────────────────────────────────────────────────
// buildGroupedRefsClause — pure, no D1 (issue #624).
// ─────────────────────────────────────────────────────────────────────────

function ts(dateStr) {
  return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000);
}

{
  // A mixed-reason row set (the real 2026-08-25 JER UST alert's shape, minus
  // the extra source_attr_ambiguous rows) produces refs grouped under their
  // own reason, each carrying the OLDEST detected_at in that reason as a
  // plain date — not the newest, and not the first-seen row's date.
  const rows = [
    { chapter: 38, verse: 2, reason: "both_changed_ai_master", overwrittenVersion: null, detectedAt: ts("2026-08-24") },
    { chapter: 41, verse: 9, reason: "source_attr_ambiguous", overwrittenVersion: null, detectedAt: ts("2026-08-19") },
    { chapter: 41, verse: 12, reason: "source_attr_ambiguous", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 41, verse: 16, reason: "source_attr_ambiguous", overwrittenVersion: null, detectedAt: ts("2026-08-19") },
    { chapter: 42, verse: 6, reason: "both_changed_ai_master", overwrittenVersion: null, detectedAt: ts("2026-08-25") },
    { chapter: 42, verse: 8, reason: "alignment_shrink", overwrittenVersion: 7, detectedAt: ts("2026-08-22") },
  ];
  const clause = buildGroupedRefsClause(rows);
  assert(
    clause.includes("both_changed_ai_master: 38:2, 42:6 (first flagged 2026-08-24)."),
    "both_changed_ai_master group lists both its refs, dated by its OLDEST row (38:2), not its newest (42:6)",
  );
  assert(
    clause.includes("source_attr_ambiguous: 41:9, 41:12, 41:16 (first flagged 2026-08-19)."),
    "source_attr_ambiguous group lists all three refs, dated by the oldest of the two 2026-08-19 rows",
  );
  assert(
    clause.includes("alignment_shrink: 42:8@v7 (first flagged 2026-08-22)."),
    "alignment_shrink group carries its own single ref and date, and the overwritten-version suffix survives grouping",
  );
  // Reason order follows first appearance in `rows` — same order
  // reasonBreakdown (built from the same array) would produce — not
  // alphabetical and not grouped-size order.
  const bothIdx = clause.indexOf("both_changed_ai_master");
  const sourceIdx = clause.indexOf("source_attr_ambiguous");
  const alignIdx = clause.indexOf("alignment_shrink");
  assert(bothIdx < sourceIdx && sourceIdx < alignIdx, "groups appear in first-seen order, matching reasonBreakdown's order");
  assert(!clause.includes("more"), "no '+N more' when every row fit under the cap");
}

{
  // A single-reason set (the common case pre-#624) must not regress: one
  // group, its own date, no stray formatting from the grouping machinery.
  const rows = [
    { chapter: 12, verse: 4, reason: "keep_alignment_refused", overwrittenVersion: null, detectedAt: ts("2026-08-10") },
    { chapter: 12, verse: 5, reason: "keep_alignment_refused", overwrittenVersion: null, detectedAt: ts("2026-08-12") },
  ];
  const clause = buildGroupedRefsClause(rows);
  assert(
    clause.trim() === "keep_alignment_refused: 12:4, 12:5 (first flagged 2026-08-10).",
    "a single-reason set collapses to one group, dated by its oldest row",
  );
}

{
  // The overall display cap is GLOBAL, exactly like the flat "Refs: …; +N
  // more" it replaces — not reapplied per reason. And critically: a group's
  // date must reflect its OLDEST row even when that row itself falls PAST
  // the cap and is never printed as a ref — capping what's shown is not
  // license to understate how long the reason has been flagged.
  const rows = [
    { chapter: 1, verse: 1, reason: "a", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 1, verse: 2, reason: "a", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 2, verse: 1, reason: "b", overwrittenVersion: null, detectedAt: ts("2026-08-01") },
    { chapter: 2, verse: 2, reason: "b", overwrittenVersion: null, detectedAt: ts("2026-08-01") },
    // The true oldest "a" row — past the cap of 3, never displayed as a ref.
    { chapter: 3, verse: 1, reason: "a", overwrittenVersion: null, detectedAt: ts("2026-08-05") },
  ];
  const clause = buildGroupedRefsClause(rows, 3);
  assert(clause.includes("a: 1:1, 1:2, +1 more (first flagged 2026-08-05)."),
    "group 'a's date is its true oldest row (2026-08-05) — and its own '+1 more' says the dated row is one it did not list");
  assert(!clause.includes("3:1"), "the past-cap row itself is not listed as a ref");
  assert(clause.includes("b: 2:1, +1 more (first flagged 2026-08-01)."),
    "reason 'b' is truncated in its own group too, rather than by a trailing count that reads as 'a's");
  assert(!/\+\d+ more\./.test(clause.replace(/\+\d+ more \(/g, "")),
    "no free-floating global remainder: every hidden row is counted inside the group it belongs to");
}

{
  // PR #630 review F1, the measured motivation: a reason whose every row sorts
  // past the cap used to vanish from the clause entirely. That is exactly
  // backwards — the rare reason is the one needing hand work, and the crowded
  // one is what a reader can already infer from the count parenthetical.
  // Round-robin gives every reason its first ref before any gets a second.
  const rows = [
    { chapter: 1, verse: 1, reason: "a", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 1, verse: 2, reason: "a", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 2, verse: 1, reason: "b", overwrittenVersion: null, detectedAt: ts("2026-08-01") },
  ];
  const clause = buildGroupedRefsClause(rows, 2);
  assert(/\bb: 2:1\b/.test(clause), "reason 'b', last in chapter order, still names its ref instead of being capped away");
  assert(clause.includes("a: 1:1, +1 more"), "…the crowded reason yields the slot, and says so in its own group");
  assert(!clause.includes("1:2"), "…so 'a's second ref is the one dropped, not 'b's only ref");
}

{
  // The one case that can still omit a group outright: more distinct reasons
  // than the cap has slots. Those rows are reported in a trailing clause that
  // says what it is, rather than silently discarded or folded into the last
  // group's own overflow.
  const rows = [
    { chapter: 1, verse: 1, reason: "a", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 2, verse: 1, reason: "b", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 3, verse: 1, reason: "c", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 3, verse: 2, reason: "c", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
  ];
  const clause = buildGroupedRefsClause(rows, 2);
  assert(/\ba: 1:1\b/.test(clause) && /\bb: 2:1\b/.test(clause), "the reasons that fit are listed");
  assert(!/\bc:/.test(clause), "reason 'c' has no slot left — the cap is smaller than the reason count");
  assert(clause.includes("+2 more in reasons not listed."),
    "…and its rows are counted in a clause naming them as a different reason, not as 'b's overflow");
}

{
  // Empty input -> empty string, so the caller's message template does not
  // grow a stray leading space when there is nothing to report.
  assert(buildGroupedRefsClause([]) === "", "no rows -> no clause");
}

{
  // A row with no detectedAt (the write path never sets it — see
  // VerseMergeConflictRow.detectedAt's doc comment) must not crash the
  // formatter or fabricate a date; it degrades to no date for that group.
  const rows = [{ chapter: 5, verse: 5, reason: "keep_alignment_refused", overwrittenVersion: null, detectedAt: undefined }];
  const clause = buildGroupedRefsClause(rows);
  assert(clause.trim() === "keep_alignment_refused: 5:5.", "a row with no detectedAt formats with no date, not 'undefined'");
}

{
  // Default cap matches the exported constant (and therefore the pre-#624
  // flat-list behavior) when the caller does not pass one explicitly.
  const rows = Array.from({ length: MERGE_CONFLICT_REFS_DISPLAY + 1 }, (_, i) => ({
    chapter: 1,
    verse: i + 1,
    reason: "keep_alignment_refused",
    overwrittenVersion: null,
    detectedAt: ts("2026-08-01"),
  }));
  const clause = buildGroupedRefsClause(rows);
  // Asserting on `1:10`, not the bare "10": the loose form also matches the
  // "+10 more" tail, so it never actually proved the 10th ref was listed.
  assert(clause.includes(`1:${MERGE_CONFLICT_REFS_DISPLAY}`), "default cap lists up to MERGE_CONFLICT_REFS_DISPLAY refs");
  assert(!clause.includes(`1:${MERGE_CONFLICT_REFS_DISPLAY + 1}`), "…and no further");
  assert(clause.includes("+1 more"), "…and reports the one remaining row, inside the group it belongs to");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 9 (issue #789): resolveConvergedVerseMergeConflicts. A standing
// keep_alignment_refused / source_attr_divergent / keep_local_structure row
// is only ever resolved by a human saving that verse — nothing resolves it
// when the SAME verse later converges with master (computeVerseMerge's
// keep_converged / keep_master_unchanged outcomes write no
// verse_merge_conflicts row of their own). Driven against the REAL async
// function with a D1 shim (mkBatchEnv-style, local to this Part), so these
// exercise the actual backlog-read + intersect + batched-UPDATE + banner-clear
// control flow, not a hand replica of it.
// ─────────────────────────────────────────────────────────────────────────

{
  const mkEnv = (d, opts = {}) => {
    const { failBatch = false, beforeBatch = null } = opts;
    const make = (sql) => ({
      bind: (...args) => ({
        _sql: sql,
        _args: args,
        all: async () => ({ results: d.prepare(sql).all(...args) }),
        run: async () => ({ meta: { changes: Number(d.prepare(sql).run(...args).changes) } }),
      }),
      all: async () => ({ results: d.prepare(sql).all() }),
      run: async () => ({ meta: { changes: Number(d.prepare(sql).run().changes) } }),
    });
    return {
      DB: {
        prepare: (sql) => make(sql),
        batch: async (stmts) => {
          if (failBatch) throw new Error("simulated transient D1 batch error");
          if (beforeBatch) beforeBatch();
          return stmts.map((s) => ({ meta: { changes: Number(d.prepare(s._sql).run(...(s._args ?? [])).changes) } }));
        },
      },
    };
  };

  // Case 1 (the issue's own success check, first bullet): a verse converges
  // with master (keep_converged/keep_master_unchanged) — its open
  // keep_alignment_refused row is resolved, system-retired
  // (resolved_by NULL), not left for a human to clear.
  {
    const d = verseDb();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('EZK','ult',37,21,'keep_alignment_refused','alignment_shrink',NULL,100)`,
    ).run();

    const result = await resolveConvergedVerseMergeConflicts(mkEnv(d), "EZK", "ult", [{ chapter: 37, verse: 21 }]);
    assert(result.resolved === 1, "the one converged verse's backlog row is resolved");

    const row = d
      .prepare(`SELECT resolved_at, resolved_by FROM verse_merge_conflicts WHERE book='EZK' AND chapter=37 AND verse=21`)
      .get();
    assert(row.resolved_at !== null, "resolved_at is stamped");
    assert(row.resolved_by === null, "resolved_by is NULL — the documented system-retired marker, never a human id");
  }

  // Case 2 (second bullet): a verse that still shrinks (still conflicted) is
  // never passed in convergedRefs at all — the same shape bookReimport.ts's
  // loop produces (it only pushes a ref when mergeAction is keep_converged /
  // keep_master_unchanged). The row stays open exactly as recordVerseMergeConflicts
  // left it.
  {
    const d = verseDb();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, last_recorded_at)
       VALUES ('EZK','ult',46,9,'keep_alignment_refused','alignment_shrink',NULL,100,100)`,
    ).run();

    // Some OTHER verse converged this run; 46:9 did not, so it is absent from
    // convergedRefs — mirroring what the real loop would produce.
    const result = await resolveConvergedVerseMergeConflicts(mkEnv(d), "EZK", "ult", [{ chapter: 1, verse: 1 }]);
    assert(result.resolved === 0, "a verse absent from convergedRefs resolves nothing");

    const row = d
      .prepare(`SELECT resolved_at FROM verse_merge_conflicts WHERE book='EZK' AND chapter=46 AND verse=9`)
      .get();
    assert(row.resolved_at === null, "the still-refused row stays open");
  }

  // Case 3 (third bullet): an adopt_conflict row must never be touched here —
  // that action records a landed adoption a human is meant to review, and
  // only their own save resolves it. Proven even when the verse is (wrongly,
  // defensively) included in convergedRefs: SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL
  // returns adopt_conflict rows too, but the action filter this function
  // applies on top of that read excludes them from the backlog set entirely.
  {
    const d = verseDb();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('JER','ust',31,29,'adopt_conflict','both_changed',12,100)`,
    ).run();

    const result = await resolveConvergedVerseMergeConflicts(mkEnv(d), "JER", "ust", [{ chapter: 31, verse: 29 }]);
    assert(result.resolved === 0, "an adopt_conflict row is never counted as resolved by this path");

    const row = d
      .prepare(`SELECT resolved_at, action FROM verse_merge_conflicts WHERE book='JER' AND chapter=31 AND verse=29`)
      .get();
    assert(row.resolved_at === null && row.action === "adopt_conflict",
      "the adopt_conflict row is completely untouched — still open, still its original action");
  }

  // Case 4: the banner follows — once the LAST active alertable conflict for
  // a (book, resource) resolves this way, the materialized "Sync flagged"
  // banner clears too (same shape as #760's keep_ai_master retirement).
  {
    const d = verseDb();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('DAN','ust',5,7,'keep_alignment_refused','alignment_shrink',NULL,100)`,
    ).run();
    d.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, created_at)
       VALUES ('deferredreward','warning','verse_merge_conflict:DAN:ust','Sync flagged 1 verse(s) in DAN UST...',100)`,
    ).run();

    const result = await resolveConvergedVerseMergeConflicts(mkEnv(d), "DAN", "ust", [{ chapter: 5, verse: 7 }]);
    assert(result.resolved === 1, "the sole standing row resolves");
    const remaining = d
      .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = 'verse_merge_conflict:DAN:ust'`)
      .get().n;
    assert(remaining === 0, "…and its banner clears in the same call, not left for a later sweep");
  }

  // Case 5: the banner must NOT clear while another active conflict for the
  // same (book, resource) survives — clearResolvedConflictBannerIfLast's own
  // re-check, exercised end to end through this function.
  {
    const d = verseDb();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('JER','ust',38,2,'keep_alignment_refused','alignment_shrink',NULL,100)`,
    ).run();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('JER','ust',45,5,'source_attr_divergent','source_attr_ambiguous',NULL,100)`,
    ).run();
    d.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, created_at)
       VALUES ('deferredreward','warning','verse_merge_conflict:JER:ust','Sync flagged 2 verse(s) in JER UST...',100)`,
    ).run();

    // Only 38:2 converged this run; 45:5 is still standing.
    const result = await resolveConvergedVerseMergeConflicts(mkEnv(d), "JER", "ust", [{ chapter: 38, verse: 2 }]);
    assert(result.resolved === 1, "the converged verse's row resolves");
    const remaining = d
      .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ust'`)
      .get().n;
    assert(remaining === 1, "…but the banner stays up — 45:5 still justifies it");
  }

  // Case 6: no backlog at all for the (book, resource) — the cheap common
  // case (most books never had a refusal). No UPDATE is attempted.
  {
    const d = verseDb();
    const result = await resolveConvergedVerseMergeConflicts(mkEnv(d), "MAL", "ult", [
      { chapter: 1, verse: 1 },
      { chapter: 1, verse: 2 },
    ]);
    assert(result.resolved === 0, "an empty backlog resolves nothing, without error");
  }

  // Case 7: no converged refs at all this call — short-circuits before even
  // reading the backlog (bookReimport.ts only calls this when convergedRefs
  // is non-empty, but the function must be safe called either way).
  {
    const d = verseDb();
    const result = await resolveConvergedVerseMergeConflicts(mkEnv(d), "MAL", "ult", []);
    assert(result.resolved === 0, "an empty convergedRefs list is a no-op");
  }

  // Case 8: best-effort — a batch failure must not throw out of this
  // function (it runs inline in applyVerseRows, which must not fail the
  // whole reimport over banner housekeeping), and must leave the row
  // standing for the next run to retry.
  {
    const d = verseDb();
    d.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
       VALUES ('EZK','ust',44,18,'source_attr_divergent','source_attr_ambiguous',NULL,100)`,
    ).run();

    const result = await resolveConvergedVerseMergeConflicts(mkEnv(d, { failBatch: true }), "EZK", "ust", [
      { chapter: 44, verse: 18 },
    ]);
    assert(result.resolved === 0, "a failed batch reports 0 resolved rather than throwing");
    const row = d
      .prepare(`SELECT resolved_at FROM verse_merge_conflicts WHERE book='EZK' AND chapter=44 AND verse=18`)
      .get();
    assert(row.resolved_at === null, "…and the row is left standing, retried on the next run");
  }

  // Case 9: a concurrent reimport re-recording the same key after the backlog
  // read increments its generation. The stale cleanup CAS must not resolve it.
  {
    const d = verseDb();
    d.prepare(
      `INSERT INTO verse_merge_conflicts
         (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, last_recorded_at)
       VALUES ('EZK','ust',47,1,'keep_alignment_refused','alignment_shrink',NULL,100,100)`,
    ).run();

    const result = await resolveConvergedVerseMergeConflicts(
      mkEnv(d, {
        beforeBatch: () => d.prepare(
          `UPDATE verse_merge_conflicts
              SET last_recorded_at = 200, recorded_generation = recorded_generation + 1
            WHERE book='EZK' AND resource='ust' AND chapter=47 AND verse=1`,
        ).run(),
      }),
      "EZK",
      "ust",
      [{ chapter: 47, verse: 1 }],
    );
    assert(result.resolved === 0, "a concurrently re-recorded conflict defeats the stale cleanup CAS");
    const row = d.prepare(
      `SELECT resolved_at, recorded_generation FROM verse_merge_conflicts
        WHERE book='EZK' AND resource='ust' AND chapter=47 AND verse=1`,
    ).get();
    assert(row.resolved_at === null && row.recorded_generation === 1,
      "the fresh conflict remains active at its newer generation");
  }
}

// Stage 7: a failed conflict-recording batch is itself actionable measured
// state. It must raise the explicit incomplete-report warning while preserving
// fan-out recipients that may be absent only because the table write failed.
{
  const d = verseDb();
  d.exec(`ALTER TABLE system_alerts ADD COLUMN kind TEXT NOT NULL DEFAULT 'review';
    ALTER TABLE system_alerts ADD COLUMN condition_key TEXT;
    ALTER TABLE system_alerts ADD COLUMN resolved_at INTEGER;
    ALTER TABLE system_alerts ADD COLUMN condition_observed_at INTEGER;
    CREATE UNIQUE INDEX system_alerts_one_standing_review_test
      ON system_alerts(username, source)
      WHERE kind='review' AND condition_key IS NOT NULL AND dismissed_at IS NULL AND resolved_at IS NULL;`);
  d.prepare(
    `INSERT INTO system_alerts
       (username,severity,source,message,kind,condition_key,condition_observed_at)
     VALUES ('bethoakes','warning','verse_merge_conflict:JER:ult','prior editor condition','review','old-editor',50)`,
  ).run();
  const make = (sql, args = []) => ({
    bind: (...next) => make(sql, next),
    all: async () => ({ results: d.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(d.prepare(sql).run(...args).changes) } }),
  });
  await raiseVerseMergeConflictAlert({ DB: { prepare: (sql) => make(sql) } }, "JER", "ult", {
    recordingFailed: true,
    observedAt: 100,
  });
  const admin = d.prepare(
    `SELECT message FROM system_alerts
      WHERE username='deferredreward' AND source='verse_merge_conflict:JER:ult' AND resolved_at IS NULL`,
  ).get();
  assert(admin?.message.includes("recording failed"), "a recording failure raises the explicit incomplete-report warning");
  const editor = d.prepare(
    `SELECT resolved_at FROM system_alerts
      WHERE username='bethoakes' AND source='verse_merge_conflict:JER:ult'`,
  ).get();
  assert(editor?.resolved_at === null, "an incomplete run does not retire an omitted editor recipient");
}

// Issue #978: the #539 no-op guard keeps a CONFLICTED byte no-op as
// adopt_conflict with overwritten_version NULL (nothing was replaced). When the
// verse already holds an audit-only adopt / adopt_no_visible_change row with a
// pointer, the upsert promotes the row to adopt_conflict; it must not carry the
// old pointer along, or the editor fan-out (adopt_conflict + non-null pointer)
// tells the author of that old version "Door43 overwrote your edits @v3" about
// an overwrite that did not happen tonight. The admin banner still lists it.
console.log("\n[a no-op adopt_conflict does not inherit an old audit row's pointer (issue #978)]");
{
  const d = verseDb();
  d.exec(`ALTER TABLE system_alerts ADD COLUMN kind TEXT NOT NULL DEFAULT 'review';
    ALTER TABLE system_alerts ADD COLUMN condition_key TEXT;
    ALTER TABLE system_alerts ADD COLUMN resolved_at INTEGER;
    ALTER TABLE system_alerts ADD COLUMN condition_observed_at INTEGER;
    CREATE TABLE users (id INTEGER PRIMARY KEY, dcs_username TEXT);
    CREATE TABLE edit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, row_key TEXT, book TEXT,
      user_id INTEGER, new_version INTEGER);`);
  // v3 was authored by bethoakes — the version the old audit row points at.
  d.prepare(`INSERT INTO users (id, dcs_username) VALUES (7, 'bethoakes')`).run();
  d.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, new_version) VALUES ('verse', 'MIC/5/11/UST', 'MIC', 7, 3)`,
  ).run();
  for (const stored of ["adopt_no_visible_change", "adopt"]) {
    d.prepare(`DELETE FROM verse_merge_conflicts`).run();
    d.prepare(`DELETE FROM system_alerts`).run();
    upsertConflict(d, {
      book: "MIC", resource: "ust", chapter: 5, verse: 11,
      action: stored, reason: "both_changed_no_visible", overwrittenVersion: 3, now: 50,
    });
    // Tonight: the conflicted no-op, exactly as bookReimport's guard hands it over.
    upsertConflict(d, {
      book: "MIC", resource: "ust", chapter: 5, verse: 11,
      action: "adopt_conflict", reason: "both_changed", overwrittenVersion: null, now: 100,
    });
    const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='MIC' AND chapter=5 AND verse=11`).get();
    assert(row.action === "adopt_conflict", `${stored} -> no-op adopt_conflict: row is promoted (admin still sees it)`);
    assert(row.overwritten_version === null,
      `${stored} -> no-op adopt_conflict: the old pointer is NOT inherited (got ${row.overwritten_version})`);
    const make = (sql, args = []) => ({
      bind: (...next) => make(sql, next),
      all: async () => ({ results: d.prepare(sql).all(...args) }),
      run: async () => ({ meta: { changes: Number(d.prepare(sql).run(...args).changes) } }),
    });
    await raiseVerseMergeConflictAlert({ DB: { prepare: (sql) => make(sql) } }, "MIC", "ust", { observedAt: 100 });
    const alerts = d.prepare(`SELECT username FROM system_alerts WHERE source='verse_merge_conflict:MIC:ust'`).all();
    assert(alerts.some((a) => a.username === "deferredreward"), `${stored}: the admin banner still lists the row`);
    assert(!alerts.some((a) => a.username === "bethoakes"),
      `${stored}: no editor-scoped alert claims an overwrite that did not happen`);
  }

  // Unchanged: a stored, still-UNRESOLVED real adopt_conflict keeps its
  // recovery pointer when tonight's no-op re-detects it.
  d.prepare(`DELETE FROM verse_merge_conflicts`).run();
  upsertConflict(d, {
    book: "MIC", resource: "ust", chapter: 5, verse: 11,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 3, now: 50,
  });
  upsertConflict(d, {
    book: "MIC", resource: "ust", chapter: 5, verse: 11,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: null, now: 100,
  });
  const kept = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='MIC' AND chapter=5 AND verse=11`).get();
  assert(kept.overwritten_version === 3, "a real prior adopt_conflict keeps the pointer its human still needs");
}

// Issue #1006: the lock flag reaches BOTH stored messages through the real
// raise path (admin banner + the translator's own keep_no_base alert).
console.log("\n[locked book: keep_no_base alerts make no export claim (issue #1006)]");
for (const bookLocked of [true, false]) {
  const d = verseDb();
  d.exec(`ALTER TABLE system_alerts ADD COLUMN kind TEXT NOT NULL DEFAULT 'review';
    ALTER TABLE system_alerts ADD COLUMN condition_key TEXT;
    ALTER TABLE system_alerts ADD COLUMN resolved_at INTEGER;
    ALTER TABLE system_alerts ADD COLUMN condition_observed_at INTEGER;
    CREATE TABLE users (id INTEGER PRIMARY KEY, dcs_username TEXT);
    CREATE TABLE edit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, row_key TEXT, book TEXT,
      user_id INTEGER, new_version INTEGER);`);
  d.prepare(`INSERT INTO users (id, dcs_username) VALUES (7, 'bethoakes')`).run();
  d.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, new_version) VALUES ('verse', 'ZEC/1/6/UST', 'ZEC', 7, 2)`,
  ).run();
  const make = (sql, args = []) => ({
    bind: (...next) => make(sql, next),
    all: async () => ({ results: d.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(d.prepare(sql).run(...args).changes) } }),
  });
  await raiseVerseMergeConflictAlert({ DB: { prepare: (sql) => make(sql) } }, "ZEC", "ust", {
    noBaseCount: 1,
    noBaseRefs: ["1:6"],
    noBaseEditorRefs: [{ chapter: 1, verse: 6, version: 2 }],
    bookLocked,
    observedAt: 100,
  });
  const msg = (u) =>
    d.prepare(`SELECT message FROM system_alerts WHERE username=? AND source='verse_merge_conflict:ZEC:ust'`).get(u)
      ?.message ?? "";
  const label = bookLocked ? "locked" : "unlocked";
  for (const [who, m] of [["admin", msg("deferredreward")], ["editor", msg("bethoakes")]]) {
    assert(alertMessageCarriesNoBaseWarning(m), `${label} ${who}: alert raised with the no-base warning`);
    assert(/tonight's export/i.test(m) === !bookLocked,
      `${label} ${who}: the "tonight's export" warning appears only for an unlocked book`);
    assert(/this book is locked/i.test(m) === bookLocked, `${label} ${who}: the lock is named only when locked`);
  }
}

// Issue #1006 review (A2): the lock state is part of the alert condition. A
// dismissed locked-book alert (nothing to act on) must not keep the unlocked
// "tonight's export will overwrite" warning hidden after the book is unlocked.
// Unlocked condition keys stay byte-identical to the pre-#1006 keys, so this
// deploy does not resurrect alerts people already dismissed.
console.log("\n[locked -> dismissed -> unlocked: the overwrite warning comes back (issue #1006 review)]");
{
  const d = verseDb();
  d.exec(`ALTER TABLE system_alerts ADD COLUMN kind TEXT NOT NULL DEFAULT 'review';
    ALTER TABLE system_alerts ADD COLUMN condition_key TEXT;
    ALTER TABLE system_alerts ADD COLUMN resolved_at INTEGER;
    ALTER TABLE system_alerts ADD COLUMN condition_observed_at INTEGER;
    CREATE UNIQUE INDEX system_alerts_one_standing_review_test
      ON system_alerts(username, source)
      WHERE kind='review' AND condition_key IS NOT NULL AND dismissed_at IS NULL AND resolved_at IS NULL;
    CREATE TABLE users (id INTEGER PRIMARY KEY, dcs_username TEXT);
    CREATE TABLE edit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, row_key TEXT, book TEXT,
      user_id INTEGER, new_version INTEGER);`);
  d.prepare(`INSERT INTO users (id, dcs_username) VALUES (7, 'bethoakes')`).run();
  d.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, new_version) VALUES ('verse', 'ZEC/1/6/UST', 'ZEC', 7, 2)`,
  ).run();
  const make = (sql, args = []) => ({
    bind: (...next) => make(sql, next),
    all: async () => ({ results: d.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(d.prepare(sql).run(...args).changes) } }),
  });
  const raise = (bookLocked, observedAt) =>
    raiseVerseMergeConflictAlert({ DB: { prepare: (sql) => make(sql) } }, "ZEC", "ust", {
      noBaseCount: 1,
      noBaseRefs: ["1:6"],
      noBaseEditorRefs: [{ chapter: 1, verse: 6, version: 2 }],
      bookLocked,
      observedAt,
    });
  const live = (u) =>
    d.prepare(
      `SELECT message, condition_key FROM system_alerts
        WHERE username=? AND source='verse_merge_conflict:ZEC:ust' AND dismissed_at IS NULL AND resolved_at IS NULL`,
    ).all(u);

  await raise(true, 100);
  d.prepare(`UPDATE system_alerts SET dismissed_at = 150 WHERE source='verse_merge_conflict:ZEC:ust'`).run();
  await raise(true, 200);
  for (const u of ["deferredreward", "bethoakes"]) {
    assert(live(u).length === 0, `${u}: a dismissed locked alert stays dismissed while the book stays locked`);
  }

  await raise(false, 300);
  const expectedKeys = {
    deferredreward: reviewConditionKey(
      "verse_merge_conflict",
      { book: "ZEC", resource: "ust" },
      { rows: [], noBase: [{ chapter: 1, verse: 6, version: 2 }], noBaseCount: 1, recordingFailed: false },
    ),
    bethoakes: verseMergeEditorConditionKey("ZEC", "ust", "bethoakes", ["1:6"]),
  };
  for (const u of ["deferredreward", "bethoakes"]) {
    const rows = live(u);
    assert(rows.length === 1, `${u}: after the unlock, a fresh undismissed alert is raised`);
    assert(/tonight's export/i.test(rows[0]?.message ?? ""), `${u}: …carrying the unlocked overwrite warning`);
    assert(rows[0]?.condition_key === expectedKeys[u], `${u}: the unlocked condition key is unchanged from before #1006`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Issue #996: the editor's "Door43's sync overwrote your edits" alert carries
// each ref's first-flagged date, so an alert re-raised because its ref list
// only SHRANK (some rows resolved, nothing new tonight) reads as old, and a
// genuinely new overwrite sharing the alert with old ones is dated tonight
// instead of hiding under the oldest date.
// ─────────────────────────────────────────────────────────────────────────
console.log("\n[editor overwrite alert: first-flagged dates per ref (issue #996)]");
{
  const AUG19 = Date.UTC(2026, 7, 19, 5, 30) / 1000;
  const OCT05 = Date.UTC(2026, 9, 5, 5, 30) / 1000;
  const users = (refs) => new Map(refs.map((r) => [editLogKey("EZK", "ust", r), "bcameron93"]));

  // Every ref from the same day: one date, after the list (the shrink case).
  const sameDay = [
    { chapter: 4, verse: 17, overwrittenVersion: 6, detectedAt: AUG19 },
    { chapter: 4, verse: 18, overwrittenVersion: 3, detectedAt: AUG19 + 40 },
  ];
  const one = groupOverwrittenVersesByEditor("EZK", "ust", sameDay, users(sameDay)).get("bcameron93").message;
  assert(
    one.includes("with Door43's version: 4:17@v6, 4:18@v3 (first flagged 2026-08-19)."),
    `same-day refs share one first-flagged date (got: ${one})`,
  );

  // Old and new refs in one alert: each group carries its own date, oldest
  // first, so tonight's overwrite is not dated by the August rows.
  const mixed = [
    { chapter: 3, verse: 2, overwrittenVersion: 9, detectedAt: OCT05 },
    { chapter: 4, verse: 17, overwrittenVersion: 6, detectedAt: AUG19 },
  ];
  const two = groupOverwrittenVersesByEditor("EZK", "ust", mixed, users(mixed)).get("bcameron93");
  assert(
    two.message.includes(
      "with Door43's version: 4:17@v6 (first flagged 2026-08-19); 3:2@v9 (first flagged 2026-10-05).",
    ),
    `old and new refs are dated separately, oldest first (got: ${two.message})`,
  );
  assert(two.refs.join(",") === "3:2@v9,4:17@v6", "the refs that feed the condition key keep their order and shape");

  // No detectedAt (a caller without dates): the message is exactly the old one.
  const undated = [{ chapter: 5, verse: 1, overwrittenVersion: 2 }];
  const plain = groupOverwrittenVersesByEditor("EZK", "ust", undated, users(undated)).get("bcameron93").message;
  assert(
    plain.startsWith("Door43's sync overwrote your edit in EZK UST at 1 verse(s) with Door43's version: 5:1@v2. "),
    `no detectedAt -> no invented date (got: ${plain})`,
  );
}

// The same, end to end on a database built from the real migrations: the real
// writers (recordVerseMergeConflicts, confirmAdoptedConflicts) and the real
// alert path (raiseVerseMergeConflictAlert).
{
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const migrationSql = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"));
  const JUN10 = Date.UTC(2026, 5, 10, 5, 30) / 1000;
  const AUG19 = Date.UTC(2026, 7, 19, 5, 30) / 1000;
  const OCT05 = Date.UTC(2026, 9, 5, 5, 30) / 1000;
  const SOURCE = "verse_merge_conflict:EZK:ust";

  function migratedEnv() {
    const sqlite = new DatabaseSync(":memory:");
    for (const sql of migrationSql) sqlite.exec(sql);
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'bcameron93')`).run();
    const stmt = (sql, args = []) => ({
      _sql: sql,
      _args: args,
      bind: (...next) => stmt(sql, next),
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
    });
    const env = {
      DB: {
        prepare: (sql) => stmt(sql),
        batch: async (stmts) => {
          sqlite.exec("BEGIN");
          try {
            // Like D1, a SELECT inside a batch returns its rows (issue #1132's
            // prior-row capture rides in the upsert's own batch).
            const out = stmts.map((s) =>
              /^\s*SELECT/i.test(s._sql)
                ? { results: sqlite.prepare(s._sql).all(...s._args), meta: { changes: 0 } }
                : { meta: { changes: Number(sqlite.prepare(s._sql).run(...s._args).changes) } });
            sqlite.exec("COMMIT");
            return out;
          } catch (e) {
            sqlite.exec("ROLLBACK");
            throw e;
          }
        },
      },
    };
    return { sqlite, env };
  }
  // bcameron93 wrote `version` of the verse, so an overwrite pointing at it is theirs.
  const authored = (sqlite, chapter, verse, version) =>
    sqlite.prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES ('verse', ?, 'EZK', 7, ?, 'update')`,
    ).run(`EZK/${chapter}/${verse}/UST`, version);
  const overwrite = (chapter, verse, overwrittenVersion) => ({
    chapter, verse, action: "adopt_conflict", reason: "both_changed_wording",
    overwrittenVersion, alignment: null, observedVersion: null,
  });
  const humanResolve = (sqlite, chapter, verse, at) =>
    sqlite.prepare(
      `UPDATE verse_merge_conflicts SET resolved_at = ?, resolved_by = 7
        WHERE book = 'EZK' AND resource = 'ust' AND chapter = ? AND verse = ?`,
    ).run(at, chapter, verse);
  const row = (sqlite, chapter, verse) =>
    sqlite.prepare(`SELECT * FROM verse_merge_conflicts WHERE book = 'EZK' AND resource = 'ust' AND chapter = ? AND verse = ?`)
      .get(chapter, verse);
  const editorAlerts = (sqlite) =>
    sqlite.prepare(`SELECT * FROM system_alerts WHERE username = 'bcameron93' AND source = ? ORDER BY id`).all(SOURCE);

  // (a) The issue's own case: the standing list only shrinks. Two refs first
  // flagged 2026-08-19; one is resolved; tonight's re-raise names the other
  // with its August date.
  {
    const { sqlite, env } = migratedEnv();
    authored(sqlite, 4, 17, 6);
    authored(sqlite, 4, 18, 3);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 17, 6), overwrite(4, 18, 3)], AUG19);
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: AUG19 * 1000 });
    humanResolve(sqlite, 4, 18, AUG19 + 86400);
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: OCT05 * 1000 });
    const live = editorAlerts(sqlite).filter((a) => a.resolved_at == null);
    assert(live.length === 1, "shrink: one standing editor alert");
    assert(
      live[0]?.message.includes("at 1 verse(s) with Door43's version: 4:17@v6 (first flagged 2026-08-19)."),
      `shrink: the re-raised alert carries the remaining ref's August date (got: ${live[0]?.message})`,
    );
    assert(
      live[0]?.condition_key === verseMergeEditorConditionKey("EZK", "ust", "bcameron93", ["4:17@v6"]),
      "shrink: the condition key keeps its pre-#996 shape (dates are message-only)",
    );

    // Stickiness: dismiss it; the next run with the same rows leaves it down,
    // even though the message wording changed with this fix.
    sqlite.prepare(`UPDATE system_alerts SET dismissed_at = ? WHERE id = ?`).run(OCT05 + 60, live[0].id);
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: (OCT05 + 120) * 1000 });
    const shown = editorAlerts(sqlite).filter((a) => a.resolved_at == null && a.dismissed_at == null);
    assert(shown.length === 0, "shrink: a dismissed alert stays dismissed on the next run");
  }

  // (b) The PR #1001 review case: a verse overwritten in June, resolved by a
  // person, then overwritten again tonight. The reactivated row is dated
  // tonight, not June, so the editor is not told this is an old, known loss.
  {
    const { sqlite, env } = migratedEnv();
    authored(sqlite, 4, 20, 4);
    // bcameron93 also wrote v11, tonight's overwritten version, so the alert is
    // theirs (since #1112 the reactivated row points at v11, not June's v4).
    authored(sqlite, 4, 20, 11);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 20, 4)], JUN10);
    humanResolve(sqlite, 4, 20, JUN10 + 86400);
    // Tonight: the speculative upsert, the CAS lands, the confirm reactivates.
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 20, 11)], OCT05);
    assert(row(sqlite, 4, 20).detected_at === JUN10, "reactivation: the speculative upsert alone leaves detected_at alone");
    await confirmAdoptedConflicts(env, "EZK", "ust", [overwrite(4, 20, 11)], OCT05);
    const r = row(sqlite, 4, 20);
    assert(r.resolved_at === null && r.resolved_by === null, "reactivation: the row is active again");
    assert(r.detected_at === OCT05, `reactivation: detected_at is tonight, not June (got ${r.detected_at})`);
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: OCT05 * 1000 });
    const msg = editorAlerts(sqlite).find((a) => a.resolved_at == null)?.message ?? "";
    assert(msg.includes("(first flagged 2026-10-05)"), `reactivation: the editor alert is dated tonight (got: ${msg})`);
    assert(!msg.includes("2026-06-10"), "reactivation: the June date does not appear");
  }

  // (c) A still-UNRESOLVED row whose overwrite is confirmed again keeps its
  // original detected_at: the reset is only for a row coming back from resolved.
  {
    const { sqlite, env } = migratedEnv();
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 21, 5)], AUG19);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 21, 8)], OCT05);
    await confirmAdoptedConflicts(env, "EZK", "ust", [overwrite(4, 21, 8)], OCT05);
    const r = row(sqlite, 4, 21);
    assert(r.detected_at === AUG19, `unresolved re-confirm: detected_at keeps its first date (got ${r.detected_at})`);
    assert(r.last_recorded_at === OCT05, "unresolved re-confirm: last_recorded_at still records tonight");
    // Issue #1112's other half: a row still waiting for a human keeps its FIRST
    // recovery pointer. Its v5 text is what that human has not yet looked at.
    assert(r.overwritten_version === 5, `unresolved re-confirm: the first pointer (v5) is kept (got v${r.overwritten_version})`);
  }

  // (e) Issue #1112: a verse overwritten in June (v4, bcameron93's text),
  // resolved by a person, then overwritten again tonight (v11, jdoe's text).
  // The reactivated row, and the editor alert raised from it, point at v11 and
  // go to jdoe. June's pointer and June's lost-word snapshot describe a loss
  // someone already dealt with.
  {
    const { sqlite, env } = migratedEnv();
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (8, 8008, 'jdoe')`).run();
    authored(sqlite, 4, 20, 4);
    sqlite.prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES ('verse', 'EZK/4/20/UST', 'EZK', 8, 11, 'update')`,
    ).run();
    const june = { ...overwrite(4, 20, 4), alignment: { beforeAligned: 6, afterAligned: 4, lostWords: ["june"] } };
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [june], JUN10);
    humanResolve(sqlite, 4, 20, JUN10 + 86400);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 20, 11)], OCT05);
    await confirmAdoptedConflicts(env, "EZK", "ust", [overwrite(4, 20, 11)], OCT05);
    const r = row(sqlite, 4, 20);
    assert(r.resolved_at === null, "re-overwrite: the row is active again");
    assert(r.overwritten_version === 11, `re-overwrite: the pointer is tonight's v11, not June's v4 (got v${r.overwritten_version})`);
    assert(r.alignment === null, `re-overwrite: June's lost-word snapshot is not carried over (got ${r.alignment})`);
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: OCT05 * 1000 });
    const live = (user) =>
      sqlite.prepare(`SELECT * FROM system_alerts WHERE username = ? AND source = ? AND resolved_at IS NULL ORDER BY id`)
        .all(user, SOURCE);
    const jdoe = live("jdoe");
    assert(
      jdoe.length === 1 && jdoe[0].message.includes("4:20@v11 (first flagged 2026-10-05)"),
      `re-overwrite: v11's author is alerted at v11 (got: ${jdoe.map((a) => a.message).join(" | ") || "no alert"})`,
    );
    assert(live("bcameron93").length === 0, "re-overwrite: v4's author is not told Door43 overwrote them tonight");
  }

  // (d) A resolved row whose adoption LOSES its CAS race (no confirm) keeps
  // its resolution and its date: nothing was overwritten tonight.
  {
    const { sqlite, env } = migratedEnv();
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 22, 5)], JUN10);
    humanResolve(sqlite, 4, 22, JUN10 + 86400);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 22, 9)], OCT05, "run-tonight");
    await deleteLostAdoptionConflicts(env, "EZK", "ust", [{ chapter: 4, verse: 22 }], "run-tonight");
    const r = row(sqlite, 4, 22);
    assert(r.resolved_at === JUN10 + 86400, "lost CAS: the resolution stands");
    assert(r.detected_at === JUN10, "lost CAS: detected_at is untouched");
  }

  // Issue #1124: one rule for which overwrite an unresolved row describes,
  // applied to the pointer and the lost-word snapshot together.
  const snap = (word) => ({ beforeAligned: 6, afterAligned: 4, lostWords: [word] });
  const lostWords = (r) => (r.alignment == null ? null : JSON.parse(r.alignment).lostWords.join(","));
  const jdoe = (sqlite) => sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (8, 8008, 'jdoe')`).run();
  const authoredBy = (sqlite, userId, chapter, verse, version) =>
    sqlite.prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES ('verse', ?, 'EZK', ?, ?, 'update')`,
    ).run(`EZK/${chapter}/${verse}/UST`, userId, version);
  const liveFor = (sqlite, user) =>
    sqlite.prepare(`SELECT * FROM system_alerts WHERE username = ? AND source = ? AND resolved_at IS NULL ORDER BY id`)
      .all(user, SOURCE);

  // (f) An unresolved adopt_conflict (v5, August's lost words) overwritten
  // again tonight (v8, other lost words). The row keeps BOTH from August: the
  // pointer and the snapshot describe the same overwrite, the first one the
  // editor has not looked at yet.
  {
    const { sqlite, env } = migratedEnv();
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [{ ...overwrite(4, 23, 5), alignment: snap("august") }], AUG19);
    const tonight = { ...overwrite(4, 23, 8), alignment: snap("october") };
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [tonight], OCT05);
    await confirmAdoptedConflicts(env, "EZK", "ust", [tonight], OCT05);
    const r = row(sqlite, 4, 23);
    assert(r.overwritten_version === 5, `unresolved re-overwrite: the first pointer (v5) is kept (got v${r.overwritten_version})`);
    assert(lostWords(r) === "august", `unresolved re-overwrite: the snapshot is v5's, matching the pointer (got ${lostWords(r)})`);

    // A clean adopt re-detected on the same unresolved row does not swap the
    // snapshot under the kept adopt_conflict pointer either.
    const clean = { ...overwrite(4, 23, 9), action: "adopt", reason: "master_only", alignment: snap("clean") };
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [clean], OCT05 + 86400);
    const r2 = row(sqlite, 4, 23);
    assert(r2.action === "adopt_conflict" && r2.overwritten_version === 5, "unresolved + clean adopt: still the v5 adopt_conflict");
    assert(lostWords(r2) === "august", `unresolved + clean adopt: the snapshot stays v5's (got ${lostWords(r2)})`);
  }

  // (g) An unresolved audit-only row (adopt_no_visible_change at v3,
  // bcameron93's text: nobody was ever alerted) promoted tonight by a LANDED
  // adopt_conflict that overwrote v7 (jdoe's text). The row describes
  // tonight's overwrite: pointer v7, tonight's snapshot, tonight's date, and
  // the editor alert goes to jdoe.
  {
    const { sqlite, env } = migratedEnv();
    jdoe(sqlite);
    authored(sqlite, 4, 24, 3);
    authoredBy(sqlite, 8, 4, 24, 7);
    const audit = { ...overwrite(4, 24, 3), action: "adopt_no_visible_change", reason: "both_changed_markers_only", alignment: snap("audit") };
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [audit], AUG19);
    const tonight = { ...overwrite(4, 24, 7), alignment: snap("october") };
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [tonight], OCT05);
    await confirmAdoptedConflicts(env, "EZK", "ust", [tonight], OCT05);
    const r = row(sqlite, 4, 24);
    assert(r.action === "adopt_conflict" && r.resolved_at === null, "promotion: the row is an active adopt_conflict");
    assert(r.overwritten_version === 7, `promotion: the pointer is tonight's v7, not the audit row's v3 (got v${r.overwritten_version})`);
    assert(lostWords(r) === "october", `promotion: the snapshot is tonight's (got ${lostWords(r)})`);
    assert(r.detected_at === OCT05, `promotion: first flagged tonight, not on the audit row's date (got ${r.detected_at})`);
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: OCT05 * 1000 });
    const toJdoe = liveFor(sqlite, "jdoe");
    assert(
      toJdoe.length === 1 && toJdoe[0].message.includes("4:24@v7 (first flagged 2026-10-05)"),
      `promotion: v7's author is alerted at v7 (got: ${toJdoe.map((a) => a.message).join(" | ") || "no alert"})`,
    );
    assert(liveFor(sqlite, "bcameron93").length === 0, "promotion: v3's author is not told Door43 overwrote them");
  }

  // (h) The same promotion, but tonight's CAS LOSES (a human saved first):
  // nothing was overwritten, so nothing may point at v7 or alert anyone. The
  // lost-CAS cleanup puts the audit row back as it was (issue #1132; case (m)
  // checks every column).
  {
    const { sqlite, env } = migratedEnv();
    jdoe(sqlite);
    authored(sqlite, 4, 25, 3);
    authoredBy(sqlite, 8, 4, 25, 7);
    const audit = { ...overwrite(4, 25, 3), action: "adopt_no_visible_change", reason: "both_changed_markers_only" };
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [audit], AUG19);
    const prior = "run-tonight";
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [{ ...overwrite(4, 25, 7), alignment: snap("october") }], OCT05, prior);
    await deleteLostAdoptionConflicts(env, "EZK", "ust", [{ chapter: 4, verse: 25 }], prior);
    const claims = sqlite.prepare(
      `SELECT COUNT(*) c FROM verse_merge_conflicts WHERE book = 'EZK' AND chapter = 4 AND verse = 25 AND overwritten_version = 7`,
    ).get().c;
    assert(claims === 0, "lost promotion: no row claims tonight's v7 was overwritten");
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: OCT05 * 1000 });
    assert(liveFor(sqlite, "jdoe").length === 0 && liveFor(sqlite, "bcameron93").length === 0, "lost promotion: no editor is alerted");
  }

  // (i) A RESOLVED row WITH a stored pointer whose re-overwrite loses its CAS
  // keeps its June pointer AND its June snapshot: the speculative upsert does
  // not swap either, so a lost race leaves the row exactly as the person who
  // resolved it saw it. (A resolved row whose stored pointer is NULL does take
  // tonight's pointer and snapshot speculatively; the lost-race cleanup puts
  // them back, case (l).)
  {
    const { sqlite, env } = migratedEnv();
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [{ ...overwrite(4, 26, 4), alignment: snap("june") }], JUN10);
    humanResolve(sqlite, 4, 26, JUN10 + 86400);
    const before = row(sqlite, 4, 26);
    const prior = "run-tonight";
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [{ ...overwrite(4, 26, 11), alignment: snap("october") }], OCT05, prior);
    await deleteLostAdoptionConflicts(env, "EZK", "ust", [{ chapter: 4, verse: 26 }], prior);
    const r = row(sqlite, 4, 26);
    assert(r.resolved_at === before.resolved_at && r.detected_at === before.detected_at, "resolved lost CAS: resolution and date stand");
    assert(r.overwritten_version === 4, `resolved lost CAS: the pointer stays v4 (got v${r.overwritten_version})`);
    assert(lostWords(r) === "june", `resolved lost CAS: the snapshot stays June's, matching the pointer (got ${lostWords(r)})`);
  }

  // Issue #1132: a lost race puts back the row tonight's speculative upsert
  // changed, instead of deleting it. Since issue #1137 the upsert stores each
  // touched row's prior state on the row itself, under tonight's run id; the
  // lost-race cleanup restores a row that existed and deletes only a row this
  // run created.
  const lostRace = (env, chapter, verse, _now, runId) =>
    deleteLostAdoptionConflicts(env, "EZK", "ust", [{ chapter, verse }], runId);
  const speculative = (r) => ({
    action: r.action, reason: r.reason, overwritten_version: r.overwritten_version, alignment: r.alignment,
    detected_at: r.detected_at, last_recorded_at: r.last_recorded_at, resolved_at: r.resolved_at, resolved_by: r.resolved_by,
  });

  // (j) The issue's own case: Monday's unresolved adopt_conflict at v5, which
  // its editor has not reviewed yet. Tuesday's overwrite of the same verse
  // loses its race (a person saved first). Monday's row, its v5 pointer, its
  // snapshot and its dates survive, and its editor alert still raises.
  {
    const { sqlite, env } = migratedEnv();
    authored(sqlite, 4, 27, 5);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [{ ...overwrite(4, 27, 5), alignment: snap("monday") }], AUG19);
    const monday = speculative(row(sqlite, 4, 27));
    const prior = "run-tonight";
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [{ ...overwrite(4, 27, 8), alignment: snap("tuesday") }], OCT05, prior);
    await lostRace(env, 4, 27, OCT05, prior);
    const r = row(sqlite, 4, 27);
    assert(!!r, "lost race on a pending alert row: Monday's row is not deleted");
    assert(
      r != null && JSON.stringify(speculative(r)) === JSON.stringify(monday),
      `lost race on a pending alert row: the row is exactly Monday's (got ${JSON.stringify(r && speculative(r))})`,
    );
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: OCT05 * 1000 });
    const live = liveFor(sqlite, "bcameron93");
    assert(
      live.length === 1 && live[0].message.includes("4:27@v5 (first flagged 2026-08-19)"),
      `lost race on a pending alert row: Monday's editor alert still raises (got: ${live.map((a) => a.message).join(" | ") || "no alert"})`,
    );
  }

  // (k) A row this run CREATED speculatively is still deleted on a lost race:
  // nothing existed before it.
  {
    const { sqlite, env } = migratedEnv();
    const prior = "run-tonight";
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 28, 6)], OCT05, prior);
    await lostRace(env, 4, 28, OCT05, prior);
    assert(!row(sqlite, 4, 28), "lost race on a brand-new row: the row is deleted");
  }

  // (l) A RESOLVED row with a NULL stored pointer (a kept-D1 flag someone
  // resolved, or a resolved #978 no-op adopt_conflict) takes tonight's pointer
  // and snapshot through the upsert's COALESCE. After a lost race it is back
  // exactly as it was: it does not claim an overwrite that never landed.
  {
    const { sqlite, env } = migratedEnv();
    const kept = { ...overwrite(4, 29, null), action: "keep_alignment_refused", reason: "alignment_shrink" };
    const noop = { ...overwrite(4, 30, null), reason: "no_op_conflicted" };
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [kept, noop], AUG19);
    humanResolve(sqlite, 4, 29, AUG19 + 86400);
    humanResolve(sqlite, 4, 30, AUG19 + 86400);
    const before29 = speculative(row(sqlite, 4, 29));
    const before30 = speculative(row(sqlite, 4, 30));
    const prior = "run-tonight";
    await recordVerseMergeConflicts(
      env, "EZK", "ust", "UST",
      [{ ...overwrite(4, 29, 9), alignment: snap("october") }, { ...overwrite(4, 30, 9), alignment: snap("october") }],
      OCT05, prior,
    );
    await deleteLostAdoptionConflicts(env, "EZK", "ust", [{ chapter: 4, verse: 29 }, { chapter: 4, verse: 30 }], prior);
    const after29 = speculative(row(sqlite, 4, 29));
    const after30 = speculative(row(sqlite, 4, 30));
    assert(JSON.stringify(after29) === JSON.stringify(before29), `resolved NULL-pointer kept row: unchanged by a lost race (got ${JSON.stringify(after29)})`);
    assert(JSON.stringify(after30) === JSON.stringify(before30), `resolved NULL-pointer no-op row: unchanged by a lost race (got ${JSON.stringify(after30)})`);
  }

  // (m) An unresolved audit-only row promoted tonight (#1124) whose CAS loses
  // goes back to being the audit row it was: v3, its own date, no alert.
  {
    const { sqlite, env } = migratedEnv();
    jdoe(sqlite);
    authored(sqlite, 4, 31, 3);
    authoredBy(sqlite, 8, 4, 31, 7);
    const audit = { ...overwrite(4, 31, 3), action: "adopt_no_visible_change", reason: "both_changed_markers_only" };
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [audit], AUG19);
    const before = speculative(row(sqlite, 4, 31));
    const prior = "run-tonight";
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [{ ...overwrite(4, 31, 7), alignment: snap("october") }], OCT05, prior);
    await lostRace(env, 4, 31, OCT05, prior);
    const after = row(sqlite, 4, 31);
    assert(
      after != null && JSON.stringify(speculative(after)) === JSON.stringify(before),
      `lost promotion: the audit row is restored (got ${JSON.stringify(after && speculative(after))})`,
    );
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: OCT05 * 1000 });
    assert(liveFor(sqlite, "jdoe").length === 0 && liveFor(sqlite, "bcameron93").length === 0, "lost promotion: no editor is alerted");
  }

  // (n) The person whose save beat the CAS also resolved Monday's row (their
  // save resolves it) between the upsert and the cleanup. Their resolution
  // stands; the rest of the row is Monday's.
  {
    const { sqlite, env } = migratedEnv();
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [{ ...overwrite(4, 32, 5), alignment: snap("monday") }], AUG19);
    const prior = "run-tonight";
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [{ ...overwrite(4, 32, 8), alignment: snap("tuesday") }], OCT05, prior);
    humanResolve(sqlite, 4, 32, OCT05 + 30);
    await lostRace(env, 4, 32, OCT05, prior);
    const r = row(sqlite, 4, 32);
    assert(r?.resolved_at === OCT05 + 30 && r?.resolved_by === 7, "resolved mid-race: the person's resolution stands");
    assert(
      r?.overwritten_version === 5 && lostWords(r) === "monday" && r?.last_recorded_at === AUG19,
      `resolved mid-race: Monday's pointer, snapshot and last_recorded_at are back (got v${r?.overwritten_version}, ${r && lostWords(r)}, ${r?.last_recorded_at})`,
    );
  }

  // (o) Another write touched the row after tonight's upsert (a later run
  // recorded it again): the cleanup leaves that newer state alone.
  {
    const { sqlite, env } = migratedEnv();
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [{ ...overwrite(4, 33, 5), alignment: snap("monday") }], AUG19);
    const prior = "run-tonight";
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 33, 8)], OCT05, prior);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 33, 9)], OCT05 + 60, "run-later");
    await lostRace(env, 4, 33, OCT05, prior);
    const r = row(sqlite, 4, 33);
    assert(r?.last_recorded_at === OCT05 + 60, "later write: the cleanup does not undo a write it did not make");
  }

  // (p) A Workflow retry: an earlier attempt of THIS run (it died before its
  // CAS) already touched the row. The retry keeps that attempt's capture of
  // the real prior state (issue #1137), so a lost race puts back the audit
  // row rather than the promotion that never landed.
  {
    const { sqlite, env } = migratedEnv();
    jdoe(sqlite);
    authoredBy(sqlite, 8, 4, 34, 7);
    const audit = { ...overwrite(4, 34, 3), action: "adopt_no_visible_change", reason: "both_changed_markers_only" };
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [audit], AUG19);
    const prior = "run-tonight";
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 34, 7)], OCT05, prior); // attempt 1 dies here
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 34, 7)], OCT05 + 60, prior); // the retry
    await lostRace(env, 4, 34, OCT05 + 60, prior);
    const claims = sqlite.prepare(
      `SELECT COUNT(*) c FROM verse_merge_conflicts WHERE book = 'EZK' AND chapter = 4 AND verse = 34 AND overwritten_version = 7`,
    ).get().c;
    assert(claims === 0, "retry after a dead attempt: no row claims the v7 overwrite that never landed");
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: OCT05 * 1000 });
    assert(liveFor(sqlite, "jdoe").length === 0, "retry after a dead attempt: v7's author is not alerted");
  }

  // (q) Two overlapping runs on one verse (the nightly Workflow takes no book
  // import lock). June's resolved adopt_conflict points at v4. Run A upserts;
  // run B upserts on top of A's unsettled speculation; A's CAS lands (its
  // reimport edit_log row and the settle commit with it) and its confirm
  // reactivates the row at v11; B's CAS loses. B's cleanup must not rewind
  // A's landed alert to June's v4.
  {
    const { sqlite, env } = migratedEnv();
    jdoe(sqlite);
    authored(sqlite, 4, 35, 4);
    authoredBy(sqlite, 8, 4, 35, 11);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [{ ...overwrite(4, 35, 4), alignment: snap("june") }], JUN10);
    humanResolve(sqlite, 4, 35, JUN10 + 86400);
    const tonightA = { ...overwrite(4, 35, 11), alignment: snap("october"), observedVersion: 11 };
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [tonightA], OCT05, "run-A"); // run A
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [tonightA], OCT05 + 20, "run-B"); // run B
    // A's CAS landed: its reimport edit_log row and the settle, in one batch.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
         VALUES ('verse', 'EZK/4/35/UST', 'EZK', NULL, 11, 12, 'update', 'dcs_reimport')`,
      ),
      settleLandedConflictStmt(env, "EZK", "ust", tonightA),
    ]);
    await confirmAdoptedConflicts(env, "EZK", "ust", [tonightA], OCT05);
    await lostRace(env, 4, 35, OCT05 + 20, "run-B"); // B's CAS lost
    const r = row(sqlite, 4, 35);
    assert(r?.resolved_at === null, "overlapping runs: A's landed overwrite stays active");
    assert(
      r?.overwritten_version === 11 && lostWords(r) === "october" && r?.detected_at === OCT05,
      `overlapping runs: the row keeps A's v11, its snapshot and date (got v${r?.overwritten_version}, ${r && lostWords(r)}, ${r?.detected_at})`,
    );
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: OCT05 * 1000 });
    const toJdoe = liveFor(sqlite, "jdoe");
    assert(
      toJdoe.length === 1 && toJdoe[0].message.includes("4:35@v11"),
      `overlapping runs: v11's author is alerted (got: ${toJdoe.map((a) => a.message).join(" | ") || "no alert"})`,
    );
    assert(liveFor(sqlite, "bcameron93").length === 0, "overlapping runs: v4's author is not told to recover June's loss");
  }

  // (r) A ref listed twice in one call keeps its first capture: the second
  // upsert sees this run's own unsettled speculation (issue #1137; case (y)
  // runs the lost race).
  {
    const { sqlite, env } = migratedEnv();
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 36, 4)], AUG19);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [overwrite(4, 36, 5), overwrite(4, 36, 6), overwrite(4, 37, 5)], OCT05, "run-tonight");
    const r36 = row(sqlite, 4, 36);
    const r37 = row(sqlite, 4, 37);
    assert(
      r36.prior_run === "run-tonight" && JSON.parse(r36.prior_json).last_recorded_at === AUG19,
      `repeated ref: the capture is the row from before tonight (got ${r36.prior_json})`,
    );
    assert(r37.prior_run === "run-tonight" && r37.prior_json === null, "a ref tonight created: owned by tonight's run, nothing to put back");
  }

  // Issue #1137: the crash/retry and overlapping-run cases. A "run" is one
  // logical reimport (a nightly Workflow run, retried attempt by attempt, or
  // one UI pull); an attempt is one execution of it. The adapter below is the
  // only part of this section that knows the writers' signatures:
  //   begin()     — an attempt starts (the nightly chunk step's entry)
  //   record(rs)  — the speculative upsert (step 6b)
  //   land(rs)    — the CAS lands: its reimport edit_log row, then the confirm
  //   lost(refs)  — the CAS lost: the lost-race cleanup (step 7b)
  const reimportLanded = (sqlite, r) =>
    sqlite.prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
       VALUES ('verse', ?, 'EZK', NULL, ?, ?, 'update', 'dcs_reimport')`,
    ).run(`EZK/${r.chapter}/${r.verse}/UST`, r.observedVersion, r.observedVersion + 1);
  // The settle that closes a CAS batch, for one ref, placed right after that
  // ref's write and edit_log row as bookReimport.ts places it.
  const settleOne = (env, r) => settleLandedConflictStmt(env, "EZK", "ust", r);
  // A dead run's capture older than this is rolled back by any later run.
  const STALE_SECONDS = 3600;
  let runSeq = 0;
  const run1137 = (sqlite, env, { startedAt, nightly }) => {
    // A nightly run's id is stable across its attempts; a UI pull is never
    // retried, and every one gets its own (bookReimport.ts's applyVerseRows).
    const runId = `${nightly ? "nightly" : "ui"}:${startedAt}:${++runSeq}`;
    return {
      attempt(now) {
        return {
          // A nightly chunk step's entry (reimportStagedChunk) or a UI pull's
          // (runReimport): roll back this run's own dead attempts, and any
          // run's capture older than STALE_SECONDS.
          begin: () => rollBackDeadAttemptConflicts(env, "EZK", ["ust"], 4, 4, runId, now - STALE_SECONDS),
          record: (rows) => recordVerseMergeConflicts(env, "EZK", "ust", "UST", rows, now, runId),
          // The CAS batch, landing: each write's reimport edit_log row, then its settle.
          cas: (rows) =>
            env.DB.batch(rows.flatMap((r) => [
              env.DB.prepare(
                `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
                 VALUES ('verse', ?, 'EZK', NULL, ?, ?, 'update', 'dcs_reimport')`,
              ).bind(`EZK/${r.chapter}/${r.verse}/UST`, r.observedVersion, r.observedVersion + 1),
              settleOne(env, r),
            ])),
          land: async function (rows) {
            await this.cas(rows);
            await confirmAdoptedConflicts(env, "EZK", "ust", rows.filter((r) => r.action === "adopt_conflict"), now);
          },
          // The CAS batch, losing (the version moved): the write and its gated
          // edit_log row change nothing, then the settle; then step 7b.
          casLost: async (rows) => {
            await env.DB.batch(rows.flatMap((r) => [
              env.DB.prepare(`UPDATE verses SET version = version WHERE 0`),
              settleOne(env, r),
            ]));
            await deleteLostAdoptionConflicts(env, "EZK", "ust", rows.map((r) => ({ chapter: r.chapter, verse: r.verse })), runId);
          },
          lost: (refs) => deleteLostAdoptionConflicts(env, "EZK", "ust", refs, runId),
        };
      },
    };
  };
  const ow = (chapter, verse, version, extra = {}) => ({ ...overwrite(chapter, verse, version), observedVersion: version, ...extra });
  const claimsOverwriteOf = (sqlite, chapter, verse, version) =>
    sqlite.prepare(
      `SELECT COUNT(*) c FROM verse_merge_conflicts WHERE book = 'EZK' AND chapter = ? AND verse = ? AND overwritten_version = ?`,
    ).get(chapter, verse, version).c;
  const auditRow = (chapter, verse) => ({ ...ow(chapter, verse, 3), action: "adopt_no_visible_change", reason: "both_changed_markers_only" });

  // (s) Item 2: Monday's unreviewed adopt_conflict (v5). Tonight's attempt 1
  // upserts and dies before its CAS; the retry upserts again and loses its
  // race. Monday's row comes back whole and its editor is still alerted.
  {
    const { sqlite, env } = migratedEnv();
    authored(sqlite, 4, 40, 5);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [ow(4, 40, 5, { alignment: snap("monday") })], AUG19);
    const monday = speculative(row(sqlite, 4, 40));
    const R = run1137(sqlite, env, { startedAt: OCT05, nightly: true });
    const tonight = ow(4, 40, 8, { alignment: snap("tuesday") });
    const a1 = R.attempt(OCT05);
    await a1.begin();
    await a1.record([tonight]); // dies here
    const a2 = R.attempt(OCT05 + 60);
    await a2.begin();
    await a2.record([tonight]);
    await a2.lost([{ chapter: 4, verse: 40 }]);
    const r = row(sqlite, 4, 40);
    assert(
      r != null && JSON.stringify(speculative(r)) === JSON.stringify(monday),
      `#1137 dead attempt + lost retry: Monday's row is back exactly (got ${JSON.stringify(r && speculative(r))})`,
    );
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: OCT05 * 1000 });
    const live = liveFor(sqlite, "bcameron93");
    assert(
      live.length === 1 && live[0].message.includes("4:40@v5"),
      `#1137 dead attempt + lost retry: Monday's alert still raises (got: ${live.map((a) => a.message).join(" | ") || "no alert"})`,
    );
  }

  // (t) Item 1: attempt 1 promotes an audit row to an adopt_conflict at v7 and
  // dies before its CAS; a person saves the verse; the retry measures
  // something that is not an adoption and writes no row for it. Nothing may
  // still claim the v7 overwrite.
  {
    const { sqlite, env } = migratedEnv();
    jdoe(sqlite);
    authoredBy(sqlite, 8, 4, 41, 7);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [auditRow(4, 41)], AUG19);
    const before = speculative(row(sqlite, 4, 41));
    const R = run1137(sqlite, env, { startedAt: OCT05, nightly: true });
    const a1 = R.attempt(OCT05);
    await a1.begin();
    await a1.record([ow(4, 41, 7)]); // dies here
    const a2 = R.attempt(OCT05 + 60);
    await a2.begin(); // and records nothing for 4:41
    assert(claimsOverwriteOf(sqlite, 4, 41, 7) === 0, "#1137 dead attempt + non-adopting retry: no row claims the unlanded v7 overwrite");
    const r = row(sqlite, 4, 41);
    assert(
      r != null && JSON.stringify(speculative(r)) === JSON.stringify(before),
      `#1137 dead attempt + non-adopting retry: the audit row is back (got ${JSON.stringify(r && speculative(r))})`,
    );
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: OCT05 * 1000 });
    assert(liveFor(sqlite, "jdoe").length === 0, "#1137 dead attempt + non-adopting retry: v7's author is not alerted");
  }

  // (t2) The guard on (t): attempt 1's CAS LANDED (its CAS batch committed)
  // and it died before anything after the CAS ran. The overwrite is real, so
  // the retry must keep the row's claim.
  {
    const { sqlite, env } = migratedEnv();
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [auditRow(4, 47)], AUG19);
    const R = run1137(sqlite, env, { startedAt: OCT05, nightly: true });
    const a1 = R.attempt(OCT05);
    await a1.begin();
    await a1.record([ow(4, 47, 7)]);
    await a1.cas([ow(4, 47, 7)]); // the CAS landed; the attempt died right after
    const a2 = R.attempt(OCT05 + 60);
    await a2.begin(); // D1 now equals master: the retry records nothing for 4:47
    assert(claimsOverwriteOf(sqlite, 4, 47, 7) === 1, "#1137 dead attempt whose CAS landed: the retry keeps the v7 claim");
  }

  // (u) Item 6: nightly run B starts; a UI pull A upserts a brand-new row,
  // then B upserts the same verse; A's CAS lands and confirms; B's loses. A's
  // landed alert survives B's cleanup.
  {
    const { sqlite, env } = migratedEnv();
    jdoe(sqlite);
    authoredBy(sqlite, 8, 4, 42, 11);
    const tonight = ow(4, 42, 11, { alignment: snap("october") });
    const B = run1137(sqlite, env, { startedAt: OCT05, nightly: true }).attempt(OCT05 + 40);
    const A = run1137(sqlite, env, { startedAt: OCT05 + 30, nightly: false }).attempt(OCT05 + 30);
    await B.begin();
    await A.begin();
    await A.record([tonight]);
    await B.record([tonight]);
    await A.land([tonight]);
    await B.lost([{ chapter: 4, verse: 42 }]);
    assert(claimsOverwriteOf(sqlite, 4, 42, 11) === 1, "#1137 overlap (UI lands, nightly loses): the landed v11 row survives");
    await raiseVerseMergeConflictAlert(env, "EZK", "ust", { observedAt: OCT05 * 1000 });
    const toJdoe = liveFor(sqlite, "jdoe");
    assert(
      toJdoe.length === 1 && toJdoe[0].message.includes("4:42@v11"),
      `#1137 overlap (UI lands, nightly loses): v11's author is alerted (got: ${toJdoe.map((a) => a.message).join(" | ") || "no alert"})`,
    );
  }

  // (v) Item 4, first half: a UI pull A upserts, lands and confirms a new row
  // AFTER nightly run B started; B then upserts the same verse and loses. A's
  // row is genuine, not a dead attempt of B's, and survives.
  {
    const { sqlite, env } = migratedEnv();
    jdoe(sqlite);
    authoredBy(sqlite, 8, 4, 45, 11);
    const tonight = ow(4, 45, 11);
    const B = run1137(sqlite, env, { startedAt: OCT05, nightly: true }).attempt(OCT05 + 20);
    const A = run1137(sqlite, env, { startedAt: OCT05 + 10, nightly: false }).attempt(OCT05 + 10);
    await B.begin();
    await A.begin();
    await A.record([tonight]);
    await A.land([tonight]);
    await B.record([tonight]);
    await B.lost([{ chapter: 4, verse: 45 }]);
    assert(claimsOverwriteOf(sqlite, 4, 45, 11) === 1, "#1137 overlap (genuine row from another run): A's landed v11 row survives B's lost race");
  }

  // (w) Item 4, second half: nightly X and UI pull Y both upsert a promotion
  // of the same audit row and both lose. Neither overwrite landed, so the row
  // ends as the audit row, whichever cleanup runs last.
  {
    for (const order of ["XY", "YX"]) {
      const { sqlite, env } = migratedEnv();
      jdoe(sqlite);
      authoredBy(sqlite, 8, 4, 43, 7);
      await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [auditRow(4, 43)], AUG19);
      const before = speculative(row(sqlite, 4, 43));
      const X = run1137(sqlite, env, { startedAt: OCT05, nightly: true }).attempt(OCT05);
      const Y = run1137(sqlite, env, { startedAt: OCT05 + 30, nightly: false }).attempt(OCT05 + 30);
      await X.begin();
      await X.record([ow(4, 43, 7)]);
      await Y.begin();
      await Y.record([ow(4, 43, 7)]);
      for (const who of order) await (who === "X" ? X : Y).lost([{ chapter: 4, verse: 43 }]);
      assert(claimsOverwriteOf(sqlite, 4, 43, 7) === 0, `#1137 overlap, both lose (${order}): no row claims the v7 overwrite`);
      const r = row(sqlite, 4, 43);
      assert(
        r != null && JSON.stringify(speculative(r)) === JSON.stringify(before),
        `#1137 overlap, both lose (${order}): the audit row is back (got ${JSON.stringify(r && speculative(r))})`,
      );
    }
  }

  // (x) Item 3: a UI pull D upserts a promotion and dies before its CAS; a
  // later UI pull P upserts the same verse and loses. P must not put back D's
  // unlanded speculative row as if it were the real prior state.
  {
    const { sqlite, env } = migratedEnv();
    jdoe(sqlite);
    authoredBy(sqlite, 8, 4, 44, 7);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [auditRow(4, 44)], AUG19);
    const D = run1137(sqlite, env, { startedAt: OCT05, nightly: false }).attempt(OCT05);
    await D.begin();
    await D.record([ow(4, 44, 7)]); // dies here
    const P = run1137(sqlite, env, { startedAt: OCT05 + 3600, nightly: false }).attempt(OCT05 + 3600);
    await P.begin();
    await P.record([ow(4, 44, 7)]);
    await P.lost([{ chapter: 4, verse: 44 }]);
    assert(claimsOverwriteOf(sqlite, 4, 44, 7) === 0, "#1137 dead UI pull + later lost pull: no row claims the unlanded v7 overwrite");
  }

  // (y) Items 5 and 7: a ref listed twice in one record call, then a lost
  // race. Monday's pending alert row survives instead of being deleted.
  {
    const { sqlite, env } = migratedEnv();
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [ow(4, 46, 5, { alignment: snap("monday") })], AUG19);
    const monday = speculative(row(sqlite, 4, 46));
    const a = run1137(sqlite, env, { startedAt: OCT05, nightly: true }).attempt(OCT05);
    await a.begin();
    await a.record([ow(4, 46, 8), ow(4, 46, 9)]);
    await a.lost([{ chapter: 4, verse: 46 }]);
    const r = row(sqlite, 4, 46);
    assert(
      r != null && JSON.stringify(speculative(r)) === JSON.stringify(monday),
      `#1137 repeated ref + lost race: Monday's row is back (got ${JSON.stringify(r && speculative(r))})`,
    );
  }

  // Review A1, first case: run A speculates an adoption on an audit row; an
  // overlapping run B records a final, non-adoption flag on the same verse
  // (keep_alignment_refused: D1 kept, nothing overwritten); A's CAS loses. B's
  // flag stands: A's restore must not rewind it to the audit row.
  const keptFlag = (chapter, verse, version) => ({
    ...ow(chapter, verse, null), action: "keep_alignment_refused", reason: "alignment_shrink", observedVersion: version,
  });
  {
    const { sqlite, env } = migratedEnv();
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [auditRow(4, 48)], AUG19);
    const A = run1137(sqlite, env, { startedAt: OCT05, nightly: true }).attempt(OCT05);
    const B = run1137(sqlite, env, { startedAt: OCT05 + 30, nightly: false }).attempt(OCT05 + 30);
    await A.begin();
    await A.record([ow(4, 48, 7)]);
    await B.begin();
    await B.record([keptFlag(4, 48, 7)]);
    await A.casLost([ow(4, 48, 7)]);
    const r = row(sqlite, 4, 48);
    assert(
      r?.action === "keep_alignment_refused" && r?.last_recorded_at === OCT05 + 30,
      `#1137 A1: another run's final keep flag survives a lost race's restore (got ${JSON.stringify(r && speculative(r))})`,
    );
  }

  // Review A1, second case: a UI pull D speculates an adoption and dies; a
  // later run B records a final keep flag on the verse; a later nightly run N
  // speculates an adoption and loses. N must put back B's flag, not the state
  // from before D's dead speculation.
  {
    const { sqlite, env } = migratedEnv();
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [auditRow(4, 49)], AUG19);
    const D = run1137(sqlite, env, { startedAt: OCT05, nightly: false }).attempt(OCT05);
    await D.begin();
    await D.record([ow(4, 49, 7)]); // dies here
    const B = run1137(sqlite, env, { startedAt: OCT05 + 60, nightly: false }).attempt(OCT05 + 60);
    await B.begin();
    await B.record([keptFlag(4, 49, 7)]);
    const N = run1137(sqlite, env, { startedAt: OCT05 + 120, nightly: true }).attempt(OCT05 + 120);
    await N.begin();
    await N.record([ow(4, 49, 7)]);
    await N.casLost([ow(4, 49, 7)]);
    const r = row(sqlite, 4, 49);
    assert(
      r?.action === "keep_alignment_refused" && r?.last_recorded_at === OCT05 + 60,
      `#1137 A1: a later lost race puts back the keep flag, not the state before a dead pull (got ${JSON.stringify(r && speculative(r))})`,
    );
  }

  // Review A2: a non-adoption reimport write (a source-attribute reconcile, an
  // AI reseed) logs dcs_reimport at the verse's observed version, and then the
  // adoption's CAS loses (the version moved under it). That write is not the
  // adoption landing: no row may claim the v7 overwrite.
  {
    const { sqlite, env } = migratedEnv();
    jdoe(sqlite);
    authoredBy(sqlite, 8, 4, 50, 7);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [auditRow(4, 50)], AUG19);
    const before = speculative(row(sqlite, 4, 50));
    const A = run1137(sqlite, env, { startedAt: OCT05, nightly: true }).attempt(OCT05);
    await A.begin();
    await A.record([ow(4, 50, 7)]);
    reimportLanded(sqlite, ow(4, 50, 7)); // the reconcile write: dcs_reimport, v7 -> v8
    await A.casLost([ow(4, 50, 7)]);
    assert(claimsOverwriteOf(sqlite, 4, 50, 7) === 0, "#1137 A2: a same-version non-adoption reimport write is not read as the adoption landing");
    const r = row(sqlite, 4, 50);
    assert(
      r != null && JSON.stringify(speculative(r)) === JSON.stringify(before),
      `#1137 A2: the audit row is back (got ${JSON.stringify(r && speculative(r))})`,
    );
  }

  // Review A3: a UI pull D speculates and dies before its CAS (a 502); two
  // hours later another pull P runs the chapter and no longer adopts the
  // verse. P's start rolls back D's stale, unlanded capture.
  {
    const { sqlite, env } = migratedEnv();
    jdoe(sqlite);
    authoredBy(sqlite, 8, 4, 51, 7);
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [auditRow(4, 51)], AUG19);
    const before = speculative(row(sqlite, 4, 51));
    const D = run1137(sqlite, env, { startedAt: OCT05, nightly: false }).attempt(OCT05);
    await D.begin();
    await D.record([ow(4, 51, 7)]); // dies here
    const P = run1137(sqlite, env, { startedAt: OCT05 + 7200, nightly: false }).attempt(OCT05 + 7200);
    await P.begin(); // and records nothing for 4:51
    assert(claimsOverwriteOf(sqlite, 4, 51, 7) === 0, "#1137 A3: a later pull rolls back a dead pull's stale unlanded claim");
    const r = row(sqlite, 4, 51);
    assert(
      r != null && JSON.stringify(speculative(r)) === JSON.stringify(before),
      `#1137 A3: the audit row is back (got ${JSON.stringify(r && speculative(r))})`,
    );
  }

  // Review A3's guard: a capture younger than the threshold may belong to a
  // run still in flight, so another run's start leaves it alone.
  {
    const { sqlite, env } = migratedEnv();
    await recordVerseMergeConflicts(env, "EZK", "ust", "UST", [auditRow(4, 52)], AUG19);
    const X = run1137(sqlite, env, { startedAt: OCT05, nightly: false }).attempt(OCT05);
    await X.begin();
    await X.record([ow(4, 52, 7)]); // still in flight
    const P = run1137(sqlite, env, { startedAt: OCT05 + 60, nightly: false }).attempt(OCT05 + 60);
    await P.begin();
    assert(row(sqlite, 4, 52)?.prior_run != null, "#1137 A3: a young capture from another run is not rolled back");
  }
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll verseMergeConflicts tests passed");
}
