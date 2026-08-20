// Pure decision: when the nightly Door43->D1 sync finds a HUMAN-EDITED tn/tq/twl
// row (updated_by != null) whose content differs from master, which side wins
// per field, and can we tell?
//
// This is the TSV analogue of verseMerge.ts (computeVerseMerge). The bug it
// closes is the same family as the 1CH verse incident (2026-08-11): the old
// reimport SKIPPED any edited tn/tq/twl row outright (classifyReimportRow ->
// "edited"), so an out-of-band correction a maintainer made directly on Door43
// master never reached D1 — and the next nightly export then rendered D1 over
// master, silently reverting the maintainer's work. The only adoption path for
// an edited row was computeEditedFieldMerge (reimportClassify.ts), which adopts
// nothing but `tags` and whitespace-only note churn. A real edit to quote,
// note, occurrence, support_reference, orig_words, or tw_link was lost.
//
// Like the verse side, the fix is to recover the ANCESTOR — the row content we
// ourselves last published to master — and attribute a D1/master difference to
// whichever side actually moved, per field:
//   - master moved a field, we did not  -> adopt master's value for that field
//   - we moved it, master did not        -> keep ours (our deliberate edit)
//   - BOTH moved the same field          -> master wins IF a human could have
//                                           written master's side (see
//                                           masterMayHoldHumanEdit below), and
//                                           the row is flagged for human review
//                                           so the overwritten D1 value can be
//                                           recovered from row version history.
//                                           When the lineage proves only our own
//                                           export and the AI pipeline moved
//                                           master, D1 wins instead and the row
//                                           is still flagged (keep_ai_master).
//   - neither moved (equal, or only whitespace differs) -> nothing to do.
// When no ancestor is recoverable at all (never exported / edit_log aged past
// the 180-day sweep), attribution is impossible and we keep D1 — the
// pre-existing safe default, now surfaced as `keep_no_base` so "the merge could
// not run here" is distinguishable from "nothing to merge".
//
// sort_order is DELIBERATELY NOT a merged field. tn/twl row order is D1-owned
// (the reorder-preservation invariant in reimportClassify.ts + the twl
// canonical post-pass in bookReimport.ts own it); adopting master's file order
// here would re-introduce the HOS 11 / HOS 12 reorder-revert bug. Identity
// columns (id, ref/chapter/verse) are never merged either.
//
// Pure (no D1) so it's regression-testable without a Workflow context — see
// verseMerge.ts / shrinkGuard.ts for the same pattern. The D1 read that
// reconstructs the ancestor is separate (foldTsvBase below is the pure half of
// it; bookReimport.ts does the batched edit_log read that feeds it).

import { normalizeNoteText } from "./tsvFormat.ts";

export type TsvMergeKind = "tn" | "tq" | "twl";

export type TsvMergeAction =
  | "keep_converged" // ours and theirs already equal (modulo whitespace)
  | "keep_no_base" // no ancestor recoverable — cannot attribute, keep D1
  | "keep_master_unchanged" // master === base on every field: their side never moved
  | "keep_ai_master" // >=1 field where BOTH moved, but no human moved master — D1 wins, human must review
  | "adopt" // master moved >=1 field, we moved none of those — adopt them
  | "adopt_conflict"; // >=1 field where BOTH moved — master wins, human must review

// The mergeable content fields. Which are relevant depends on kind (see
// FIELDS_BY_KIND). `occurrence` is numeric; the rest are text. Every value is
// nullable — a blank TSV cell parses to null.
export interface TsvMergeSide {
  quote?: string | null; // tn / tq (the Quote column)
  orig_words?: string | null; // twl (the OrigWords column)
  note?: string | null; // tn
  question?: string | null; // tq
  response?: string | null; // tq
  occurrence?: number | null; // tn / tq / twl
  support_reference?: string | null; // tn
  tags?: string | null; // tn / tq / twl
  tw_link?: string | null; // twl
}

export type TsvMergeField = keyof TsvMergeSide;

// SUBSTANTIVE content fields per kind, in a stable order. These are the columns
// this three-way merge owns. Deliberately EXCLUDED:
//   - tags, and whitespace-only note/question/response churn: owned by the
//     ancestor-free computeEditedFieldMerge (reimportClassify.ts), which has
//     kind-specific tags rules (tn/tq have no tags UI so master always wins;
//     twl does, so only a non-empty master tag is adopted). Keeping tags there
//     avoids duplicating that nuance and prevents two writers touching one row.
//   - sort_order: D1-owned (the reorder-preservation invariant + the twl
//     canonical post-pass). Adopting master file order here would re-introduce
//     the HOS reorder-revert bug.
//   - occurrence: the export's renderOccurrence (export.ts) SEMANTICALLY coerces
//     a Hebrew/Greek quote's occurrence null/0 -> 1 on the way to master, so D1
//     (null) and master (1) differ for thousands of rows that never actually
//     changed — "10,708 prod tn rows look offending in D1 but only one renders
//     offending" (STATE.md). Comparing D1's stored occurrence against master's
//     rendered occurrence here would mass-adopt 1 into every edited Hebrew-quote
//     row on the first sync (baking an export-time transform into D1). Occurrence
//     must be judged on the RENDERED TSV, not the stored row — out of scope for
//     this field-level merge, so it is left to D1 exactly as today. A genuine
//     occurrence-only master edit on an English quote is therefore not
//     auto-adopted (unchanged from pre-fix behavior) — a documented limitation.
//   - identity (id, ref/chapter/verse): never merged. A maintainer RE-ANCHORING
//     a row to a different Reference on master (same id, new ref/chapter/verse)
//     is NOT auto-adopted here — a validated move (re-anchoring the quote to the
//     new verse's source, handling the cross-chapter relocation) is a dedicated
//     follow-up. But it is NO LONGER silently reverted: the caller
//     (bookReimport.ts's edited-candidate resolution) detects the ref difference,
//     WITHHOLDS the resource watermark (apply_incomplete) so the export holds
//     instead of writing D1's old location over master, and flags the row for a
//     human to move it in-app. See the refMoved handling there.
const FIELDS_BY_KIND: Record<TsvMergeKind, TsvMergeField[]> = {
  tn: ["quote", "note", "support_reference"],
  tq: ["quote", "question", "response"],
  twl: ["orig_words", "tw_link"],
};

export function tsvMergeFields(kind: TsvMergeKind): TsvMergeField[] {
  return FIELDS_BY_KIND[kind];
}

// Did a Door43 maintainer re-anchor this row to a different Reference on master
// (same id, new chapter / verse / ref_raw)? Identity/reference columns are
// deliberately EXCLUDED from computeTsvMerge (see FIELDS_BY_KIND above), so a
// pure move is INVISIBLE to the field merge and would otherwise be silently
// reverted by the next export (D1's old location rendered back over master).
// This is the detector the caller (bookReimport.ts's edited-candidate
// resolution) uses to instead WITHHOLD the resource watermark (apply_incomplete)
// and flag the row (review_kind='ref_moved') for a human to move it in-app.
//
// A `protectedRow` (tn deleted/trashed/preserve/hint) is never treated as moved:
// such a row is left untouched from master regardless, so the caller keeps it a
// clean skipped_edited and this must return false so it does not withhold the
// watermark for a row it will not (and must not) touch.
//
// Pure (no D1) so the detection has a direct regression test independent of the
// DB-bound apply path — the field merge excludes identity columns, so nothing
// else guards against this class silently coming back.
export function tsvRefMoved(
  cur: Record<string, unknown>,
  incoming: { chapter: number; verse: number; refRaw: string | null },
  protectedRow: boolean,
): boolean {
  if (protectedRow) return false;
  const curRef = (cur.ref_raw as string | null) ?? "";
  return (
    Number(cur.chapter) !== incoming.chapter ||
    Number(cur.verse) !== incoming.verse ||
    curRef !== (incoming.refRaw ?? "")
  );
}

// ── Attributing the move (issue #540 item 3) ────────────────────────────────
//
// tsvRefMoved above is a TWO-WAY compare, and a two-way compare cannot say who
// moved — the same mistake that cost this project months of nightly data loss on
// the content side (STATE.md). Its caller assumed "differs => Door43 moved it",
// which is wrong exactly half the time, and the wrong half is self-perpetuating:
// a translator moves a row in the app, the sync reads the difference as a
// maintainer's move, flags the row telling her to undo her own edit, and sets
// apply_incomplete — which WITHHOLDS the resource watermark, so the export never
// ships her move to master, so master never catches up, so it flags again
// tomorrow. That livelock blocked AMO tq exports from 2026-08-17.
//
// The fix is the same one the content merge already uses: an ancestor. With the
// row's reference as of the master-confirmed watermark, the three cases separate
// cleanly and only two of them are anyone's problem.
export type TsvRefMoveOutcome =
  | "none" // references agree, or the row is protected
  | "ours_moved" // D1 moved, master still sits at the ancestor -> a normal exportable edit
  | "theirs_moved" // master moved, D1 still sits at the ancestor -> the out-of-band move
  | "both_moved" // both sides re-anchored, to different places -> needs a human
  | "unattributable"; // no ancestor for the components that differ -> cannot say who moved

// The reference columns as of the ancestor. A key is ABSENT when no surviving
// edit_log payload before the watermark ever recorded that column — the same
// "absent means unattributable" convention TsvMergeSide uses for content. This
// matters in practice: the in-app move sends `ref_raw` + `verse` and never
// `chapter` (moves are same-chapter only, rows.ts), so a base folded purely from
// patches legitimately carries no chapter.
export interface TsvRefSide {
  chapter?: number;
  verse?: number;
  /** "" when the payload recorded a null ref_raw, matching tsvRefMoved's coercion. */
  ref_raw?: string;
}

const REF_COMPONENTS = ["chapter", "verse", "ref_raw"] as const;

export function classifyTsvRefMove(
  cur: Record<string, unknown>,
  incoming: { chapter: number; verse: number; refRaw: string | null },
  base: TsvRefSide | null,
  protectedRow: boolean,
): TsvRefMoveOutcome {
  if (!tsvRefMoved(cur, incoming, protectedRow)) return "none";
  if (base === null) return "unattributable";

  const ours: Required<TsvRefSide> = {
    chapter: Number(cur.chapter),
    verse: Number(cur.verse),
    ref_raw: (cur.ref_raw as string | null) ?? "",
  };
  const theirs: Required<TsvRefSide> = {
    chapter: incoming.chapter,
    verse: incoming.verse,
    ref_raw: incoming.refRaw ?? "",
  };

  let oursMoved = false;
  let theirsMoved = false;
  for (const k of REF_COMPONENTS) {
    // A component both sides agree on carries no information about who moved,
    // so it never needs an ancestor — only the DIFFERING components do. That is
    // what keeps the common same-chapter move attributable from a patch-only
    // history that never recorded `chapter`.
    if (ours[k] === theirs[k]) continue;
    if (base[k] === undefined) return "unattributable";
    if (ours[k] !== base[k]) oursMoved = true;
    if (theirs[k] !== base[k]) theirsMoved = true;
  }
  if (oursMoved && theirsMoved) return "both_moved";
  if (oursMoved) return "ours_moved";
  if (theirsMoved) return "theirs_moved";
  // Unreachable: the sides differ on some component, so at least one of them
  // differs from the ancestor. Fail toward "nobody moved" rather than inventing
  // an attribution.
  return "none";
}

export interface TsvMergeResult {
  action: TsvMergeAction;
  /** there are fields to write — `writeFields` is non-empty. True for "adopt"
   *  and "adopt_conflict", and for a "keep_ai_master" row that ALSO had a
   *  cleanly-attributed field master moved on its own. */
  adopt: boolean;
  /** needs a human: "adopt_conflict" | "keep_ai_master" */
  conflict: boolean;
  /** short stable machine reason, safe to persist and to log */
  reason: string;
  /** raw master values to WRITE for the fields being adopted (verbatim theirs,
   *  NOT the normalized compare form). Empty when nothing is adopted. */
  writeFields: Partial<TsvMergeSide>;
  /** fields where BOTH sides moved. `action` says who won them: master on
   *  "adopt_conflict", D1 on "keep_ai_master". Empty otherwise. */
  conflictFields: TsvMergeField[];
}

// The export renders these fields — and ONLY these — through normalizeNoteText
// (export.ts:131 tn note, :138 tq question/response; quote, support_reference,
// orig_words, tw_link and the twl builder render raw). The compare lens below
// must mirror that set exactly: applying it to a raw-rendered column would make
// a genuine maintainer fix inside the normalization kernel (a stray literal \n
// on a quote, an ASCII-quote corruption repair) read as "unchanged", so it is
// never adopted and the raw-rendering export reverts it nightly.
const EXPORT_NORMALIZED_FIELDS: ReadonlySet<TsvMergeField> = new Set([
  "note",
  "question",
  "response",
]);

// Collapse a TSV text field to its compare form. For the prose fields the
// export normalizes, first apply the export's own normalizeNoteText (quote
// education, Alternate-translation label, literal-\n cleanups); then, for every
// text field, the literal two-char "\n" escape (an encoded line break) ->
// space, every whitespace run -> one space, then trim.
//
// The export lens is load-bearing for the prose fields: master IS
// normalizeNoteText(some past D1 value) for them, while the ancestor is folded
// from raw edit_log payloads. Without it, any note containing a straight
// apostrophe reads as "Door43 changed it" forever — educateQuotes curls it on
// every export, the ancestor keeps it straight, so ancestor != master by one
// character and every later app edit becomes a both-changed conflict that
// master wins (the AMO 3:10 nightly revert, 2026-08-18/19). Whitespace alone
// had the same shape: bp-assistant is known to double-space notes — see the
// tn-double-space-whitespace-churn memory. Applying the same lens to BOTH
// compared sides can only make values compare MORE equal, so it can suppress
// phantom moves but never manufacture one. FOR COMPARISON ONLY — the bytes we
// write are always master's raw value.
function normText(v: string | null | undefined, exportNormalized: boolean): string {
  const s = exportNormalized ? (normalizeNoteText(v ?? "") ?? "") : (v ?? "");
  return s.replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
}

// Numeric occurrence compare form. A blank cell (null) and an explicit 0 both
// mean "no occurrence" for these purposes, so they normalize together; any real
// occurrence compares by value.
function normOcc(v: number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

// Are two field values equal in their compare form?
function fieldEqual(field: TsvMergeField, a: unknown, b: unknown): boolean {
  if (field === "occurrence") return normOcc(a as number | null) === normOcc(b as number | null);
  const lens = EXPORT_NORMALIZED_FIELDS.has(field);
  return normText(a as string | null, lens) === normText(b as string | null, lens);
}

// Per-field attribution outcome.
type FieldFate = "converged" | "no_base" | "keep" | "adopt" | "conflict";

function attributeField(
  field: TsvMergeField,
  base: TsvMergeSide | null,
  ours: TsvMergeSide,
  theirs: TsvMergeSide,
): FieldFate {
  const o = ours[field];
  const t = theirs[field];
  if (fieldEqual(field, o, t)) return "converged"; // ours === theirs, nothing to do
  // A field the reconstructed ancestor never carried (edit history aged out
  // before this field was last set) is unattributable on its own — keep ours.
  // Distinct from an ancestor that carried it as an explicit null/blank.
  if (base === null || !(field in base)) return "no_base";
  const b = base[field];
  if (fieldEqual(field, t, b)) return "keep"; // master never moved this field -> our edit stands
  if (fieldEqual(field, o, b)) return "adopt"; // we never moved it, master did -> adopt
  return "conflict"; // both moved -> master wins, flag
}

// Three-way merge one edited TSV row. `base` is the reconstructed ancestor
// (foldTsvBase) or null when unrecoverable. `ours` is D1's current row, `theirs`
// is master's incoming row. Only content fields for `kind` are considered.
//
// `opts.masterMayHoldHumanEdit` is the AI-vs-human policy gate (#540 item 2),
// identical in meaning and in fail-safe direction to computeVerseMerge's field
// of the same name: FALSE only when a COMPLETE commit-lineage walk of master's
// file since the ancestor found nothing but our own export commits and
// bp-assistant pushes. Callers pass `masterMayHoldHumanEdit(lineage)` — the
// helper in masterLineage.ts — never a boolean of their own making. Omitted
// means the caller never looked, which keeps today's master-wins behavior.
export function computeTsvMerge(
  kind: TsvMergeKind,
  base: TsvMergeSide | null,
  ours: TsvMergeSide,
  theirs: TsvMergeSide,
  opts: { masterMayHoldHumanEdit?: boolean } = {},
): TsvMergeResult {
  const fields = FIELDS_BY_KIND[kind];
  const masterWinsConflicts = opts.masterMayHoldHumanEdit !== false;

  const writeFields: Partial<TsvMergeSide> = {};
  const conflictFields: TsvMergeField[] = [];
  let anyDiff = false; // some field differs (converged on all -> keep_converged)
  let anyNoBase = false; // some differing field could not be attributed
  let anyAttributable = false; // some differing field HAD a base to attribute against

  for (const f of fields) {
    const fate = attributeField(f, base, ours, theirs);
    if (fate === "converged") continue;
    anyDiff = true;
    if (fate === "no_base") {
      anyNoBase = true;
      continue; // keep ours for this field; can't attribute it
    }
    anyAttributable = true;
    if (fate === "keep") continue; // master didn't move it — our edit stands
    if (fate === "conflict") {
      conflictFields.push(f);
      // Both sides moved this field, and the lineage says nothing human moved
      // master's side — so master's value is our own pipeline's output and must
      // not overwrite the app edit that came after it (#540 item 2, the AMO 4:2
      // shape). Keep D1's value: write nothing for this field, and let the row
      // carry a review flag so a human still sees the collision.
      if (!masterWinsConflicts) continue;
    }
    // adopt, OR a conflict master is allowed to win: write master's RAW value.
    (writeFields as Record<string, unknown>)[f] = theirs[f] ?? null;
  }

  const noResult = (action: TsvMergeAction, reason: string): TsvMergeResult => ({
    action,
    adopt: false,
    conflict: false,
    reason,
    writeFields: {},
    conflictFields: [],
  });

  // Nothing differs at all (or only whitespace) -> converged.
  if (!anyDiff) return noResult("keep_converged", "converged");

  // Something differs but nothing could be attributed (whole-row ancestor
  // missing, or only aged-out fields differ). Keep D1 — the safe default — and
  // let the caller surface it (merge_no_base) so it isn't a silent revert.
  if (!anyAttributable) return noResult("keep_no_base", anyNoBase ? "no_base" : "master_unchanged");

  // A both-changed field D1 won because master's side had no human commit
  // behind it. Reported BEFORE the "nothing to write" branch below, which would
  // otherwise swallow it as a plain keep_master_unchanged and lose the flag — a
  // collision a human should see, whichever side won it. `adopt` stays honest:
  // a row can hold both a kept conflict and a field master moved on its own.
  if (!masterWinsConflicts && conflictFields.length > 0) {
    return {
      action: "keep_ai_master",
      adopt: Object.keys(writeFields).length > 0,
      conflict: true,
      reason: "both_changed_ai_master",
      writeFields,
      conflictFields,
    };
  }

  // Attributable, but every attributable field was "keep" (master never moved
  // the fields we could reason about). Note if some other field was no_base:
  // that residual still can't be adopted, so the row keeps D1, but it is
  // reported as no_base rather than a clean master_unchanged.
  if (Object.keys(writeFields).length === 0) {
    return noResult(anyNoBase ? "keep_no_base" : "keep_master_unchanged", anyNoBase ? "no_base" : "master_unchanged");
  }

  if (conflictFields.length > 0) {
    return { action: "adopt_conflict", adopt: true, conflict: true, reason: "both_changed", writeFields, conflictFields };
  }
  return { action: "adopt", adopt: true, conflict: false, reason: "master_only", writeFields, conflictFields: [] };
}

// ── Ancestor reconstruction (pure half) ─────────────────────────────────────
//
// The verse side recovers its ancestor from a SINGLE edit_log payload because
// every verse edit stores the whole verse. TSV is different: a human note edit
// stores only the CHANGED fields (rows.ts PATCH logs JSON.stringify(patch)),
// while a create stores the full row and a reimport/restore write stores the
// full row too. So the ancestor — the row's D1 state as of the master-confirmed
// watermark — is reconstructed by FOLDING the row's edit_log history (oldest to
// newest, created_at < cutoff): start empty, overlay each payload's present
// fields. The result is exactly the content the export rendered to master.
//
// Heterogeneous key names are the one hazard: reimport payloads use the
// ParsedTsvRow shape (orig_words / tw_link / support_reference), while a
// rows.ts patch/create uses the request/column shape (which may arrive
// camelCase). readPayloadField checks both spellings for each field so a fold
// over mixed history stays correct. Only fields actually PRESENT in a payload
// are overlaid, so a partial patch never wipes an unmentioned field.
//
// No source filter: this reconstructs what was IN D1 (hence what we published),
// regardless of who wrote it — an ai_pipeline or dcs_reimport write is a
// legitimate part of the published content, exactly as on the verse side.

// Actions whose edit_log payload carries row content worth folding. `reclaim`
// (issue #427 option 1) is a reissued tombstone overwritten wholesale with
// master's row — same "this is what D1 now actually holds" reasoning as
// `restore`, and it must be included: without it, a fold reaching past a
// reclaim would pick up the DEAD row's pre-reclaim history as the ancestor for
// a completely different logical row now occupying that (book, id) slot.
const CONTENT_ACTIONS = new Set(["create", "update", "restore", "reclaim"]);

// Read one canonical field from a heterogeneously-shaped payload, honoring both
// snake_case (DB/ParsedTsvRow) and camelCase (request body) spellings. Returns
// { present, value }: `present` is false when the payload does not mention the
// field at all (so the fold leaves any prior value intact).
function readPayloadField(
  payload: Record<string, unknown>,
  field: TsvMergeField,
): { present: boolean; value: unknown } {
  const alts: string[] =
    field === "orig_words"
      ? ["orig_words", "origWords"]
      : field === "support_reference"
        ? ["support_reference", "supportReference"]
        : field === "tw_link"
          ? ["tw_link", "twLink"]
          : [field];
  for (const key of alts) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return { present: true, value: payload[key] };
    }
  }
  return { present: false, value: undefined };
}

export interface TsvEditLogEntry {
  action: string;
  /** parsed edit_log.payload_json, or null when the row had none. */
  payload: Record<string, unknown> | null;
  /**
   * False when the edit_log row's `book` column is NULL, so we cannot prove the
   * entry belongs to THIS book's row of that id (ids are unique only per
   * (book, id)). Undefined means the caller did not report it, which keeps
   * every existing caller's behavior unchanged. Consumed only by
   * foldTsvRefBase — see the note there.
   */
  bookKnown?: boolean;
}

// Fold a row's content-bearing edit_log history (already ordered oldest->newest
// and already filtered to created_at < cutoff) into the ancestor field set for
// `kind`. Returns null when no content-bearing payload exists at all (nothing to
// attribute against -> caller keeps D1 as keep_no_base). A field the surviving
// history never set is simply absent from the returned object (computeTsvMerge
// treats an absent field as unattributable), which is how a partial, aged-out
// history degrades gracefully instead of pretending a blank ancestor.
// Fold the same history into the row's REFERENCE as of the watermark, for
// classifyTsvRefMove. Separate from foldTsvBase because the reference columns
// are deliberately excluded from FIELDS_BY_KIND (they are identity, not content,
// and must never be merged field-wise) — but they still need an ancestor to be
// attributable. Same entries, same ordering, same "absent means never recorded"
// contract; no extra D1 read.
//
// HETEROGENEOUS KEY NAMES, same hazard readPayloadField exists for above — and
// it bites harder here, because `ref_raw` is the one reference column whose two
// spellings are BOTH in production edit_log today:
//   - bookImport.ts's audit payload and rows.ts's POST/PATCH bodies use
//     snake_case `ref_raw`;
//   - bookReimport.ts logs a ParsedTsvRow verbatim (logEditStmt(..., u.row)),
//     and ParsedTsvRow's field is camelCase `refRaw`.
// Reading only one spelling would leave `ref_raw` absent from the ancestor of
// every row whose pre-watermark history came from a reimport, which silently
// degrades a ref_raw-only reshape (e.g. "1:2" -> "1:2-3", verse unchanged) to
// `unattributable` forever. That direction is fail-safe — an ABSENT component
// can only withhold, never mis-attribute — but it defeats the fix for that case,
// so both spellings are read.
//
// `chapter`/`verse` are spelled identically in every writer shape. They are
// numbers in all of them, so a non-numeric value is dropped rather than coerced
// into a NaN that would compare unequal to everything (including itself) and
// manufacture a permanent `unattributable`.
// A payload value that is a usable chapter/verse number. `Number()` alone is not
// enough: `Number(null)`, `Number("")`, `Number(false)` and `Number([])` are all
// a finite 0, and 0 is a REAL reference here (chapter-front `front:intro` rows
// live at chapter 0 / verse 0). Coercing an absent-ish value to 0 would turn a
// fail-safe absence into a fail-unsafe wrong ancestor, which is the one
// direction this fold must never go.
function refNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function foldTsvRefBase(entries: TsvEditLogEntry[]): TsvRefSide | null {
  let base: TsvRefSide | null = null;
  for (const e of entries) {
    if (!CONTENT_ACTIONS.has(e.action) || !e.payload) continue;
    // CROSS-BOOK POLLUTION. reconstructTsvBases matches `(book = ? OR book IS
    // NULL)`, and prod holds 7,689 tn/tq/twl edit_log rows with a NULL book
    // (migration 0017's backfill is best-effort: LIMIT 1 on an ambiguous id, and
    // rows whose owner no longer exists keep NULL). Row ids are unique only per
    // (book, id), so a NULL-book entry for id "ab12" can be GEN's history
    // folding into AMO's "ab12" ancestor. References are low-entropy — chapter 1
    // verse 2 is common — so a coincidental match is not far-fetched, and here it
    // would decide whether the export may overwrite master. An entry we cannot
    // prove belongs to this row is worth less than no entry at all, so it is
    // skipped. (foldTsvBase keeps the pre-existing behavior: a wrong content
    // ancestor mis-merges one field, it does not unblock an overwrite. Filed
    // separately rather than changed under this fix.)
    if (e.bookKnown === false) continue;
    const p = e.payload;
    for (const k of ["chapter", "verse"] as const) {
      if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
      const n = refNumber(p[k]);
      if (n === null) continue;
      base ??= {};
      base[k] = n;
    }
    // Later spelling wins within one payload only if a payload carried both,
    // which no writer does; across payloads the newest entry wins either way.
    //
    // ONLY A STRING COUNTS, and an explicit null is ABSENT, not "". Both matter:
    //   - `pipelineImport.ts`'s tn hint expansion writes
    //     `ref_raw = COALESCE(?5, ref_raw)` — a payload carrying an explicit
    //     `ref_raw: null` therefore leaves the row's reference UNCHANGED. Folding
    //     that null to "" would record an ancestor the row never held, and a
    //     wrong ancestor is the one thing this fold must never produce (see #546).
    //   - every real writer emits a string here (bookImport's `r["Reference"] ?? ""`,
    //     rows.ts's `z.string()`, ParsedTsvRow's `refRaw: string`), so anything
    //     else is a shape we have not seen and must not coerce — `String([...])`
    //     and `String({})` both yield confident nonsense.
    // Absence withholds (`unattributable`); that is the safe direction.
    for (const key of ["ref_raw", "refRaw"] as const) {
      if (!Object.prototype.hasOwnProperty.call(p, key)) continue;
      if (typeof p[key] !== "string") continue;
      base ??= {};
      base.ref_raw = p[key] as string;
    }
  }
  return base;
}

export function foldTsvBase(kind: TsvMergeKind, entries: TsvEditLogEntry[]): TsvMergeSide | null {
  const fields = FIELDS_BY_KIND[kind];
  let base: TsvMergeSide | null = null;
  for (const e of entries) {
    if (!CONTENT_ACTIONS.has(e.action) || !e.payload) continue;
    for (const f of fields) {
      const { present, value } = readPayloadField(e.payload, f);
      if (!present) continue;
      if (base === null) base = {};
      if (f === "occurrence") {
        (base as Record<string, unknown>)[f] =
          value == null || value === "" ? null : Number(value);
      } else {
        (base as Record<string, unknown>)[f] = value == null ? null : String(value);
      }
    }
  }
  return base;
}
