// Repair the ISA "front:intro" TSV-paste corruption in prod D1 tn_rows.
//
// WHAT HAPPENED
//   Two ISA tn_rows chapter-0 rows are damaged:
//     ee2w  ref_raw "0:1"           chapter 0  verse 1  (an illegal stub —
//                                   chapter 0 has no verses; see the
//                                   REFERENCE_RE tightening in lint.ts)
//     l9fr  ref_raw "front:intro"   chapter 0  verse 0  (the real intro row)
//   Both notes begin with the SAME 22-character junk prefix: a raw TSV row's
//   own leading identity columns pasted into the note body —
//     "front:intro" TAB "l9fr" TAB TAB TAB TAB "0" TAB
//   (Reference, ID, Tags, SupportReference, Quote, Occurrence, then Note
//   starts). Verified in prod: substr(l9fr.note,23) = substr(ee2w.note,23)
//   — the bodies after the prefix are byte-identical.
//
// ORIGIN (from edit_log)
//   User 31 created a blank chapter-0 stub ee2w via the app's "Add note"
//   path on 2026-06-22T18:22:00Z (the create-time bug this incident exposed
//   — see chapterZeroGuard.ts), pasted the raw TSV line into it 22 seconds
//   later, then on 2026-07-01 pasted the same malformed line into the real
//   front:intro row l9fr. The 0:1 stub was never deleted.
//
// WHY THIS CANNOT BE FIXED ON DCS MASTER
//   Both rows are human-owned (updated_by = 31, no ai_pipeline edit_log tail),
//   so isReimportableRow (reimportClassify.ts) returns false for both and the
//   nightly export keeps re-publishing D1's version. D1 is the only place
//   this sticks.
//
// TWO REPAIRS, MODELLED ON scripts/restore-rich-cleanups.mjs
//   1. Soft-delete ee2w the same shape as DELETE /api/rows/tn/:id (rows.ts):
//      deleted_at + version+1 + updated_at, plus a conditional edit_log
//      'delete' row. `updated_by` is deliberately NOT touched (see that
//      script's rationale: standing authorship stays with the human who
//      wrote the row, and there is no real acting user in an offline
//      script to attribute this to instead).
//   2. Strip the 22-char prefix from l9fr's note (note = substr(note, 23)),
//      version+1 + updated_at, plus a conditional edit_log 'update' row.
//
// SAFETY
//   • Dry run is the DEFAULT. Nothing is written without an explicit --apply.
//   • The 22-char prefix is computed in JS from its literal TSV fields, never
//     copy-pasted as one string that an editor could have re-tabbed.
//   • Every D1 read is asserted to be a bare SELECT before it is handed to
//     wrangler (assertReadOnly); the dry-run path cannot emit a write.
//   • Both rows are re-verified at RUN TIME (not trusted from this comment):
//       - the note must still start with the exact 22-char prefix (else SKIP
//         — someone already fixed it);
//       - ee2w's body must still equal l9fr's body after stripping (else
//         SKIP — they've diverged, a human must look);
//       - each row's version must still equal the constant recorded below
//         (else REFUSE — a concurrent edit landed, do not clobber it);
//       - neither row's updated_at, nor any edit_log entry for it, may fall
//         on TODAY (UTC) — the project's standing "don't touch same-day
//         edits" rule (else REFUSE).
//   • --apply re-reads and re-verifies every guard from scratch immediately
//     before writing (not reusing the dry-run's read) — the dry-run numbers
//     are evidence for a human, never the authority for the write.
//   • Each UPDATE is paired with a conditional edit_log row (source =
//     'data_repair'), gated on the UPDATE having actually landed.
//
// USAGE (from repo root; Node 24)
//   node --experimental-strip-types --no-warnings scripts/repair-isa-chapter0.mjs
//   node --experimental-strip-types --no-warnings scripts/repair-isa-chapter0.mjs --apply   # WRITES

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const apiDir = resolve(repoRoot, "api");
const outDir = resolve(repoRoot, "scripts", "out");

const BOOK = "ISA";
const ID_STUB = "ee2w"; // "0:1" — the illegal chapter-0 stub, to be soft-deleted
const ID_REAL = "l9fr"; // "front:intro" — the real intro row, to have its note repaired

// Versions as last observed by a human (2026-08-11 investigation). If either
// row has moved off these versions, something touched it since — refuse
// rather than guess which write should win.
const EXPECTED_VERSION = { [ID_STUB]: 2, [ID_REAL]: 2 };

// The 22-char junk prefix, built from its literal TSV fields (never a single
// copy-pasted string) so a mangled tab in this file can't silently mismatch
// what's actually stored: Reference, ID, Tags, SupportReference, Quote,
// Occurrence, then the tab that would introduce the Note column.
const PREFIX_FIELDS = ["front:intro", ID_REAL, "", "", "", "0"];
const PREFIX = PREFIX_FIELDS.join("\t") + "\t";
if (PREFIX.length !== 22) {
  throw new Error(`internal error: expected a 22-char prefix, computed ${PREFIX.length}`);
}

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

// ── D1 (read-only helpers, lifted verbatim in spirit from restore-rich-cleanups.mjs) ──

function assertReadOnly(sql) {
  const s = sql.trim().replace(/\s+/g, " ");
  if (!/^SELECT /i.test(s)) throw new Error(`read path refused a non-SELECT statement: ${s.slice(0, 120)}`);
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA|ATTACH)\b/i.test(s)) {
    throw new Error(`read path refused a statement containing a write keyword: ${s.slice(0, 120)}`);
  }
  return sql;
}

const WRANGLER_BIN = [
  resolve(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
  resolve(apiDir, "node_modules", "wrangler", "bin", "wrangler.js"),
].find((p) => existsSync(p));
if (!WRANGLER_BIN) throw new Error("cannot find wrangler/bin/wrangler.js — run `npm install` first");

function runWrangler(extraArgs) {
  return spawnSync(
    process.execPath,
    [WRANGLER_BIN, "d1", "execute", "bible_editor", "--remote", "--env", "production", "--json", ...extraArgs],
    { cwd: apiDir, encoding: "utf8", shell: false, maxBuffer: 512 * 1024 * 1024 },
  );
}

function extractJson(stdout) {
  const s = stdout ?? "";
  const i = s.indexOf("[");
  const j = s.indexOf("{");
  const start = i < 0 ? j : j < 0 ? i : Math.min(i, j);
  if (start < 0) throw new Error(`wrangler produced no JSON:\n${s.slice(0, 2000)}`);
  return JSON.parse(s.slice(start));
}

function d1Select(sql) {
  assertReadOnly(sql);
  const r = runWrangler(["--command", sql]);
  if (r.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (exit ${r.status}).\n${(r.stderr || "").slice(0, 2000)}\n` +
        `If this is a 7403, run \`npx wrangler whoami\` once to refresh the OAuth token, then retry.`,
    );
  }
  let parsed;
  try {
    parsed = extractJson(r.stdout);
  } catch (e) {
    throw new Error(`wrangler did not return JSON: ${e.message}\n${(r.stdout || "").slice(0, 2000)}`);
  }
  if (parsed && !Array.isArray(parsed) && parsed.error) {
    throw new Error(`wrangler/Cloudflare error: ${parsed.error.text || parsed.error.name}`);
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  for (const x of arr) {
    if (x?.meta && Number(x.meta.rows_written ?? 0) > 0) {
      throw new Error(`a SELECT reported rows_written=${x.meta.rows_written} — aborting`);
    }
  }
  return arr.flatMap((x) => x.results ?? []);
}

const sqlStr = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

const ROW_COLUMNS =
  "id, book, chapter, verse, ref_raw, note, version, updated_at, updated_by, deleted_at, trashed_at, preserve, hint";

function readRow(id) {
  const rows = d1Select(
    `SELECT ${ROW_COLUMNS} FROM tn_rows WHERE book = ${sqlStr(BOOK)} AND id = ${sqlStr(id)};`,
  );
  return rows[0] ?? null;
}

// Any edit_log entry for this row created on the given UTC calendar day.
function editLogTodayCount(id, dayStartTs, dayEndTs) {
  const rows = d1Select(
    `SELECT COUNT(*) AS n FROM edit_log
      WHERE kind = 'tn' AND row_key = ${sqlStr(id)} AND (book = ${sqlStr(BOOK)} OR book IS NULL)
        AND created_at >= ${dayStartTs} AND created_at < ${dayEndTs};`,
  );
  return Number(rows[0]?.n ?? 0);
}

// ── report helpers ────────────────────────────────────────────────────────

const visibleTabs = (s) => (s == null ? "‹null›" : String(s).replace(/\t/g, "\\t").replace(/\n/g, "\\n"));
const clip = (s, n = 120) => {
  const v = visibleTabs(s);
  return v.length > n ? v.slice(0, n) + "…" : v;
};

// ── guards ────────────────────────────────────────────────────────────────
// Returns { ok, reasons: string[], stub, real, strippedNote } — never throws;
// every refusal is a reported reason, not an exception, so both rows are
// always evaluated and reported even if one fails.

function evaluate(nowTs) {
  const reasons = [];
  const stub = readRow(ID_STUB);
  const real = readRow(ID_REAL);

  if (!stub) reasons.push(`${ID_STUB}: row not found — nothing to delete.`);
  if (!real) reasons.push(`${ID_REAL}: row not found — nothing to repair.`);
  if (!stub || !real) return { ok: false, reasons, stub, real, strippedNote: null };

  if (stub.deleted_at != null) reasons.push(`${ID_STUB}: already deleted_at=${stub.deleted_at} — nothing to do.`);
  if (real.deleted_at != null) reasons.push(`${ID_REAL}: deleted_at=${real.deleted_at} — refusing to touch a deleted row.`);
  if (real.trashed_at != null) reasons.push(`${ID_REAL}: trashed_at=${real.trashed_at} — refusing to touch a trashed row.`);
  if (Number(real.preserve ?? 0) !== 0) reasons.push(`${ID_REAL}: preserve is set — refusing to touch a protected row.`);
  if (Number(real.hint ?? 0) !== 0) reasons.push(`${ID_REAL}: hint is set — refusing to touch a protected row.`);

  // Version CAS: refuse if either row moved off the last-observed version.
  if (Number(stub.version) !== EXPECTED_VERSION[ID_STUB]) {
    reasons.push(`${ID_STUB}: version is ${stub.version}, expected ${EXPECTED_VERSION[ID_STUB]} — someone touched it since.`);
  }
  if (Number(real.version) !== EXPECTED_VERSION[ID_REAL]) {
    reasons.push(`${ID_REAL}: version is ${real.version}, expected ${EXPECTED_VERSION[ID_REAL]} — someone touched it since.`);
  }

  // Same-day guard: refuse if either row's updated_at, or any edit_log entry
  // for it, falls on today (UTC).
  const dayStart = Math.floor(nowTs / 86400) * 86400;
  const dayEnd = dayStart + 86400;
  for (const [id, row] of [[ID_STUB, stub], [ID_REAL, real]]) {
    if (row.updated_at != null && row.updated_at >= dayStart && row.updated_at < dayEnd) {
      reasons.push(`${id}: updated_at falls on today (UTC) — refusing to touch a same-day edit.`);
    }
    const editsToday = editLogTodayCount(id, dayStart, dayEnd);
    if (editsToday > 0) {
      reasons.push(`${id}: ${editsToday} edit_log entr${editsToday === 1 ? "y" : "ies"} today (UTC) — refusing to touch a same-day edit.`);
    }
  }

  // Prefix re-verification: compute in JS, never trust the header comment.
  const stubNote = stub.note ?? "";
  const realNote = real.note ?? "";
  if (!realNote.startsWith(PREFIX)) {
    reasons.push(`${ID_REAL}: note no longer starts with the expected 22-char prefix — someone already fixed it, or the shape changed.`);
  }
  if (!stubNote.startsWith(PREFIX)) {
    reasons.push(`${ID_STUB}: note no longer starts with the expected 22-char prefix.`);
  }

  const strippedReal = realNote.startsWith(PREFIX) ? realNote.slice(PREFIX.length) : null;
  const strippedStub = stubNote.startsWith(PREFIX) ? stubNote.slice(PREFIX.length) : null;
  if (strippedReal != null && strippedStub != null && strippedReal !== strippedStub) {
    reasons.push(`${ID_STUB} and ${ID_REAL}: bodies differ after stripping the prefix — they've diverged, a human must look.`);
  }

  return { ok: reasons.length === 0, reasons, stub, real, strippedNote: strippedReal };
}

function printEvaluation(label, ev) {
  console.log(`\n${"═".repeat(100)}`);
  console.log(label);
  console.log("═".repeat(100));
  if (ev.stub) {
    console.log(`\n  ${ID_STUB} (${BOOK} ${ev.stub.ref_raw})  chapter=${ev.stub.chapter} verse=${ev.stub.verse} version=${ev.stub.version}`);
    console.log(`    updated_at=${ev.stub.updated_at} (${new Date(ev.stub.updated_at * 1000).toISOString()})  updated_by=${ev.stub.updated_by}`);
    console.log(`    before (note, first 120): ${clip(ev.stub.note)}`);
    console.log(`    after  (note)           : ‹deleted — deleted_at set, note untouched›`);
  }
  if (ev.real) {
    console.log(`\n  ${ID_REAL} (${BOOK} ${ev.real.ref_raw})  chapter=${ev.real.chapter} verse=${ev.real.verse} version=${ev.real.version}`);
    console.log(`    updated_at=${ev.real.updated_at} (${new Date(ev.real.updated_at * 1000).toISOString()})  updated_by=${ev.real.updated_by}`);
    console.log(`    before (note, first 120): ${clip(ev.real.note)}`);
    console.log(`    after  (note, first 120): ${clip(ev.strippedNote)}`);
    if (ev.real.note != null && ev.strippedNote != null) {
      console.log(`    length delta            : ${ev.real.note.length} -> ${ev.strippedNote.length} (${ev.strippedNote.length - ev.real.note.length})`);
    }
  }
  console.log(`\n  GUARDS: ${ev.ok ? "ALL PASSED" : "FAILED"}`);
  if (ev.reasons.length) {
    for (const r of ev.reasons) console.log(`    - ${r}`);
  } else {
    console.log(`    - row exists (both)`);
    console.log(`    - not deleted/trashed/protected (${ID_REAL})`);
    console.log(`    - version matches last-observed (${ID_STUB}=${EXPECTED_VERSION[ID_STUB]}, ${ID_REAL}=${EXPECTED_VERSION[ID_REAL]})`);
    console.log(`    - neither row edited today (UTC), by updated_at or edit_log`);
    console.log(`    - both notes still start with the expected 22-char prefix`);
    console.log(`    - bodies match after stripping the prefix`);
  }
}

// ── SQL emission (apply path) ────────────────────────────────────────────
// One UPDATE + one conditional edit_log INSERT per row, exactly like
// restore-rich-cleanups.mjs — grouping per statement pair keeps each write
// atomic with its own audit row.

function deleteStubStatements(nowTs, expectedVersion) {
  const payload = JSON.stringify({
    incident: "isa-front-intro-tsv-paste-2026-08-11",
    reason: "illegal chapter-0 stub (ref_raw '0:1') carrying the same TSV-paste junk as l9fr; never deleted after the paste",
  });
  const upd =
    `UPDATE tn_rows SET deleted_at = ${nowTs}, version = version + 1, updated_at = ${nowTs}` +
    ` WHERE book = ${sqlStr(BOOK)} AND id = ${sqlStr(ID_STUB)}` +
    ` AND version = ${expectedVersion} AND deleted_at IS NULL;`;
  const log =
    `INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,action,payload_json,source,created_at)` +
    ` SELECT 'tn',${sqlStr(ID_STUB)},${sqlStr(BOOK)},NULL,version-1,version,'delete',${sqlStr(payload)},'data_repair',${nowTs}` +
    ` FROM tn_rows WHERE book = ${sqlStr(BOOK)} AND id = ${sqlStr(ID_STUB)} AND version = ${expectedVersion + 1};`;
  return [upd, log];
}

function repairRealStatements(nowTs, expectedVersion, strippedNote) {
  const payload = JSON.stringify({
    incident: "isa-front-intro-tsv-paste-2026-08-11",
    field: "note",
    action: "stripped 22-char TSV-paste prefix",
  });
  const upd =
    `UPDATE tn_rows SET note = ${sqlStr(strippedNote)}, version = version + 1, updated_at = ${nowTs}` +
    ` WHERE book = ${sqlStr(BOOK)} AND id = ${sqlStr(ID_REAL)}` +
    ` AND version = ${expectedVersion} AND deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0;`;
  const log =
    `INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,action,payload_json,source,created_at)` +
    ` SELECT 'tn',${sqlStr(ID_REAL)},${sqlStr(BOOK)},NULL,version-1,version,'update',${sqlStr(payload)},'data_repair',${nowTs}` +
    ` FROM tn_rows WHERE book = ${sqlStr(BOOK)} AND id = ${sqlStr(ID_REAL)} AND version = ${expectedVersion + 1};`;
  return [upd, log];
}

// ── main ──────────────────────────────────────────────────────────────────

console.log("═".repeat(100));
console.log("REPAIR ISA front:intro TSV-PASTE CORRUPTION (ee2w / l9fr)" + (APPLY ? "   *** APPLY MODE ***" : "   (DRY RUN)"));
console.log("═".repeat(100));
console.log(`  book              : ${BOOK}`);
console.log(`  stub to delete    : ${ID_STUB} (ref_raw "0:1")`);
console.log(`  row to repair     : ${ID_REAL} (ref_raw "front:intro")`);
console.log(`  expected prefix   : ${visibleTabs(PREFIX)}  (${PREFIX.length} chars)`);
console.log(`  expected versions : ${ID_STUB}=${EXPECTED_VERSION[ID_STUB]}, ${ID_REAL}=${EXPECTED_VERSION[ID_REAL]}`);

const nowTs = Math.floor(Date.now() / 1000);
console.log(`\n[dry run] reading prod D1 …`);
const dry = evaluate(nowTs);
printEvaluation("DRY-RUN EVALUATION", dry);

if (!APPLY) {
  console.log(`\n${"═".repeat(100)}`);
  console.log("SQL THAT --apply WOULD RUN (PRINTED, NOT EXECUTED)");
  console.log("═".repeat(100));
  if (!dry.ok) {
    console.log("  (nothing — guards did not all pass; see reasons above)");
  } else {
    console.log(`\n-- ${BOOK} ${ID_STUB} v=${dry.stub.version}  soft-delete`);
    for (const s of deleteStubStatements(nowTs, dry.stub.version)) console.log(s);
    console.log(`\n-- ${BOOK} ${ID_REAL} v=${dry.real.version}  strip prefix`);
    for (const s of repairRealStatements(nowTs, dry.real.version, dry.strippedNote)) console.log(s);
  }
  console.log("\n  DRY RUN — nothing was written. Pass --apply to write these repairs to prod D1.");
  process.exit(dry.ok ? 0 : 1);
}

// ── apply ─────────────────────────────────────────────────────────────────
// Re-read and re-verify every guard from scratch immediately before writing;
// the dry-run evaluation above is evidence for a human, never the authority
// for the write.

console.log(`\n${"═".repeat(100)}`);
console.log("APPLY — re-reading prod D1 and re-checking every guard before writing");
console.log("═".repeat(100));
const applyTs = Math.floor(Date.now() / 1000);
const fresh = evaluate(applyTs);
printEvaluation("APPLY-TIME RE-EVALUATION", fresh);

if (!fresh.ok) {
  console.error("\n  REFUSING to apply: one or more guards failed on re-read. See reasons above.");
  process.exit(1);
}

const lines = [
  `-- Repair ISA front:intro TSV-paste corruption (ee2w / l9fr) in prod D1.`,
  `-- Generated ${new Date().toISOString()} by scripts/repair-isa-chapter0.mjs --apply`,
  `-- No BEGIN/COMMIT: remote D1 rejects explicit transactions and wraps the file itself.`,
  ...deleteStubStatements(applyTs, fresh.stub.version),
  ...repairRealStatements(applyTs, fresh.real.version, fresh.strippedNote),
];
mkdirSync(outDir, { recursive: true });
const applyFile = join(outDir, "repair-isa-chapter0.sql");
writeFileSync(applyFile, lines.join("\n") + "\n", "utf8");
console.log(`  wrote ${lines.length - 3} statement(s) → ${applyFile}`);

const r = spawnSync(
  process.execPath,
  [WRANGLER_BIN, "d1", "execute", "bible_editor", "--remote", "--env", "production", "--file", applyFile],
  { cwd: apiDir, encoding: "utf8", shell: false, maxBuffer: 512 * 1024 * 1024, stdio: "inherit" },
);
if (r.status !== 0) {
  console.error(`  wrangler exited ${r.status} — inspect ${applyFile} and prod before retrying.`);
  process.exit(1);
}
console.log(`  applied. Re-run without --apply to confirm both rows now read as "nothing to do".`);
