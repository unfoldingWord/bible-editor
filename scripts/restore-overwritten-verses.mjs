// Restore translator verse content that the pre-#548 sync wrongly overwrote
// with Door43's version (the 2026-08-13..19 adopt_conflict incident).
//
// Usage (from repo root; wrangler runs in api/):
//   node scripts/restore-overwritten-verses.mjs <restore-decisions.jsonl>            # dry run
//   node scripts/restore-overwritten-verses.mjs <restore-decisions.jsonl> --execute  # apply
//   ... --only JER,ZEC        restrict to books
//   ... --include KEY[,KEY]   add review-pile verses by BOOK/res/ch/vs (user-approved)
//
// What it does, per verse with action==='restore' in the decisions file:
//   1. PREFLIGHT (always): re-checks prod state — the verse's current version,
//      that the NEWEST edit_log entry is still the dcs_reimport overwrite (a
//      human edit since the sweep aborts that verse), that the overwritten
//      payload's $.content extracts non-null, and the translator's user id.
//   2. DRY RUN (default): writes a per-verse report and the SQL it would run.
//   3. EXECUTE: applies each verse as one 4-statement CAS batch, then VERIFIES
//      by re-query (version bumped, content length matches, conflict resolved).
//      wrangler has silently part-executed files before — never trust exit 0.
//
// Design constraints, all deliberate:
//   - Content NEVER passes through a shell: the UPDATE copies
//     json_extract(payload_json,'$.content') from edit_log by rowid, so every
//     statement is short ASCII. (Hebrew through Bash/PowerShell quoting has
//     corrupted data on this box before; BOM via redirect breaks D1.)
//   - CAS on `version = expected` mirrors verses.ts's PATCH: if a translator
//     saves between preflight and execute, the UPDATE matches 0 rows and the
//     chained changes()>0 guards keep the log INSERT and conflict-resolve from
//     firing — the verse is skipped, never half-written.
//   - Attribution: edit_log.user_id and verses.updated_by are the ORIGINAL
//     translator's id (Benjamin's ruling), with source='data_restoration' and
//     restored_from_version set, so the history dialog shows it exactly like
//     an in-app restore by that person.
//   - The conflict row is resolved in the same batch (same statement the PATCH
//     route uses), which is what clears the "Door43 overwrote your edits"
//     banner for that verse.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

function wranglerEntry() {
  const req = createRequire(path.join(API_DIR, "package.json"));
  return req.resolve("wrangler/bin/wrangler.js");
}

const args = process.argv.slice(2);
const decisionsPath = args.find((a) => !a.startsWith("--"));
const EXECUTE = args.includes("--execute");
const only = (args.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const include = new Set(
  (args.find((a) => a.startsWith("--include=")) ?? "").slice(10).split(",").filter(Boolean),
);
if (!decisionsPath) {
  console.error("usage: node scripts/restore-overwritten-verses.mjs <restore-decisions.jsonl> [--execute] [--only=JER,ZEC] [--include=BOOK/res/ch/vs,...]");
  process.exit(1);
}

const API_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "api");
const OUT_DIR = path.join(path.dirname(decisionsPath), "restore-run");
fs.mkdirSync(OUT_DIR, { recursive: true });

function d1(sqlRaw) {
  // --command, never --file: --file returns only a summary (no rows), and has
  // silently part-executed multi-statement files before.
  // Newlines collapsed: on win32 execFileSync(shell:true) routes the arg
  // through cmd, where an embedded newline truncates the command.
  const sql = sqlRaw.replace(/\s+/g, " ").trim();
  // Invoke wrangler's JS entry with the current node directly — a shell (npx via
  // cmd) re-tokenizes the SQL arg on spaces and destroys it. Resolved from the
  // api workspace so npm's hoisting (root node_modules) is honored.
  const wranglerJs = wranglerEntry();
  const out = execFileSync(
    process.execPath,
    [wranglerJs, "d1", "execute", "bible_editor", "--remote", "--env", "production", "--json", "--command", sql],
    { cwd: API_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const jsonStart = out.indexOf("[");
  const parsed = JSON.parse(out.slice(jsonStart));
  if (!parsed[0]?.success) throw new Error(`D1 reported failure: ${out.slice(0, 500)}`);
  return parsed[0].results ?? [];
}

const rowKey = (t) => `${t.book}/${t.chapter}/${t.verse}/${t.resource.toUpperCase()}`;
const shortKey = (t) => `${t.book}/${t.resource}/${t.chapter}/${t.verse}`;

// ── Load targets ─────────────────────────────────────────────────────────────
const decisions = fs.readFileSync(decisionsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const targets = decisions.filter(
  (d) => (d.action === "restore" || include.has(shortKey(d))) &&
    (only.length === 0 || only.includes(d.book)),
);
console.log(`${targets.length} restore target(s)${EXECUTE ? " — EXECUTE MODE" : " — dry run"}`);
if (targets.length === 0) process.exit(0);

// ── Translator ids ───────────────────────────────────────────────────────────
// overwrittenBy may carry an annotation like "deferredreward (data_repair ...)".
const usernames = [...new Set(targets.map((t) => String(t.overwrittenBy).split(" ")[0]))];
const userRows = d1(
  `SELECT id, dcs_username FROM users WHERE dcs_username IN (${usernames.map((u) => `'${u.replace(/'/g, "''")}'`).join(",")})`,
);
const userId = new Map(userRows.map((r) => [r.dcs_username, r.id]));
const missingUsers = usernames.filter((u) => !userId.has(u));
if (missingUsers.length) {
  console.error(`ABORT: no users row for: ${missingUsers.join(", ")}`);
  process.exit(1);
}

// ── Preflight, one query per verse kept simple and auditable ────────────────
const plans = [];
const skips = [];
for (const t of targets) {
  const rk = rowKey(t);
  const user = String(t.overwrittenBy).split(" ")[0];
  const rows = d1(
    `SELECT v.version AS cur_version,
            LENGTH(v.content_json) AS cur_len,
            (SELECT el.rowid FROM edit_log el WHERE el.kind='verse' AND el.row_key='${rk}'
              AND el.new_version=${t.overwrittenVersion}
              AND json_extract(el.payload_json,'$.content') IS NOT NULL
              ORDER BY el.new_version DESC, el.rowid DESC LIMIT 1) AS payload_rowid,
            (SELECT LENGTH(json_extract(el.payload_json,'$.content')) FROM edit_log el
              WHERE el.kind='verse' AND el.row_key='${rk}' AND el.new_version=${t.overwrittenVersion}
                AND json_extract(el.payload_json,'$.content') IS NOT NULL
              ORDER BY el.new_version DESC, el.rowid DESC LIMIT 1) AS payload_len,
            (SELECT json_extract(el.payload_json,'$.plain_text') FROM edit_log el
              WHERE el.kind='verse' AND el.row_key='${rk}' AND el.new_version=${t.overwrittenVersion}
                AND json_extract(el.payload_json,'$.content') IS NOT NULL
              ORDER BY el.new_version DESC, el.rowid DESC LIMIT 1) AS payload_plain,
            (SELECT COALESCE(el.source,'') FROM edit_log el
              WHERE el.kind='verse' AND el.row_key='${rk}' AND el.new_version IS NOT NULL
              ORDER BY el.new_version DESC LIMIT 1) AS newest_source,
            (SELECT json_extract(el.payload_json,'$.content') FROM edit_log el
              WHERE el.kind='verse' AND el.row_key='${rk}' AND el.new_version=${t.overwrittenVersion}
                AND json_extract(el.payload_json,'$.content') IS NOT NULL
              ORDER BY el.new_version DESC, el.rowid DESC LIMIT 1) = v.content_json AS already_identical
       FROM verses v
      WHERE v.book='${t.book}' AND v.chapter=${t.chapter} AND v.verse=${t.verse}
        AND v.bible_version='${t.resource.toUpperCase()}'`,
  );
  const r = rows[0];
  if (!r) { skips.push({ key: shortKey(t), why: "verse row not found" }); continue; }
  if (r.payload_rowid == null) { skips.push({ key: shortKey(t), why: `no payload with $.content at v${t.overwrittenVersion}` }); continue; }
  if (r.newest_source !== "dcs_reimport") {
    skips.push({ key: shortKey(t), why: `newest edit_log source is '${r.newest_source}' — someone edited since the sweep; NOT restoring over it` });
    continue;
  }
  if (r.already_identical === 1) {
    skips.push({ key: shortKey(t), why: "current content already identical to the overwritten version — resolve-only candidate" });
    continue;
  }
  plans.push({
    ...t, key: shortKey(t), rk, user, uid: userId.get(user),
    curVersion: r.cur_version, curLen: r.cur_len,
    payloadRowid: r.payload_rowid, payloadLen: r.payload_len,
    plainHasText: typeof r.payload_plain === "string" && r.payload_plain.length > 0,
  });
}

// ── Emit the per-verse SQL (ASCII only — content copied inside D1) ──────────
function sqlFor(p) {
  const res = p.resource.toLowerCase();
  return [
    `UPDATE verses SET content_json = (SELECT json_extract(payload_json,'$.content') FROM edit_log WHERE rowid=${p.payloadRowid}),` +
      ` plain_text = COALESCE((SELECT json_extract(payload_json,'$.plain_text') FROM edit_log WHERE rowid=${p.payloadRowid}), plain_text),` +
      ` version = ${p.curVersion + 1}, updated_by = ${p.uid}, updated_at = unixepoch()` +
      ` WHERE book='${p.book}' AND chapter=${p.chapter} AND verse=${p.verse} AND bible_version='${p.resource.toUpperCase()}' AND version = ${p.curVersion}`,
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, restored_from_version, payload_json)` +
      ` SELECT 'verse','${p.rk}','${p.book}',${p.uid},${p.curVersion},${p.curVersion + 1},'update','data_restoration',${p.overwrittenVersion},payload_json` +
      ` FROM edit_log WHERE rowid=${p.payloadRowid} AND changes() > 0`,
    `UPDATE verse_merge_conflicts SET resolved_at = unixepoch(), resolved_by = ${p.uid}` +
      ` WHERE book='${p.book}' AND resource='${res}' AND chapter=${p.chapter} AND verse=${p.verse} AND resolved_at IS NULL AND changes() > 0`,
  ].join(";\n");
}

const report = { mode: EXECUTE ? "execute" : "dry-run", at: new Date().toISOString(), plans: [], skips, results: [] };
for (const p of plans) {
  report.plans.push({
    key: p.key, translator: p.user, uid: p.uid,
    fromVersion: p.overwrittenVersion, curVersion: p.curVersion, newVersion: p.curVersion + 1,
    curLen: p.curLen, restoredLen: p.payloadLen, plainTextCarried: p.plainHasText,
  });
  fs.writeFileSync(path.join(OUT_DIR, `${p.key.replace(/\//g, "-")}.sql`), sqlFor(p) + ";\n");
}
console.log(`planned: ${plans.length}, skipped: ${skips.length}`);
for (const s of skips) console.log(`  SKIP ${s.key}: ${s.why}`);

// plain_text is a denormalized copy used for display fallback and for
// find/replace. When the restored payload carries none, the UPDATE's COALESCE
// keeps the row's EXISTING value — which is the overwritten (Door43) text sitting
// on top of restored (translator) content_json. Usually harmless, because the
// two sides of these conflicts differed in alignment rather than wording, but it
// is a real divergence and must not pass silently: the row's own verify only
// checks the version bump, so nothing else would surface it.
const noPlain = plans.filter((p) => !p.plainHasText);
if (noPlain.length) {
  console.warn(`\nWARNING: ${noPlain.length} verse(s) restore content with NO plain_text in the payload;`);
  console.warn(`their existing plain_text is kept and may not match the restored content:`);
  for (const p of noPlain) console.warn(`  ${p.key} (from v${p.overwrittenVersion})`);
  console.warn(`Verify these with scratchpad/check-plaintext.mjs after the run.\n`);
}

if (EXECUTE) {
  let ok = 0, failed = 0;
  for (const p of plans) {
    try {
      d1(sqlFor(p));
      // VERIFY by re-query — never trust exit code alone.
      const v = d1(
        `SELECT v.version, LENGTH(v.content_json) AS len,
                (SELECT COUNT(*) FROM verse_merge_conflicts c WHERE c.book='${p.book}' AND c.resource='${p.resource.toLowerCase()}'
                  AND c.chapter=${p.chapter} AND c.verse=${p.verse} AND c.resolved_at IS NULL) AS open_conflicts
           FROM verses v WHERE v.book='${p.book}' AND v.chapter=${p.chapter} AND v.verse=${p.verse}
            AND v.bible_version='${p.resource.toUpperCase()}'`,
      )[0];
      const good = v && v.version === p.curVersion + 1 && v.len === p.payloadLen && v.open_conflicts === 0;
      report.results.push({ key: p.key, verified: !!good, after: v });
      if (good) { ok++; console.log(`  OK ${p.key} -> v${v.version}`); }
      else { failed++; console.error(`  VERIFY FAILED ${p.key}: ${JSON.stringify(v)}`); }
    } catch (e) {
      failed++;
      report.results.push({ key: p.key, verified: false, error: String(e).slice(0, 300) });
      console.error(`  ERROR ${p.key}: ${e}`);
    }
  }
  console.log(`\nexecuted: ${ok} verified OK, ${failed} failed`);
}

const reportPath = path.join(OUT_DIR, `report-${EXECUTE ? "execute" : "dryrun"}-${Date.now()}.json`);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`report: ${reportPath}`);
