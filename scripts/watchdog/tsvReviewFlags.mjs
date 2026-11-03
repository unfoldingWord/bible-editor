// Sync watchdog: open tn/tq/twl review flags (issue #1256). READ-ONLY.
//
// The nightly sync flags TSV rows directly (`<kind>_rows.review_kind`:
// merge_conflict, merge_no_base, ref_moved, ...; migrations 0031/0047/0057),
// separately from the verse_merge_conflicts rows collect.mjs already counts.
// collect.mjs runs tsvReviewFlagsSql once per kind through its read-only q()
// and hands the rows here. Nothing here is ever proposed for resolution.
//
// "Set tonight" needs the flag's MINT time, and a row's updated_at is not it:
// rows.ts's non-versioning fast paths (reorder drag, preserve/hint and trash
// toggles) move updated_at and leave review_kind standing (STATE.md). Mint
// evidence, in order:
//   1. review_master_json._meta.flag_at — written by every sync mint
//      (bookReimport.ts masterReviewSnapshot's `mint` argument). Before #1258
//      only merge_no_base wrote it, so an older merge_conflict / ref_moved flag
//      may lack it. A same-kind re-stamp keeps the first mint's flag_at, so it
//      is not "set tonight"; a re-stamp of a flag that had no flag_at records
//      the re-stamp time;
//   2. the sync's own edit_log write of the flag (source 'dcs_reimport',
//      action 'update' — the clears log as 'sync_clear_review' — with a
//      payload of changed fields carrying a non-null review_kind). merge_conflict
//      and ref_moved re-write the flag when their reason changes, so this is
//      "the sync last set this flag at", which may be a re-stamp of an older
//      flag with a new reason. tq/twl edit_log `update` rows are swept after
//      180 days (editLogSweep.ts), so for an old flag this can be absent.
// With neither, an updated_at since 05:30 UTC is reported only as "touched
// tonight with no mint time", never as "set tonight".
//
// A flag whose flag_at is before tonight but whose sync edit_log write is
// tonight is "re-stamped tonight": an old flag the sync re-wrote with a new
// reason (#1258). For merge_conflict that means tonight's sync merged a new
// Door43 edit over a different app value, so it is reported, but separately
// from "set tonight", because the flag itself is not new.
//
// Times are compared here in JS, not in SQL: if a column ever held ISO text,
// SQLite would sort it above every integer and `>= unixepoch(...)` would
// always be true.

export const TSV_KINDS = ["tn", "tq", "twl"];

// One narrow SELECT per kind. No ORDER BY: with one, the planner scans the
// table's primary-key index (~81k rows read for tn on 2026-11-03) instead of
// the partial idx_<kind>_rows_review_book index (65 rows). Rows are sorted in
// classifyTsvReviewFlags instead. The edit_log lookup is a correlated scalar
// subquery on edit_log_row_by_book (kind, book, row_key), so it cannot
// multiply rows; book is matched too because 4-character ids repeat across books.
// The unary + on e.action keeps that term out of index selection: without it
// the planner walks edit_log_kind_action_created (kind, action) instead and
// reads 26,577 rows for tn on 2026-11-03, against 65 this way.
export function tsvReviewFlagsSql(kind) {
  if (!TSV_KINDS.includes(kind)) throw new Error(`not a TSV kind: ${kind}`);
  return `SELECT t.book, t.id, t.review_kind, substr(t.review_reason, 1, 300) review_reason, t.version, t.updated_at,
            json_extract(t.review_master_json, '$._meta.flag_at') flag_at,
            (SELECT max(e.created_at) FROM edit_log e
              WHERE e.kind = '${kind}' AND e.book = t.book AND e.row_key = t.id AND e.source = 'dcs_reimport'
                AND +e.action = 'update'
                AND json_extract(e.payload_json, '$.review_kind') IS NOT NULL) mint_logged_at
       FROM ${kind}_rows t
      WHERE t.review_kind IS NOT NULL AND t.deleted_at IS NULL`;
}

// The collector's `since`, unixepoch('<day> 05:30:00'), as a number.
export function sinceEpoch(day) {
  return Date.parse(`${day}T05:30:00Z`) / 1000;
}

// Seconds since the epoch, or null for anything that is not a usable time.
// Numbers and numeric text are seconds. Other text is read as a date, and a
// zone-less 'YYYY-MM-DD HH:MM:SS' is UTC, as SQLite reads it. Empty text is
// null, never 0 (epoch 0 would be the most permissive answer there is).
export function toEpochSeconds(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "") return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

// rowsByKind: { tn: [...], tq: [...], twl: [...] } as tsvReviewFlagsSql
// returns them (a missing or null kind contributes nothing). Each row gets
// `tonight`: "set" (mint evidence at or after since), "restamped" (flag_at
// before since, sync edit_log write at or after since), "touched_no_mint" (no
// mint evidence, updated_at at or after since) or null.
export function classifyTsvReviewFlags(rowsByKind, since) {
  const out = [];
  for (const kind of TSV_KINDS) {
    for (const r of rowsByKind?.[kind] ?? []) {
      const flagAt = toEpochSeconds(r.flag_at);
      const mintLoggedAt = toEpochSeconds(r.mint_logged_at);
      const updatedAt = toEpochSeconds(r.updated_at);
      const [mintAt, mintSource] =
        flagAt != null ? [flagAt, "flag_at"] : mintLoggedAt != null ? [mintLoggedAt, "edit_log"] : [null, null];
      const tonight =
        mintAt != null
          ? mintAt >= since
            ? "set"
            : mintSource === "flag_at" && mintLoggedAt != null && mintLoggedAt >= since
              ? "restamped"
              : null
          : updatedAt != null && updatedAt >= since
            ? "touched_no_mint"
            : null;
      out.push({
        kind,
        book: r.book,
        id: r.id,
        reviewKind: r.review_kind,
        reviewReason: r.review_reason,
        version: r.version,
        updatedAt,
        flagAt,
        mintLoggedAt,
        mintAt,
        mintSource,
        tonight,
      });
    }
  }
  const key = (r) => [TSV_KINDS.indexOf(r.kind), String(r.book), String(r.id)];
  return out.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    return ka[0] - kb[0] || ka[1].localeCompare(kb[1]) || ka[2].localeCompare(kb[2]);
  });
}

const TONIGHT_MARK = { touched_no_mint: " (touched, no mint time)", restamped: " (re-stamped)" };

// The one summary.md line. Any failed kind makes the whole line unknown: a
// partial total would read as a clean count.
export function tsvReviewFlagsLine(rows, { failed = [] } = {}) {
  if (failed.length) return `- TSV review flags: unknown (query failed: ${failed.join(", ")})`;
  const set = rows.filter((r) => r.tonight === "set");
  const touched = rows.filter((r) => r.tonight === "touched_no_mint");
  const restamped = rows.filter((r) => r.tonight === "restamped");
  const byFlag = set.filter((r) => r.mintSource === "flag_at").length;
  const split = set.length ? `: ${byFlag} new by flag_at, ${set.length - byFlag} new or re-stamped by sync edit_log` : "";
  const perKind = TSV_KINDS.map((k) => `${k}=${rows.filter((r) => r.kind === k).length}`).join(", ");
  const tonight = rows.filter((r) => r.tonight != null);
  const shown = tonight
    .slice(0, 20)
    .map((r) => `${r.kind} ${r.book} ${r.id} ${r.reviewKind}${TONIGHT_MARK[r.tonight] ?? ""}`);
  const list = tonight.length ? `; tonight: ${shown.join(", ")}${tonight.length > 20 ? ", …" : ""}` : "";
  return (
    `- TSV review flags: ${rows.length} open (${set.length} set tonight${split}; ` +
    `${touched.length} more touched tonight with no mint time; ` +
    `${restamped.length} re-stamped tonight (old flag, new reason)); ${perKind}${list}`
  );
}
