// Tests for scripts/watchdog/tsvReviewFlags.mjs (issue #1256): the sync
// watchdog's count of open tn/tq/twl review flags (`<kind>_rows.review_kind`)
// and which of them tonight's sync set. No D1, no network: every fixture is
// inline. Lives under api/src so scripts/run-tests.mjs finds it
// (`cd api && npm test`). Run alone from api/:
//   node --no-warnings src/watchdogTsvReviewFlags.test.mjs

import {
  TSV_KINDS,
  classifyTsvReviewFlags,
  sinceEpoch,
  toEpochSeconds,
  tsvReviewFlagsLine,
  tsvReviewFlagsSql,
} from "../../scripts/watchdog/tsvReviewFlags.mjs";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// --- time handling ------------------------------------------------------
// unixepoch('2026-11-03 05:30:00') in SQLite.
const SINCE = 1793683800;
assert(sinceEpoch("2026-11-03") === SINCE, "sinceEpoch matches SQLite unixepoch('<day> 05:30:00')");
assert(toEpochSeconds(1793684320) === 1793684320, "integer seconds pass through");
assert(toEpochSeconds("1793684320") === 1793684320, "numeric text is read as seconds");
// SQLite reads a zone-less 'YYYY-MM-DD HH:MM:SS' as UTC; so must we.
assert(toEpochSeconds("2026-11-03 05:40:00") === SINCE + 600, "zone-less ISO text is read as UTC");
assert(toEpochSeconds("2026-11-03T05:00:00Z") === SINCE - 1800, "ISO text with Z is read as UTC");
assert(toEpochSeconds(null) === null, "null is no time");
assert(toEpochSeconds("") === null, "empty text is no time (not epoch 0)");
assert(toEpochSeconds("garbage") === null, "unparseable text is no time");

// --- classification -----------------------------------------------------
const row = (over) => ({
  book: "EZK",
  id: "aaaa",
  review_kind: "merge_conflict",
  review_reason: "why",
  version: 4,
  updated_at: SINCE - 86400,
  flag_at: null,
  mint_logged_at: null,
  ...over,
});
const rows = classifyTsvReviewFlags(
  {
    tn: [
      // Minted tonight, mint time in review_master_json._meta.flag_at.
      row({ id: "mint", review_kind: "merge_no_base", flag_at: SINCE + 520, mint_logged_at: SINCE + 521, updated_at: SINCE + 520 }),
      // Old flag on a row a reorder drag / toggle touched tonight: updated_at
      // moved, the flag did not. NOT set tonight, and NOT "no mint time" either.
      row({ id: "oldf", review_kind: "merge_no_base", flag_at: SINCE - 86400 * 40, updated_at: SINCE + 100 }),
      // No flag_at (merge_conflict / ref_moved never write one); the sync's own
      // edit_log write of the flag is tonight.
      row({ id: "logd", mint_logged_at: SINCE + 900, updated_at: SINCE + 898 }),
      // No flag_at, edit_log write is old, row touched tonight: not set tonight.
      row({ id: "oldl", mint_logged_at: SINCE - 86400, updated_at: SINCE + 50 }),
      // No mint evidence at all, row touched tonight: touched, never "set".
      row({ id: "nomt", updated_at: SINCE + 60 }),
      // Untouched old flag.
      row({ id: "cold", flag_at: SINCE - 5, updated_at: SINCE - 5 }),
    ],
    tq: [
      // ISO text before tonight. As raw SQLite `>= unixepoch(...)` this would
      // count (text sorts above integers); here it must not.
      row({ book: "HOS", id: "isob", review_kind: "ref_moved", updated_at: "2026-11-02 22:00:00" }),
      // ISO text after tonight, no mint evidence: touched.
      row({ book: "HOS", id: "isoa", review_kind: "ref_moved", updated_at: "2026-11-03 06:00:00" }),
    ],
    twl: [],
  },
  SINCE,
);
const by = Object.fromEntries(rows.map((r) => [r.id, r]));
assert(rows.length === 8, "every flag row is kept");
assert(by.mint.tonight === "set" && by.mint.mintSource === "flag_at" && by.mint.mintAt === SINCE + 520, "flag_at tonight → set (by flag_at)");
assert(by.oldf.tonight === null, "old flag_at + updated_at tonight → NOT set tonight, NOT touched-no-mint");
assert(by.logd.tonight === "set" && by.logd.mintSource === "edit_log" && by.logd.mintAt === SINCE + 900, "no flag_at, edit_log tonight → set (by edit_log)");
assert(by.oldl.tonight === null, "old edit_log mint + updated_at tonight → not tonight");
assert(by.nomt.tonight === "touched_no_mint" && by.nomt.mintAt === null && by.nomt.mintSource === null, "no mint evidence + updated_at tonight → touched, not set");
assert(by.cold.tonight === null, "old untouched flag → not tonight");
assert(by.isob.tonight === null, "ISO updated_at before tonight is not tonight (no text-vs-integer compare)");
assert(by.isoa.tonight === "touched_no_mint" && by.isoa.updatedAt === SINCE + 1800, "ISO updated_at after tonight → touched, converted to seconds");
assert(
  by.mint.kind === "tn" && by.mint.book === "EZK" && by.mint.reviewKind === "merge_no_base" && by.mint.version === 4 && by.mint.reviewReason === "why",
  "row carries kind, book, review kind, reason, version",
);
assert(rows.map((r) => `${r.kind}/${r.book}/${r.id}`).join(",") ===
  "tn/EZK/cold,tn/EZK/logd,tn/EZK/mint,tn/EZK/nomt,tn/EZK/oldf,tn/EZK/oldl,tq/HOS/isoa,tq/HOS/isob",
  "rows sorted by kind, book, id");

// --- summary line -------------------------------------------------------
assert(
  tsvReviewFlagsLine(rows, { failed: [] }) ===
    "- TSV review flags: 8 open (2 set tonight: 1 new by flag_at, 1 new or re-stamped by sync edit_log; 2 more touched tonight with no mint time); " +
      "tn=6, tq=2, twl=0; tonight: tn EZK logd merge_conflict, tn EZK mint merge_no_base, " +
      "tn EZK nomt merge_conflict (touched, no mint time), tq HOS isoa ref_moved (touched, no mint time)",
  "summary line: totals, split by evidence, per kind, tonight's rows",
);
assert(
  tsvReviewFlagsLine([], { failed: [] }) === "- TSV review flags: 0 open (0 set tonight; 0 more touched tonight with no mint time); tn=0, tq=0, twl=0",
  "summary line with no flags",
);
assert(
  tsvReviewFlagsLine(rows, { failed: ["tq"] }) === "- TSV review flags: unknown (query failed: tq)",
  "any failed kind → unknown, never a partial total",
);
const many = classifyTsvReviewFlags(
  { tn: Array.from({ length: 22 }, (_, i) => row({ id: `r${String(i).padStart(2, "0")}`, mint_logged_at: SINCE + 1 })), tq: [], twl: [] },
  SINCE,
);
const manyLine = tsvReviewFlagsLine(many, { failed: [] });
assert(manyLine.includes("tn EZK r19 merge_conflict, …") && !manyLine.includes("r20"), "tonight list capped at 20 with an ellipsis");

// --- SQL ----------------------------------------------------------------
assert(TSV_KINDS.join(",") === "tn,tq,twl", "three TSV kinds");
for (const k of TSV_KINDS) {
  const sql = tsvReviewFlagsSql(k);
  assert(sql.includes(`FROM ${k}_rows t`) && sql.includes(`e.kind = '${k}'`), `${k}: queries its own table and edit_log kind`);
  assert(sql.includes("e.source = 'dcs_reimport'") && sql.includes("+e.action = 'update'"), `${k}: mint evidence is the sync's update write, not its sync_clear_review audit row (unary + keeps the edit_log_row_by_book plan)`);
  assert(/review_kind IS NOT NULL AND t\.deleted_at IS NULL/.test(sql), `${k}: open, live flags only`);
  assert(!/ORDER BY/i.test(sql), `${k}: no ORDER BY (it would scan the PK index instead of the partial review index)`);
  assert(/substr\(t\.review_reason,\s*1,\s*\d+\)/.test(sql), `${k}: reason is clipped`);
}
let threw = false;
try {
  tsvReviewFlagsSql("verses; DROP TABLE x");
} catch {
  threw = true;
}
assert(threw, "unknown kind is refused (no SQL interpolation of arbitrary text)");

console.log("watchdogTsvReviewFlags: all passed");
