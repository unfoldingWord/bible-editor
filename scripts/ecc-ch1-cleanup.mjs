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
// Soft-delete only, mirroring rows.ts's DELETE route exactly: deleted_at stamp,
// version bump, changes()-gated edit_log 'delete' row — so the trash view,
// version history, and reimport tombstone logic all see an ordinary in-app
// trash, attributed to Benjamin. Rows Carolyn already trashed by hand are
// skipped naturally (deleted_at IS NULL guard).
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
  if (!parsed[0]?.success) throw new Error(`D1 failure: ${out.slice(0, 400)}`);
  return parsed[0].results ?? [];
}

const BENJAMIN_UID = 2; // users.dcs_username = 'deferredreward'
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
let live = 0, gone = 0, missing = 0;
const targets = [];
for (const id of ids) {
  const r = found.get(id);
  if (!r) { missing++; console.log(`  MISSING ${id}`); continue; }
  if (r.deleted_at != null) { gone++; continue; } // Carolyn already trashed it
  if (r.verse == null || r.verse < 0) { console.log(`  ODD ${id} verse=${r.verse}`); }
  live++;
  targets.push(r);
}
console.log(`live to delete: ${live}, already deleted: ${gone}, missing: ${missing}`);

if (EXECUTE) {
  let ok = 0, failed = 0;
  for (const r of targets) {
    const sql =
      `UPDATE tn_rows SET deleted_at = unixepoch(), version = version + 1, updated_at = unixepoch(), updated_by = ${BENJAMIN_UID}` +
      ` WHERE id='${r.id}' AND book='ECC' AND version = ${r.version} AND deleted_at IS NULL;` +
      ` INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)` +
      ` SELECT 'tn','${r.id}','ECC',${BENJAMIN_UID},${r.version},${r.version + 1},'delete','data_restoration' WHERE changes() > 0`;
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
