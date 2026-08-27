// Pure decision: when the nightly Door43->D1 sync finds D1 and master disagree
// on a verse's content_json, which side wins, and can we tell?
//
// Incident (2026-08-11, 1CH, commit 5905373879 on unfoldingWord/en_ult master):
// the pre-existing sync skipped any verse a human had ever edited in the app,
// so an out-of-band correction made directly on Door43 master never reached
// D1 — and the next nightly export then rendered D1 over master, silently
// reverting the human's Door43 work. 192 verses of 1CH were reverted this way.
//
// The fix is to recover the ancestor: the content_json we ourselves last
// published to master. It is NOT kept alongside the verse row — it is
// recovered from edit_log, as the newest kind='verse' payload for this verse
// dated before book_resource_syncs.master_confirmed_at for this (book,
// resource) — the watermark stamped only on a POSITIVE measurement that master
// holds our rendered output, NOT merely when we last pushed to a `-be-` branch
// (an unmerged branch push is routine here and is not proof master moved) (see
// bookReimport.ts's applyVerseRows).
//
// AMOS CORRECTION (2026-08-14): for a long time there was only ONE such
// measurement — the export's own commitToDcs pre-check (isMasterConfirmed),
// which by construction can only fire on a night the export pushed NOTHING. So
// every night the export ACTUALLY pushed a branch that later merged, master
// moved and the watermark did not, and this module's step 6 then read our own
// merged export as a foreign edit and let `adopt_conflict` overwrite the app
// edits made since. AMO ch2 lost a translator's 2026-08-13 work that way.
// A second measurement now closes it: the sync hashes master's bytes and
// recognizes the render we recorded at push time (ownPublish.ts /
// markOwnPublishConverged), which both advances the watermark and skips this
// merge for that resource entirely. Nothing in this module's decision table
// changed — it was correct given a correct ancestor; the ancestor was wrong.
// edit_log has a 180-day
// retention sweep (index.ts), so once a verse's pre-export history ages out
// the ancestor becomes unrecoverable — keep_no_base must stay a first-class,
// expected outcome, not a bug. With the ancestor in hand, a difference can be
// ATTRIBUTED to whichever side actually moved, instead of guessing from D1
// and master alone:
//   - if master still equals the ancestor, master never moved — the
//     difference is ours, and keeping D1 is simply correct (this was already
//     the behavior before this module existed).
//   - if D1 still equals the ancestor, we never moved — master's edit is safe
//     to adopt.
//   - if BOTH moved since the ancestor, master wins (it is the side a human
//     just touched by hand on Door43), but a human must review the collision.
// When no ancestor is recoverable at all, attribution is impossible and we
// must keep D1 — the pre-existing, safe default.
//
// FIX H: a per-verse refusal ("keep_alignment_refused") is NOT contained to
// one verse — this comment previously claimed it "does not block anything
// else in the book," which stopped being true once reimportSyncGate.ts's
// SYSTEMIC_MERGE_REFUSAL_THRESHOLD (5) shipped. Once a (book, resource)
// accumulates that many refusals in one run, bookReimport.ts withholds the
// sync watermark for the WHOLE (book, resource), which makes
// checkMasterFreshness (exportWorkflow.ts) report `master_ahead` and skip
// that (book, resource) from every nightly export until a human resolves the
// refusals — not just the flagged verses. See reimportSyncGate.ts's
// "Systemic alignment-refusal gate" section for the full mechanism, and its
// isSystemicMergeRefusal for the (now overridable — see below) threshold
// check. Below that threshold, a refusal is still cheap: the fallback is
// "flag this one verse for a human to look at," not "freeze the book."
//
// Pure (no D1) so it's regression-testable without a Workflow context — see
// shrinkGuard.ts and reimportSyncGate.ts for the same pattern.
import { analyzeAlignmentDelta } from "./alignmentDelta.ts";

export type VerseMergeAction =
  | "keep_converged" // ours and theirs already identical
  | "keep_no_base" // no ancestor recoverable — cannot attribute, keep D1
  | "keep_master_unchanged" // master === base: their side never moved
  | "keep_alignment_refused" // adopting would lose alignment — keep D1, needs a human
  | "keep_ai_master" // both moved, but no human moved master — keep D1, needs a human
  | "adopt" // master moved, we did not
  | "adopt_conflict"; // both moved — master wins, but a human must review

export interface VerseMergeInput {
  /** content_json we last published to master, or null when unrecoverable. */
  base: string | null;
  /** D1's current content_json. */
  ours: string;
  /** Master's current content_json, ALREADY normalized by extractVersesForRange. */
  theirs: string;
  /** True when a human edit_log row exists after our last export commit. */
  humanEditedSinceExport: boolean;
  /**
   * Could a human have written master's side of THIS VERSE's difference? FALSE
   * only when a COMPLETE commit-lineage walk of master's file since the
   * ancestor found nothing but our own export commits and bp-assistant pushes
   * — or (issue #557) when it did find human commits but a COMPLETE map of
   * every one of their diff hunks says none of them landed in this verse. See
   * masterLineage.ts.
   *
   * Callers must pass `masterMayHoldHumanEditForVerse(lineage, chapter, verse)`
   * — or `masterMayHoldHumanEdit(lineage)` where there is no verse to narrow by
   * — never a boolean they reconstructed: an incomplete walk is not "no human
   * found", and a partial hunk map is not "the human touched only these".
   *
   * OMITTED means the caller never looked, which reads as `true` — today's
   * behavior, master wins a both-changed conflict. Only an explicit `false`
   * flips step 6.
   */
  masterMayHoldHumanEdit?: boolean;
}

export interface VerseMergeResult {
  action: VerseMergeAction;
  /** action is "adopt" | "adopt_conflict" */
  adopt: boolean;
  /** needs a human: "adopt_conflict" | "keep_alignment_refused" | "keep_ai_master" */
  conflict: boolean;
  /** short stable machine reason, safe to persist and to log */
  reason: string;
  /** present only when the alignment comparison actually ran */
  alignment?: { beforeAligned: number; afterAligned: number; lostWords: string[] };
}

// Recursively sorts object keys so two content_json strings that differ only
// by writer-dependent key order compare equal. Arrays keep their order —
// order is semantic in verseObjects. Also collapses whitespace runs in any
// `text` property value (and trims it) — this is FOR COMPARISON ONLY; it never
// touches the bytes we actually write on an adoption (buildVerseMerge's
// callers pass the untouched `theirs` string through to storage).
//
// Why: `extract(render(x)) !== x` for a large fraction of real verses —
// buildUsfm -> normalizeUsfmFormatting (export.ts) rewrites blank-line layout,
// and re-parsing absorbs the changed blank lines into the verse's trailing
// text node (e.g. `".”\n"` round-trips to `".”\n\n"`). Comparing `ours`
// (D1's stored content_json) against `theirs` (master re-parsed) byte-for-byte
// therefore reports "master moved" on ~17% of verses that never actually
// changed — measured on docs/samples/en_ult_38-ZEC.usfm (37/225) and
// en_ust_38-ZEC.usfm (42/225) — which silently rewrites the verse, bumps
// `version`, and reopens the checkoff lanes (see laneReopen.ts), deleting a
// checker's sign-off for a purely cosmetic non-change.
//
// This normalization is safe in every direction it feeds computeVerseMerge:
// collapsing whitespace can only ever make two sides look MORE equal, never
// less equal, so it can only ever move a comparison FROM "different" TOWARD
// "equal" — it cannot manufacture a false match out of a genuine difference.
// Walking through every comparison that reads stableKey's output:
//   - step 1 (ours == theirs): a false positive here would silently keep D1
//     when master actually changed — but the only way this comparison flips
//     is a difference the ORIGINAL bytes carry that a whitespace-collapse
//     erases, i.e. genuinely a whitespace-only difference, which is exactly
//     the class this fix intends to treat as "no change".
//   - step 3 (theirs == base): same reasoning — flips only on a
//     whitespace-only difference between master and the ancestor, which
//     means master didn't really move.
//   - step 5 (ours == base), the `adopt` gate: this branch is only reached
//     once step 3 has ALREADY established theirs != base (master genuinely
//     changed). FIX 6 CORRECTION — this bullet previously claimed
//     "normalizing can only make ours look MORE like base, so it can only
//     REDUCE how often this branch is reached." That is backwards: making
//     ours look MORE like base makes `keysEqual(oursKey, baseKey)` true
//     MORE often, so this branch (and the `adopt` return) fires MORE often,
//     not less — and correspondingly `adopt_conflict` fires less. What
//     stays true is the claim on WRITE COUNT: every verse that reaches this
//     gate already had theirs != base (a real, landed difference), so
//     normalization never manufactures an adoption that wasn't already
//     going to write something — it only reclassifies some `adopt_conflict`
//     writes (flagged for human review) into unflagged `adopt` writes. The
//     mitigation: every landed adoption, `adopt` included, gets a durable
//     `verse_merge_conflicts` row with its `overwritten_version` (see
//     applyVerseRows step 6b / recordVerseMergeConflicts) — the banner
//     alert filters `adopt` out, but the text is still recoverable via
//     GET /api/verse-merge-conflicts/:book and the verse's own version
//     history. One reachable path to this shape: the ancestor sub-select in
//     applyVerseRows has no `source` filter (an `ai_pipeline` write is an
//     eligible ancestor), while `human_edit_after_export` requires
//     `source IS NULL` — so an AI whitespace-churn write landing after the
//     watermark can itself become the `base`, and a later human edit that
//     normalizes back toward it reads as `adopt` instead of
//     `adopt_conflict`.
// Net effect: adoptions caused purely by round-trip whitespace noise drop to
// zero; nothing that was a real content change stops being adopted (in the
// sense that a write still happens — see the correction above for how it can
// be classified differently). The one cost is that a genuinely
// whitespace-only edit on master is no longer adopted at all — that is the
// pre-existing status quo (this module didn't exist before), not a
// regression. FIX 5 CORRECTION — this comment previously claimed
// export.ts's normalizeUsfmFormatting "already emits the maintainer's
// preferred shape on our own renders... so formatting divergence is handled
// on the export side, not here." That is false: normalizeUsfmFormatting
// (usfmFormat.ts) is entirely LINE-level (marker run order, blank-line
// layout, poetry joins) — there is no intra-text whitespace collapsing
// anywhere in the render path. The real trade-off: a maintainer genuinely
// adding a missing space after a comma on Door43 is classified
// `keep_converged` here, recorded nowhere, and silently reverted by every
// nightly export — there is no side of this codebase that "handles" it.
// What this fix DOES do about that: when the comparison says converged but
// the raw content_json strings actually differed, applyVerseRows increments
// `counts.merge_cosmetic_ignored` so the class is visible in the reimport
// counts rather than invisible.
function normalizeForCompare(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  return value;
}

// Exported so callers outside this module's own comparison (e.g.
// bookReimport.ts's Task 3 lane-reopen guard: don't delete a checker's
// 'text' sign-off for an adoption that didn't actually change the verse's
// plain text) can apply the IDENTICAL whitespace-insensitive rule this
// module uses for content_json comparison, rather than maintaining a second
// copy of the regex that could drift out of sync.
export function collapseWhitespaceForCompare(value: string | null): string {
  return value == null ? "" : value.replace(/\s+/g, " ").trim();
}

// FIX A follow-up (residual after the whitespace fix): export.ts's
// recomputeTargetOccurrences renumbers a TARGET `\w` node's `occurrence` /
// `occurrences` from document position every time buildUsfm runs. Measured on
// a second render→reparse pass (5-pass convergence check, docs/samples ZEC):
// this renumbering is one-shot churn, not oscillating — every affected verse
// converges by pass 2 and stays converged. It still costs one spurious
// `adopt` per affected verse (8/225 on the UST sample = ~3.6% of edited
// verses): a real version bump, a real edit_log row, and (before FIX
// Task 3) a real checkoff reopen, none of which reflect an actual change to
// the verse. The root cause looks like a scope mismatch between two
// occurrence-counting passes (extraction-time vs buildUsfm's per-verse
// recompute) rather than an added/removed word — e.g. observed "the" going
// occurrence 1/4 -> 1/5 with the exact same word nodes otherwise.
//
// Fix: for comparison ONLY, drop `occurrence` and `occurrences` from any
// node shaped exactly like the TARGET word nodes recomputeTargetOccurrences
// itself selects (`type === "word" && tag === "w"`) — the identical
// selector, so this can never touch a `\zaln` milestone's own
// occurrence/occurrences (the SOURCE-side instance identifier, which this
// renumbering bug never touches and which must stay compared exactly).
//
// Why this is safe, same shape as the whitespace argument above: dropping a
// field from the compared form can only make two sides look MORE equal,
// never less — it can only REDUCE how often steps 1/3/5 conclude "different"
// or "adopt", never manufacture a new match out of a genuine difference.
// Concretely: if theirs actually added, removed, or reordered a word, the
// node ARRAY differs (a node is missing/extra/moved), which this drop does
// nothing to hide — JSON.stringify still sees a different array shape/length
// regardless of what's inside each surviving node. The only way dropping
// occurrence/occurrences can flip a comparison from "different" to "equal"
// is when every node's type/tag/text/children (and every other node in the
// tree) already matched and ONLY the numeric occurrence label differed —
// which is exactly the renumbering artifact, never a real edit. (A
// genuinely meaningful alignment change — e.g. re-pointing which occurrence
// of a repeated word a `\zaln` milestone wraps — changes the MILESTONE's
// own occurrence/occurrences, or its children, not the bare `\w` leaf this
// drop is scoped to; that milestone-level data is untouched here.)
//
// IMPORTANT: this is scoped to the merge ATTRIBUTION decision only.
// occurrence/occurrences remain semantically load-bearing everywhere else in
// this codebase (they identify which instance of a repeated word an
// alignment or a TWL/TN Occurrence column means, and Occurrence is a
// hard-reject column on export — see occurrenceRule.ts) — an adoption's
// WRITTEN bytes are still master's real `theirs` string, occurrence values
// included, verbatim. Nothing here changes what gets stored, only whether a
// pure renumbering artifact gets treated as "master moved."
function dropOccurrenceForWordNodes(obj: Record<string, unknown>): Record<string, unknown> {
  if (obj["type"] !== "word" || obj["tag"] !== "w") return obj;
  const { occurrence: _occ, occurrences: _occs, ...rest } = obj;
  return rest;
}

// Investigating Task 2's expected "adopt: 0 on both samples" turned up a
// SECOND, distinct residual on the UST sample that is NOT the occurrence-
// renumbering bug: a trailing marker's `nextChar` property (the whitespace
// character usfm-js records as following a marker tag, e.g. a `\q1` right
// before the next verse) round-trips as `"\n"` in one pass and `" "` in the
// next — same "buildUsfm's blank-line reflow gets absorbed differently on
// re-parse" root cause as FIX A's `text`-property fix, just landing on a
// different key. Confirmed by a full node-by-node diff of UST 1:4: the ONLY
// differing array element between ours/theirs is
// `{"tag":"q1","nextChar":"\n"}` vs `{"tag":"q1","nextChar":" "}` — no
// occurrence/occurrences involved at all. Folded in here under the exact
// same whitespace-collapse treatment (and the exact same safety argument
// above `normalizeForCompare`) rather than left unfixed, since leaving it
// would contradict the "no remaining spurious adopts" goal for a cause that
// is mechanically identical to the already-approved `text` fix.
//
// #627 presence half of the same nextChar artifact: after normalizeForCompare
// collapses `" "` / `"\n"` to `""`, sortKeysDeep used to KEEP the now-empty
// key, so `nextChar: ""` still stringified differently from an absent
// `nextChar`. Measured on live JER trees (Door43 master vs prod D1,
// 2026-08-25): ULT 42:6, UST 42:6/17/18 differed ONLY on that presence —
// 4 of 13 unresolved merge-review flags, all false. Omit `text` / `nextChar`
// when the normalized value is the empty string so empty, whitespace-only,
// and absent all compare equal. Same safety argument: dropping an empty
// value can only make two sides look MORE equal, never less.
//
// #627 empty text nodes: a `type: "text"` node whose text is empty or
// whitespace-only carries nothing but still occupies an array slot, so one
// extra empty node on one side shifts every following index and the trees
// compare unequal. Measured: ULT 42:11 (36 vs 35 empty text nodes) and
// UST 42:8 (31 vs 30) were byte-identical after stripping them — 2 more of
// the 13 false JER flags. For comparison ONLY, skip those nodes when walking
// an array. A real added/removed/reordered word still changes the node array
// in ways this filter cannot hide. Written adoption bytes stay master's real
// `theirs` string, untouched — same discipline as the occurrence-drop rule.
function isEmptyTextNode(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj["type"] !== "text") return false;
  // #609 review F7: dropping the node drops EVERYTHING on it, so it may only be
  // dropped when `type` and `text` are all it carries. A `type: "text"` node that
  // also has `children` (or any other key) is not "an empty text node" — treating
  // it as one would silently delete whatever those keys hold from the compared
  // form, which is a hole the safety argument above does not cover. Cheap, and it
  // keeps the rule exactly as narrow as its justification.
  for (const key of Object.keys(obj)) {
    if (key !== "type" && key !== "text") return false;
  }
  const text = obj["text"];
  if (typeof text !== "string") return text == null;
  return (normalizeForCompare(text) as string) === "";
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => !isEmptyTextNode(item)).map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const obj = dropOccurrenceForWordNodes(value as Record<string, unknown>);
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const child =
        key === "text" || key === "nextChar" ? normalizeForCompare(sortKeysDeep(obj[key])) : sortKeysDeep(obj[key]);
      // Omit keys whose compare form collapsed to empty string — `nextChar: ""`
      // (or whitespace that normalized to "") must equal an absent nextChar.
      if ((key === "text" || key === "nextChar") && child === "") continue;
      sorted[key] = child;
    }
    return sorted;
  }
  return value;
}

// #609 review F8: the try covers sortKeysDeep and the re-stringify too, not just
// the parse. Either can throw on real input — a cyclic structure, or a tree deep
// enough to blow the stack — and an uncaught throw here escapes into the nightly
// sync's verse loop. Returning null instead means "cannot compare", which every
// caller reads as "not converged" and therefore WRITES: the safety direction is
// total, with no shape of input that can turn a failure into a suppression.
function stableKey(json: string): string | null {
  try {
    return JSON.stringify(sortKeysDeep(JSON.parse(json)));
  } catch {
    return null;
  }
}

// Two stableKey results are "equal" only when both are non-null and match.
// A null on either side (unparseable JSON) is never equal to anything.
function keysEqual(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a === b;
}

// Issue #609: the SAME lens step 1 (`keep_converged`) uses, exposed for the
// nightly sync's PRISTINE and AI-only verse writers, which never reach
// computeVerseMerge at all — they compared master's bytes to D1's raw, so a verse
// where our own render→reparse does not settle (16-19% of the corpus, STATE.md)
// was rewritten and version-bumped with nothing a translator could see having
// changed.
//
// MAGNITUDE, stated at the size it was actually measured. This is NOT "every
// verse, every night, forever": STATE.md measures round trips as CONVERGENT, not
// oscillating — a verse differs once and then stabilizes over 5 passes. What #539
// measured is that 7,461 of 11,768 sync verse writes (63.4%) landed on a verse the
// sync had already rewritten before, i.e. 1.34 writes per touched verse over ~36
// days, and #609 warns — with evidence — that the WORST repeaters (LAM/1/22/UST,
// EZK/2/0/UST) are `\p` marker PILEUP, a genuinely growing content difference no
// lens should suppress and this one does not (a changed node array is never
// lens-equal). How much of the remaining churn this lens actually removes is
// unmeasured; do not cite this comment as if it were measured.
//
// Returns true ONLY when both sides parse AND their normalized forms match, so
// unparseable JSON on either side is never "converged" — the caller writes, which
// is the pre-existing behavior. Every safety argument above `normalizeForCompare`
// and `dropOccurrenceForWordNodes` applies unchanged: each rule can only ever move
// a comparison FROM "different" TOWARD "equal". It cannot report equality for a
// tree whose node array actually gained, lost or reordered a node.
//
// What the rules suppress is slightly WIDER than the artifacts that motivated
// them, so read them as written, not as a list of causes: a target `\w`'s
// occurrence/occurrences compare equal when one side merely OMITS them (not only
// when they are renumbered), and a whitespace-only text node dropped next to an
// in-flow marker compares equal too. Both are re-derived on export
// (recomputeTargetOccurrences, normalizeUsfmFormatting), so neither survives as a
// stored difference — but neither is "renumbering" or "blank-line reflow" either.
//
// NOT SUFFICIENT ON ITS OWN for a write decision, and the pristine caller does not
// treat it as such. Review finding F1 measured two whitespace shapes this lens
// normalizes away that CHANGE the rendered USFM — a text node `"and"` vs `"and "`
// before a `\w`, and a whitespace-only separator between two `\w` nodes, both of
// which render as a fused word token (the PR #417 class). So
// bookReimport.ts's isNormalizedNoopVerseWrite ANDs this with a second condition:
// the export's own renderer must emit identical bytes for both trees. See that
// function for why both are needed and why neither is a superset of the other.
//
// That AND is also what settles the cost this lens would otherwise carry. On the
// EDITED path (computeVerseMerge, no render check) the FIX 5 correction above still
// stands: a Door43 maintainer's genuinely whitespace-only edit is classified
// converged and silently reverted. On the pristine path it is not, because a
// whitespace edit that survives our render makes the render check fail and the
// verse WRITES. Callers must still count what they suppress (see bookReimport.ts's
// `skipped_normalized`) so the class is never invisible.
export function verseContentConverged(ours: string, theirs: string): boolean {
  return keysEqual(stableKey(ours), stableKey(theirs));
}

export function computeVerseMerge(input: VerseMergeInput): VerseMergeResult {
  const { base, ours, theirs, humanEditedSinceExport, masterMayHoldHumanEdit } = input;

  const oursKey = stableKey(ours);
  const theirsKey = stableKey(theirs);

  // 1. ours and theirs already identical.
  if (keysEqual(oursKey, theirsKey)) {
    return { action: "keep_converged", adopt: false, conflict: false, reason: "converged" };
  }

  // 2. No ancestor recoverable — cannot attribute, keep D1.
  if (base === null) {
    return { action: "keep_no_base", adopt: false, conflict: false, reason: "no_base" };
  }

  const baseKey = stableKey(base);

  // 3. Master never moved since the ancestor — the difference is ours.
  if (keysEqual(baseKey, theirsKey)) {
    return { action: "keep_master_unchanged", adopt: false, conflict: false, reason: "master_unchanged" };
  }

  // 4. Alignment guard: refuse to adopt master's content if doing so would
  // lose alignment on words neither side meant to touch. Either side failing
  // to parse makes the comparison itself untrustworthy — fail closed.
  if (oursKey === null || theirsKey === null) {
    return { action: "keep_alignment_refused", adopt: false, conflict: true, reason: "unparseable" };
  }
  const delta = analyzeAlignmentDelta(JSON.parse(ours), JSON.parse(theirs));
  const lostWords = delta.unexpectedLosses.filter((loss) => loss.reason === "lost").map((loss) => loss.text);
  if (delta.afterAligned < delta.beforeAligned || lostWords.length > 0) {
    return {
      action: "keep_alignment_refused",
      adopt: false,
      conflict: true,
      reason: "alignment_shrink",
      alignment: {
        beforeAligned: delta.beforeAligned,
        afterAligned: delta.afterAligned,
        lostWords: lostWords.slice(0, 10),
      },
    };
  }

  // 5. Byte equality with the base is the strong proof our side did not move.
  // FIX D: humanEditedSinceExport does NOT close "a seconds-wide race between
  // the export's D1 read and its commit" — that race is now closed by WHICH
  // timestamp gets stamped as the watermark: exportWorkflow.ts's
  // stampMasterConfirmed stamps buildResource's D1-read time, not the later
  // commit time, so an edit landing in that gap is already dated after the
  // watermark and is caught by the humanEditedSinceExport query itself
  // (bookReimport.ts's `human_edit_after_export` sub-select, created_at >=
  // the watermark). What this flag actually guards against is narrower: a
  // human edit landing AFTER the watermark that happens to reconstruct
  // byte-identical content to `base` (e.g. undo-then-redo, or two edits that
  // cancel out) — byte equality alone would read that as "ours never moved"
  // and adopt cleanly, when in fact a human touched this verse after the
  // export and that touch deserves review, not a silent overwrite.
  if (keysEqual(oursKey, baseKey) && !humanEditedSinceExport) {
    return { action: "adopt", adopt: true, conflict: false, reason: "master_only" };
  }

  // 6. Both sides moved since the ancestor. Master wins — but ONLY if a human
  // could have written master's side.
  //
  // "Master is the side a human just touched by hand on Door43" was always the
  // justification for master-wins here, and it was never measured: it is also
  // where bp-assistant's overnight pushes land. AMO 4:2 is the shape — Beth
  // fixed a note by hand in the app, the pipeline's own earlier run was still
  // sitting on master, both sides read as moved, and the merge reverted her fix
  // to the text of her own AI run. Benjamin's ruling (#540 item 2):
  // AI-pipeline-authored master content must never beat a later human app edit.
  //
  // So when the lineage says every commit that moved master since the ancestor
  // was ours or the pipeline's, D1 wins and a human reviews. Master-wins stays
  // for a genuine maintainer edit, and for every case where we could not prove
  // there wasn't one — masterMayHoldHumanEdit is true when the walk was
  // incomplete and when the caller never looked.
  //
  // #557 narrowed the same flag from the FILE to the VERSE: a maintainer fixing
  // markers in chapter 23 no longer authorizes reverting an app edit in chapter
  // 40. The narrowing is upstream (masterMayHoldHumanEditForVerse) and it can
  // only ever answer the file-level question or a narrower one, on complete
  // positive evidence; unmapped, unparseable and unfetched all arrive here as
  // `true`, exactly as they did before.
  //
  // Nothing is written here, so nothing is lost either way: the export still
  // publishes D1 over master, which is the point — that is how the human's edit
  // reaches Door43 instead of being reverted by it.
  if (masterMayHoldHumanEdit === false) {
    return { action: "keep_ai_master", adopt: false, conflict: true, reason: "both_changed_ai_master" };
  }
  return { action: "adopt_conflict", adopt: true, conflict: true, reason: "both_changed" };
}
