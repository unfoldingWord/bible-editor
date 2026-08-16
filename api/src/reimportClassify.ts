// How the reimport should treat an existing (non-tombstone) row when it also
// appears in the incoming master TSV. Pure decision, split out so it is unit-
// testable without dragging in bookReimport's runtime deps.
//
// The reorder-preservation invariant (the reason this is its own function):
// a TN/TWL reorder writes only sort_order via the rows.ts fast path — it does
// NOT bump version or updated_by, so the row still reads as pristine. If the
// reimport keyed "no-op" on sort_order matching (it used to: sigMatch &&
// sortMatches), a reordered-but-content-identical row looked like a pristine
// change and got its sort_order overwritten back to master file order — the
// documented HOS 11 TN / HOS 12 TWL reorder-revert bug. Order flows app→master
// (the nightly export renders D1's sort_order into TSV row order), so for those
// rows D1 is the source of truth for order and a content-identical row must
// PRESERVE its local sort_order rather than adopt file order.
//
// This preservation is SCOPED (see caller): only tn/twl (the resources with an
// in-app reorder gesture) whose row already carries a non-null sort_order.
// (twl caveat: this only preserves the row through the reimport row loop —
// canonical ULT-position order is (re)asserted afterwards by the twl canonical
// post-pass in bookReimport.runReimport, which owns twl sort_order.)
//   - tq has NO in-app reorder (its PATCH schema has no sort_order; the fast
//     path can't fire for it), so master file order stays authoritative — a
//     master-side reorder must still sync in.
//   - a NULL sort_order carries no order to preserve, so a content-identical
//     null row must still be repaired to file order (else it exports at the end
//     via `NULLS LAST`).
// Both of those fall through to the normal adopt-from-master path.
//
// "reimportable" (below) is broader than "pristine": a row the AI pipeline wrote
// but no human has since edited is also safe to overwrite from master (see
// isReimportableRow). Such a row is re-seeded AND returned to master-owned
// (updated_by → NULL); the caller writes it under a relaxed guard (version-CAS
// + re-asserted protections) and counts it as `reimported_ai` rather than the
// misleading `skipped_edited`. `aiOnly` distinguishes that case so the caller
// picks the right write guard + counter.
// "merge_fields" is not returned by classifyReimportRow itself (verses have no
// concept of it) — it's the TSV-specific refinement the caller applies when
// classifyReimportRow says "edited" but computeEditedFieldMerge below finds
// master-owned fields to adopt anyway. Named here so callers/tests share one
// vocabulary for "edited, but partially merged" vs plain "edited".
export type ReimportFate = "noop" | "edited" | "update" | "update_ai" | "merge_fields";

export function classifyReimportRow(
  contentMatches: boolean,
  sortMatches: boolean,
  reimportable: boolean,
  preserveLocalOrder: boolean,
  aiOnly = false,
): ReimportFate {
  // Content AND order both match master → nothing to import.
  if (contentMatches && sortMatches) return "noop";
  // Content matches but order differs, and this row owns its order locally
  // (tn/twl with a stored sort_order) → preserve the reorder; do NOT adopt
  // master file order. This is the reorder-revert fix. (Applies to AI-only rows
  // too: a content-identical row that only differs in order stays a no-op — the
  // AI never gains a stale re-seed; it self-heals to master-owned on the next
  // content change.)
  if (contentMatches && preserveLocalOrder) return "noop";
  // Otherwise the row must take master's content and/or file-order sort_order:
  // content drifted, OR order diverged on a row whose order master owns (tq /
  // null sort_order). A human-edited row is never clobbered; a pristine one is
  // updated from master; an AI-only one is re-seeded AND reclaimed to
  // master-owned via the update_ai path.
  if (!reimportable) return "edited";
  return aiOnly ? "update_ai" : "update";
}

// Source label the AI pipeline stamps on every edit_log row it writes. Kept in
// sync with pipelineImport.ts AI_SOURCE (the delete-sweep precedent this mirrors).
export const AI_SOURCE = "ai_pipeline";

// Column shape needed to decide whether a reimport may overwrite a row.
export interface ReimportableRow {
  // Non-null once anyone (human OR the AI pipeline) has written the row.
  updated_by: number | null;
  // source of the latest content-bearing (create/update) edit_log entry for the
  // row, or null if none / not fetched. The ONLY signal that separates an
  // AI-written row (source = ai_pipeline) from a human edit (source null/manual)
  // once updated_by is set.
  latestSource: string | null;
  deleted_at: number | null;
  // tn-only human-owned protections. Ignored for tq/twl/verse.
  trashed_at?: number | null;
  preserve?: number | null;
  hint?: number | null;
  kind: "tn" | "tq" | "twl" | "verse";
}

// True iff the reimport may overwrite this (non-tombstone) row from master.
// Two admissible cases, both meaning "no human owns this row":
//   1. pristine        — updated_by IS NULL (never touched at all);
//   2. AI-only         — updated_by set, but the latest content edit_log entry
//                        is source = ai_pipeline (the AI pipeline wrote it and no
//                        human has edited it since — a human PATCH would write a
//                        null/manual-source edit_log row, flipping this false).
// Human-owned protections still block overwrite regardless of the above: a
// tombstone (deleted_at), a note queued for deletion (trashed_at), or an
// explicit preserve/hint flag (tn). This mirrors the pipelineImport deleteUnkeptTns
// safety predicate; the caller re-asserts the same conditions at write time
// (version-CAS + flag re-assertion) so a human edit landing mid-import can't be
// clobbered.
export function isReimportableRow(r: ReimportableRow): boolean {
  if (r.deleted_at != null) return false;
  if (r.kind === "tn") {
    if (r.trashed_at != null) return false;
    if (Number(r.preserve ?? 0) !== 0) return false;
    if (Number(r.hint ?? 0) !== 0) return false;
  }
  if (r.updated_by == null) return true; // pristine
  return r.latestSource === AI_SOURCE; // AI-only, never human-edited
}

// ── Per-field ownership merge on human-edited rows ──────────────────────────
//
// A row classified "edited" is not all-or-nothing owned by the human who
// touched it. Some columns are never human-settable (or only conditionally
// so), and a purely cosmetic whitespace difference in a note is never a
// deliberate edit. Reverting a DCS maintainer's release-prep cleanup on those
// columns every night — 130 of 209 hand-edits reverted in one measured run —
// is the bug this closes. Fields NOT covered here (quote, occurrence,
// support_reference, orig_words, tw_link, and any substantive note
// difference) stay D1's forever once a human has edited the row; ref_raw/
// chapter/verse are identity and are never touched by either path.

// TSV kind this merge applies to. Redeclared rather than imported from
// bookReimport.ts's TsvKind: this module is intentionally free of any
// bookReimport dependency (D1-free, unit-testable without a database) — see
// the file header. Keep in sync if a new TSV kind is ever added.
export type TsvRowKind = "tn" | "tq" | "twl";

// The subset of a TSV row's columns eligible for the merge. `tags` is common
// to all three kinds; the free-text field(s) vary — tn has `note`, tq has
// `question` + `response`, twl has neither (its only free-text-ish column,
// `tw_link`, is never merged).
export interface MergeableTsvFields {
  tags: string | null;
  note?: string | null;
  question?: string | null;
  response?: string | null;
}

export type EditedFieldMerge = Partial<Pick<MergeableTsvFields, "tags" | "note" | "question" | "response">>;

// The same human-owned protections isReimportableRow checks, re-declared here
// so this function stays pure/self-contained for its own unit tests without a
// ReimportableRow. Any of these set means "protections win" — never merge,
// even if a field would otherwise qualify.
export interface MergeProtections {
  deleted_at?: number | null;
  trashed_at?: number | null;
  preserve?: number | null;
  hint?: number | null;
}

// Collapse a TSV note's literal two-char "\n" escape (its encoded line break)
// to a space, then every whitespace run to a single space, then trim. Two
// notes differing ONLY by this kind of incidental whitespace — a stray double
// space, a space that landed next to an encoded line break — read as the same
// note to a human, so they're eligible to adopt master's exact bytes without
// being treated as a substantive translator edit.
function collapseForCompare(s: string | null | undefined): string {
  return (s ?? "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
}

// Fields a reimport may still adopt from master on a row classifyReimportRow
// has already called "edited" (i.e. `isReimportableRow` is false — a human
// owns it). Returns null when nothing qualifies, meaning the row stays a
// plain "edited" skip exactly as before this change.
//
//   - tags (tn/tq): there is no UI to set it on these kinds — no human can
//     ever have deliberately owned this field — so always adopt master's
//     value, including a blank one.
//   - tags (twl): TWL creation DOES have a tags control (Shell.tsx), so a
//     human CAN own it — adopt master's value only when it's non-empty, so a
//     blank incoming value never wipes a deliberately-set tag.
//   - note / question / response: adopt master's value only when the two
//     differ by nothing but incidental whitespace (collapseForCompare).
export function computeEditedFieldMerge(
  kind: TsvRowKind,
  d1: MergeableTsvFields,
  master: MergeableTsvFields,
  protections: MergeProtections,
): EditedFieldMerge | null {
  if (protections.deleted_at != null) return null;
  if (protections.trashed_at != null) return null;
  if (Number(protections.preserve ?? 0) !== 0) return null;
  if (Number(protections.hint ?? 0) !== 0) return null;

  const merge: EditedFieldMerge = {};

  if (kind === "twl") {
    if ((master.tags ?? "") !== "" && master.tags !== d1.tags) merge.tags = master.tags;
  } else if (master.tags !== d1.tags) {
    merge.tags = master.tags;
  }

  const noteFields: Array<"note" | "question" | "response"> =
    kind === "tn" ? ["note"] : kind === "tq" ? ["question", "response"] : [];
  for (const f of noteFields) {
    const dVal = d1[f] ?? null;
    const mVal = master[f] ?? null;
    if (dVal === mVal) continue; // already equal, nothing to adopt
    if (collapseForCompare(dVal) === collapseForCompare(mVal)) merge[f] = mVal;
  }

  return Object.keys(merge).length > 0 ? merge : null;
}

// ── Reissued-tombstone discriminator (issue #427, option 2) ─────────────────
//
// A soft-deleted tn/tq/twl row keeps its `(book, id)` PRIMARY KEY slot forever
// — the row stays, only `deleted_at` is stamped. So when master's TSV carries
// that same id, the reimport's tombstone branch (bookReimport.ts's applyTsvRows)
// declines to apply master's row, and its `INSERT ... ON CONFLICT(id, book) DO
// NOTHING` would refuse it too. Both outcomes are silent: master's row simply
// never lands in D1.
//
// That silence is CORRECT for one of the two cases and WRONG for the other, and
// this function is the discriminator (the same one the 2026-08-10 production
// sweep used to classify all 10,645 live tombstones):
//
//   - master carries the id at the SAME reference → the row is a delete that
//     hasn't been exported to Door43 yet. Skipping is exactly what preserves
//     that pending deletion; reapplying master's copy would resurrect it on
//     every nightly run. Returns false. (4 AMO rows were in this state during
//     the sweep.)
//   - master carries the id at a DIFFERENT reference → the id has been reissued
//     to a genuinely different row (bp-assistant mints ids from a repeating
//     sequence, so collisions recur — see the tq-tombstone-PK-collision note).
//     Master's row is real, new, and being dropped. Returns true. This is the
//     1CH 23 tQ case: six ids tombstoned at 1CH 5:x were reissued at 1CH 23:x
//     and vanished, and the book's watermark was stamped in-sync anyway.
//
// Deliberately compares the REFERENCE, not the content: a reissued id points at
// different scripture, which is the only signal available without reading the
// whole book. `ref_raw` is the authoritative comparison (it is what the master
// TSV's Reference column literally holds, including verse bridges like "1:2-3"
// and "front:intro"); (chapter, verse) is the fallback when a row's ref_raw is
// empty.
//
// KNOWN FALSE POSITIVE, and its cost is not small — read before touching this.
// The reference test cannot separate "the id was re-minted for a different row"
// (real loss) from "the SAME row, deleted in-app, whose Reference a Door43
// maintainer then corrected" — a re-anchor to 1:3, or a bridge widened to
// "1:2-3". The second loses nothing; the row is deleted and the delete is merely
// pending export. This function reports both as blocked.
//
// Do NOT reason about that as "worst case, a delayed export." The caller's
// withhold has NO automatic release (unlike a chapter lock, a tombstone never
// expires), so a false positive stops that book+resource exporting until a human
// intervenes — see raiseTombstoneBlockAlert in bookReimport.ts, which exists
// precisely so the freeze is visible and actionable rather than silent. The
// direction is still deliberate: the alternative to withholding is exporting a
// D1 that is short of master, which DELETES those rows from Door43. But the
// tradeoff is "a loud freeze vs. silent deletion on Door43", not "slow vs.
// fast", and any change here should be weighed on those terms.
//
// The 2026-08-10 production sweep found 0 blocked across 10,645 tombstones,
// which bounds how often this fires today — but it is a point-in-time shape,
// not a bound on the false-positive rate going forward.
//
// This function does NOT decide whether master's row should be applied — that
// would be issue #427's option 1 (id reclaim), deliberately out of scope. It
// only decides whether the skip is worth REPORTING and worth withholding the
// (book, resource) watermark for.
//
// Pure (no D1) so it is regression-testable — see reimportClassify.test.mjs.
export interface TombstoneRef {
  refRaw?: string | null;
  chapter: number;
  verse: number;
}

function normalizeRef(r: TombstoneRef): string {
  const raw = (r.refRaw ?? "").trim().replace(/\s+/g, "");
  if (raw !== "") return raw;
  return `${r.chapter}:${r.verse}`;
}

export function isReissuedTombstone(stored: TombstoneRef, incoming: TombstoneRef): boolean {
  return normalizeRef(stored) !== normalizeRef(incoming);
}

// ── Obsolete-tombstone discriminator (issue #427, option 3) ─────────────────
//
// A tombstoned row's id is "obsolete" — pure dead weight, safe to hard-delete
// and free the (book, id) primary-key slot — iff master's current book-wide
// TSV does not carry that id AT ALL, at any reference. Trivial as a predicate
// (a single Set.has check), but pulled out as its own named, tested function
// for the same reason isReissuedTombstone above is: so the DISJOINTNESS claim
// between this predicate and isReissuedTombstone is something a test can
// drive directly, not just something a comment asserts.
//
// The two partition the exact same membership test from opposite sides:
//   - isReissuedTombstone is only ever consulted (in bookReimport.ts's
//     applyTsvRows) for an id that IS present in `incoming` — i.e. an id
//     `masterIds.has(id)` is true for.
//   - isObsoleteTombstoneId is true only when `masterIds.has(id)` is false.
// So for any single id, at most one of the two can ever be the live question —
// there is no id for which BOTH "master carries it" and "master does not
// carry it" hold. Sweeping an obsolete tombstone (this predicate) can
// therefore never remove the evidence a genuine reissue block
// (isReissuedTombstone) depends on. See tombstoneSweep.test.mjs for the
// integration-level proof against a real applyTsvRows run.
export function isObsoleteTombstoneId(id: string, masterIds: ReadonlySet<string>): boolean {
  return !masterIds.has(id);
}
