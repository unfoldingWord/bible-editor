// ECC chapter 1 tn de-duplication (Benjamin's D1 ruling, 2026-08-20): the
// 2026-08-18 bt-bot apply replaced master's chapter 1 notes but deleted only 20
// of bcameron93's ~73 prior D1 rows, leaving two full note sets live. Ruling:
// keep the bot's August set, soft-delete bcameron93's June set. A scan for
// "clearly human notes-to-self" worth keeping found none — the June set is
// formal tn notes plus 7 blank stubs (empty note, quote only).
//
// Usage: node scripts/ecc-ch1-cleanup.mjs <june-ids.txt> [--execute]
//   june-ids.txt: newline list of the June-set row ids (from the sweep's
//   ecc-dup-detail.json .botside — that file's side naming is flipped).
//
// Soft-delete only, mirroring rows.ts's DELETE route (rows.ts:935): deleted_at
// stamp, version bump, changes()-gated edit_log 'delete' row — so version history
// and the reimport tombstone logic see an ordinary in-app delete, attributed to
// the operator. Nothing is hard-deleted: every row and its whole history stays in
// the database and any note can be put back.
//
// NOT the tn TRASH, and the difference matters. tn_rows has BOTH `trashed_at`
// (rows.ts's setTnTrashed — the recoverable bin the trash view lists) and
// `deleted_at` (the DELETE route). This writes `deleted_at`, so these rows do not
// appear in the app's trash view and cannot be restored by a click; recovery is a
// D1 operation. That is the right level for a decided, bulk cleanup — a 53-row
// trash would bury whatever a translator actually trashed themselves — but it
// must not be described as something a person can undo in the UI.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
const idsPath = args.find((a) => !a.startsWith("--"));
const EXECUTE = args.includes("--execute");
if (!idsPath) { console.error("usage: node scripts/ecc-ch1-cleanup.mjs <june-ids.txt> [--execute]"); process.exit(1); }

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const API_DIR = path.join(REPO, "api");
function d1(sqlRaw) {
  const sql = sqlRaw.replace(/\s+/g, " ").trim();
  const req = createRequire(path.join(API_DIR, "package.json"));
  const out = execFileSync(process.execPath,
    [req.resolve("wrangler/bin/wrangler.js"), "d1", "execute", "bible_editor", "--remote", "--env", "production", "--json", "--command", sql],
    { cwd: API_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  // EVERY statement, not just the first: a multi-statement --command returns one
  // result object per statement, so a failure in statement 2 (the audit INSERT)
  // is invisible if only parsed[0] is checked.
  if (!parsed.length || parsed.some((p) => p && p.success === false))
    throw new Error(`D1 failure: ${out.slice(0, 400)}`);
  return parsed[0].results ?? [];
}

// Resolved from D1, never hardcoded. The two restore scripts already look the
// operator up and abort on a miss; asserting an id from a comment would
// misattribute every tombstone/resolution with no error if it were ever wrong
// (and resolved_by REFERENCES users(id), so a bad id only fails when FK
// enforcement happens to be on).
const OPERATOR = process.env.REPAIR_OPERATOR ?? "deferredreward";
const OPERATOR_UID = (() => {
  const r = d1(`SELECT id FROM users WHERE dcs_username = '${OPERATOR.replace(/'/g, "''")}'`)[0];
  if (!r) { console.error(`ABORT: no users row for '${OPERATOR}'`); process.exit(1); }
  return r.id;
})();
const ids = fs.readFileSync(idsPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
console.log(`${ids.length} June-set ids${EXECUTE ? " — EXECUTE MODE" : " — dry run"}`);

// Preflight: confirm every id is a live ECC ch1 tn row authored in the June era,
// and never delete a row that carries a later human edit.
const inList = ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(",");
const rows = d1(
  `SELECT r.id, r.verse, r.version, r.deleted_at,
          (SELECT COALESCE(el.source, '') FROM edit_log el WHERE el.kind='tn' AND el.row_key=r.id
            AND (el.book='ECC' OR el.book IS NULL) AND el.new_version IS NOT NULL
            ORDER BY el.new_version DESC, el.rowid DESC LIMIT 1) AS newest_source
     FROM tn_rows r WHERE r.book='ECC' AND r.id IN (${inList})`,
);
const found = new Map(rows.map((r) => [r.id, r]));
let live = 0, gone = 0, missing = 0, human = 0;
const targets = [];
for (const id of ids) {
  const r = found.get(id);
  if (!r) { missing++; console.log(`  MISSING ${id}`); continue; }
  if (r.deleted_at != null) { gone++; continue; } // already removed by hand
  // THE GUARD THIS SCRIPT ADVERTISES, now actually applied. `newest_source` was
  // being selected and never read — a vacuous guard in a destructive script. On a
  // re-run after a translator has edited one of these notes, the old code would
  // have soft-deleted their fresh work silently. A human's own write (source
  // NULL) or a repair means the row is no longer just "the losing side of a
  // duplicate pair", so it is left alone and reported.
  // `data_restoration` belongs in this list as much as the other two, and its
  // absence was a live hazard rather than a theoretical one: the TSV restore run
  // on 2026-08-20 wrote 69 ECC tag restores under exactly that source. A re-run
  // of this script would have read those as ordinary machine writes and deleted
  // the restored row. Any source that means "a person decided this" protects the
  // row; only a plain machine write (dcs_reimport, ai_pipeline) leaves it
  // eligible.
  const HUMAN_DECIDED = new Set(["", "data_repair", "data_restoration"]);
  if (HUMAN_DECIDED.has(r.newest_source)) {
    human++;
    console.log(`  SKIP ${id}: newest edit is a human/repair write (source='${r.newest_source || "null"}') — not deleting`);
    continue;
  }
  if (r.verse == null || r.verse < 0) { console.log(`  ODD ${id} verse=${r.verse}`); }
  live++;
  targets.push(r);
}
console.log(`live to delete: ${live}, already deleted: ${gone}, missing: ${missing}, skipped (human edit since): ${human}`);

if (EXECUTE) {
  let ok = 0, failed = 0;
  for (const r of targets) {
    const sql =
      `UPDATE tn_rows SET deleted_at = unixepoch(), version = version + 1, updated_at = unixepoch(), updated_by = ${OPERATOR_UID}` +
      ` WHERE id='${r.id}' AND book='ECC' AND version = ${r.version} AND deleted_at IS NULL;` +
      ` INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)` +
      ` SELECT 'tn','${r.id}','ECC',${OPERATOR_UID},${r.version},${r.version + 1},'delete','data_restoration' WHERE changes() > 0`;
    try {
      d1(sql);
      const v = d1(`SELECT deleted_at FROM tn_rows WHERE id='${r.id}' AND book='ECC'`)[0];
      if (v && v.deleted_at != null) { ok++; }
      else { failed++; console.error(`  VERIFY FAILED ${r.id}`); }
    } catch (e) { failed++; console.error(`  ERROR ${r.id}: ${String(e).slice(0, 200)}`); }
  }
  console.log(`deleted+verified: ${ok}, failed: ${failed}`);
  const after = d1(`SELECT COUNT(*) AS n FROM tn_rows WHERE book='ECC' AND chapter=1 AND deleted_at IS NULL`)[0];
  console.log(`ECC ch1 live rows now: ${after.n}`);
}
