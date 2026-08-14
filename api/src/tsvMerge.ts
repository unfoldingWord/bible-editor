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
//   - BOTH moved the same field          -> master wins (the side a human just
//                                           touched by hand on Door43), and the
//                                           row is flagged for human review so
//                                           the overwritten D1 value can be
//                                           recovered from row version history.
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

export type TsvMergeKind = "tn" | "tq" | "twl";

export type TsvMergeAction =
  | "keep_converged" // ours and theirs already equal (modulo whitespace)
  | "keep_no_base" // no ancestor recoverable — cannot attribute, keep D1
  | "keep_master_unchanged" // master === base on every field: their side never moved
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
//   - identity (id, ref/chapter/verse): never merged. KNOWN LIMITATION (Codex
//     P1.4), PRE-EXISTING (the old computeEditedFieldMerge path never merged
//     these either, so this is not a regression): a maintainer RE-ANCHORING a
//     row to a different Reference on master (same id, new ref/chapter/verse) is
//     not adopted, so the export re-writes D1's old location and the move is
//     reverted. Auto-merging a location move is genuinely risky (a chapter change
//     moves the row out of the chapter this reimport is processing, and touches
//     sort_order/ordering), so it is deferred to a dedicated follow-up rather
//     than handled here — where the safe options are an explicit conflict flag or
//     a validated move, neither of which is a field-content merge.
const FIELDS_BY_KIND: Record<TsvMergeKind, TsvMergeField[]> = {
  tn: ["quote", "note", "support_reference"],
  tq: ["quote", "question", "response"],
  twl: ["orig_words", "tw_link"],
};

export function tsvMergeFields(kind: TsvMergeKind): TsvMergeField[] {
  return FIELDS_BY_KIND[kind];
}

export interface TsvMergeResult {
  action: TsvMergeAction;
  /** action is "adopt" | "adopt_conflict" */
  adopt: boolean;
  /** needs a human: "adopt_conflict" */
  conflict: boolean;
  /** short stable machine reason, safe to persist and to log */
  reason: string;
  /** raw master values to WRITE for the fields being adopted (verbatim theirs,
   *  NOT the normalized compare form). Empty when nothing is adopted. */
  writeFields: Partial<TsvMergeSide>;
  /** fields where both sides moved (master won). Empty unless adopt_conflict. */
  conflictFields: TsvMergeField[];
}

// Collapse a TSV text field to its whitespace-insensitive compare form: the
// literal two-char "\n" escape (an encoded line break) -> space, every
// whitespace run -> one space, then trim. Two values differing ONLY by this
// kind of incidental whitespace read as the same to a human, so they must not
// count as "moved" (bp-assistant is known to double-space notes — see the
// tn-double-space-whitespace-churn memory). FOR COMPARISON ONLY — the bytes we
// write are always master's raw value.
function normText(v: string | null | undefined): string {
  return (v ?? "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
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
  return normText(a as string | null) === normText(b as string | null);
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
export function computeTsvMerge(
  kind: TsvMergeKind,
  base: TsvMergeSide | null,
  ours: TsvMergeSide,
  theirs: TsvMergeSide,
): TsvMergeResult {
  const fields = FIELDS_BY_KIND[kind];

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
    // adopt OR conflict: write master's RAW value for this field.
    (writeFields as Record<string, unknown>)[f] = theirs[f] ?? null;
    if (fate === "conflict") conflictFields.push(f);
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

// Actions whose edit_log payload carries row content worth folding.
const CONTENT_ACTIONS = new Set(["create", "update", "restore"]);

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
}

// Fold a row's content-bearing edit_log history (already ordered oldest->newest
// and already filtered to created_at < cutoff) into the ancestor field set for
// `kind`. Returns null when no content-bearing payload exists at all (nothing to
// attribute against -> caller keeps D1 as keep_no_base). A field the surviving
// history never set is simply absent from the returned object (computeTsvMerge
// treats an absent field as unattributable), which is how a partial, aged-out
// history degrades gracefully instead of pretending a blank ancestor.
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
