// Restore tn/tq/twl fields the pre-#548 sync wrongly overwrote (the TSV side of
// the 2026-08 adopt/stale-master incident; verse side: restore-overwritten-verses.mjs).
//
// Usage (repo root):
//   node scripts/restore-overwritten-tsv.mjs <sweep-tsv.jsonl>              # dry run
//   node scripts/restore-overwritten-tsv.mjs <sweep-tsv.jsonl> --execute
//   ... --exclude-ids <file>   newline list of "BOOK/kind/rowId" to skip (rows a
//                              cleanup is about to delete — e.g. ECC ch1 June set)
//
// Per row with verdict LOST_* and humanRefixedAfter=false and deleted=false:
//   1. PREFLIGHT: current version must equal the sweep's currentVersion AND the
//      newest edit_log entry must still be the dcs_reimport write — any human
//      activity since the sweep skips the row (never restore over a person).
//   2. For each field the reimport changed (contentFieldChanged), find the last
//      edit_log payload at or before the overwritten human version that CARRIES
//      that field (payloads are partial PATCH bodies — the field's effective
//      value can live several versions back). json_type() distinguishes an
//      absent key from an explicit null; both key spellings (ref_raw/refRaw
//      style) are read, snake_case first.
//   3. EXECUTE: one CAS batch per row — field UPDATE (values copied inside D1
//      from edit_log by rowid; content never passes through a shell), then a
//      changes()-gated edit_log 'update' with restored_from_version, attributed
//      to the ORIGINAL author. Verified by re-query.
//
// Reference fields (chapter/verse/ref_raw) are NOT restored by this script even
// if listed — a ref move interacts with the #543 attribution logic and is a
// hand decision. They are reported and skipped.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
const sweepPath = args.find((a) => !a.startsWith("--"));
const EXECUTE = args.includes("--execute");
const exclArg = args.find((a) => a.startsWith("--exclude-ids="));
const excluded = new Set(
  exclArg ? fs.readFileSync(exclArg.slice(14), "utf8").trim().split(/\r?\n/).filter(Boolean) : [],
);
if (!sweepPath) {
  console.error("usage: node scripts/restore-overwritten-tsv.mjs <sweep-tsv.jsonl> [--execute] [--exclude-ids=<file>]");
  process.exit(1);
}

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

const KIND_TABLE = { tn: "tn_rows", tq: "tq_rows", twl: "twl_rows" };
// Column -> payload key spellings, snake_case (rows.ts bodies) first, then the
// camelCase a reimport logs (ParsedTsvRow verbatim). Reference columns excluded.
const FIELD_KEYS = {
  note: ["note"], question: ["question"], response: ["response"],
  quote: ["quote"], occurrence: ["occurrence"], tags: ["tags"],
  support_reference: ["support_reference", "supportReference"],
  orig_words: ["orig_words", "origWords"], twl_link: ["twl_link", "twLink"],
};
const REF_FIELDS = new Set(["chapter", "verse", "ref_raw", "refRaw", "reference"]);

const rows = fs.readFileSync(sweepPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const targets = rows.filter((r) =>
  /^LOST_/.test(r.verdict) && r.humanRefixedAfter !== true && r.deleted !== true &&
  r.payloadPresent === true && !excluded.has(`${r.book}/${r.kind}/${r.rowId}`));
console.log(`${targets.length} TSV restore target(s)${EXECUTE ? " — EXECUTE MODE" : " — dry run"}; ${excluded.size} exclusions loaded`);

const users = new Map(d1(`SELECT id, dcs_username FROM users`).map((u) => [u.dcs_username, u.id]));

const OUT_DIR = path.join(path.dirname(sweepPath), "tsv-restore-run");
fs.mkdirSync(OUT_DIR, { recursive: true });
const report = { mode: EXECUTE ? "execute" : "dry-run", at: new Date().toISOString(), plans: [], skips: [], results: [] };

for (const t of targets) {
  const key = `${t.book}/${t.kind}/${t.rowId}`;
  const uid = users.get(String(t.overwrittenBy).split(" ")[0]);
  if (!uid) { report.skips.push({ key, why: `no users row for ${t.overwrittenBy}` }); continue; }
  const fields = (Array.isArray(t.contentFieldChanged) ? t.contentFieldChanged : String(t.contentFieldChanged ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const restorable = fields.filter((f) => FIELD_KEYS[f]);
  const refFields = fields.filter((f) => REF_FIELDS.has(f));
  if (restorable.length === 0) { report.skips.push({ key, why: `no restorable fields in [${fields}]` , refFields }); continue; }

  // Preflight + per-field source rowid resolution in ONE query per row.
  const fieldSel = restorable.map((f, i) => {
    const alts = FIELD_KEYS[f].map((k) =>
      `SELECT el.rowid AS rid, '${k}' AS pkey FROM edit_log el WHERE el.kind='${t.kind}' AND el.row_key='${t.rowId}'
        AND (el.book='${t.book}' OR el.book IS NULL) AND el.new_version <= ${t.overwrittenVersion}
        AND json_type(el.payload_json,'$.${k}') IS NOT NULL ORDER BY el.new_version DESC, el.rowid DESC LIMIT 1`);
    return `(SELECT rid || '|' || pkey FROM (${alts.join(" UNION ALL ")}) LIMIT 1) AS f${i}`;
  }).join(", ");
  const pre = d1(
    `SELECT r.version AS cur, r.deleted_at AS del,
            (SELECT COALESCE(el.source,'') FROM edit_log el WHERE el.kind='${t.kind}' AND el.row_key='${t.rowId}'
              AND (el.book='${t.book}' OR el.book IS NULL) AND el.new_version IS NOT NULL
              ORDER BY el.new_version DESC, el.rowid DESC LIMIT 1) AS newest_source,
            ${fieldSel}
       FROM ${KIND_TABLE[t.kind]} r WHERE r.id='${t.rowId}' AND r.book='${t.book}'`,
  )[0];
  if (!pre) { report.skips.push({ key, why: "row not found" }); continue; }
  if (pre.del != null) { report.skips.push({ key, why: "row is deleted" }); continue; }
  if (pre.newest_source !== "dcs_reimport") { report.skips.push({ key, why: `newest source '${pre.newest_source}' — edited since sweep` }); continue; }
  if (pre.cur !== t.currentVersion) { report.skips.push({ key, why: `version moved ${t.currentVersion} -> ${pre.cur}` }); continue; }

  const sets = [];
  const missing = [];
  restorable.forEach((f, i) => {
    const v = pre[`f${i}`];
    if (!v) { missing.push(f); return; }
    const [rid, pkey] = String(v).split("|");
    sets.push(`${f} = json_extract((SELECT payload_json FROM edit_log WHERE rowid=${rid}), '$.${pkey}')`);
  });
  if (sets.length === 0) { report.skips.push({ key, why: `no payload carries [${missing}]` }); continue; }

  const sql =
    `UPDATE ${KIND_TABLE[t.kind]} SET ${sets.join(", ")}, version = ${pre.cur + 1}, updated_by = ${uid}, updated_at = unixepoch()` +
    ` WHERE id='${t.rowId}' AND book='${t.book}' AND version = ${pre.cur} AND deleted_at IS NULL;` +
    ` INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, restored_from_version, payload_json)` +
    ` SELECT '${t.kind}','${t.rowId}','${t.book}',${uid},${pre.cur},${pre.cur + 1},'update','data_restoration',${t.overwrittenVersion},` +
    ` (SELECT json_object(${restorable.filter((_, i) => pre[`f${i}`]).map((f) => `'${f}', ${KIND_TABLE[t.kind]}.${f}`).join(", ")}) FROM ${KIND_TABLE[t.kind]} WHERE id='${t.rowId}' AND book='${t.book}')` +
    ` WHERE changes() > 0`;

  report.plans.push({ key, ref: `${t.book} ${t.chapter}:${t.verse}`, author: t.overwrittenBy, uid, fields: sets.length, missing, refFieldsSkipped: refFields, from: t.overwrittenVersion, cur: pre.cur, sql: EXECUTE ? undefined : sql });

  if (EXECUTE) {
    try {
      d1(sql);
      const v = d1(`SELECT version FROM ${KIND_TABLE[t.kind]} WHERE id='${t.rowId}' AND book='${t.book}'`)[0];
      const ok = v && v.version === pre.cur + 1;
      report.results.push({ key, verified: !!ok });
      console.log(ok ? `  OK ${key} -> v${v.version}` : `  VERIFY FAILED ${key}`);
    } catch (e) {
      report.results.push({ key, verified: false, error: String(e).slice(0, 300) });
      console.error(`  ERROR ${key}: ${e}`);
    }
  }
}

console.log(`planned: ${report.plans.length}, skipped: ${report.skips.length}`);
for (const s of report.skips) console.log(`  SKIP ${s.key}: ${s.why}`);
const rp = path.join(OUT_DIR, `report-${EXECUTE ? "execute" : "dryrun"}-${Date.now()}.json`);
fs.writeFileSync(rp, JSON.stringify(report, null, 2));
console.log(`report: ${rp}`);
