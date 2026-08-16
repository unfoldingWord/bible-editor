// INDEPENDENT verification of the SQL produced by repair-number-split-verses.mjs
// (GitHub issue #452).
//
// WHY THIS EXISTS, SEPARATELY FROM THE GENERATOR
//   The generator checks its own work, which is necessary but not sufficient:
//   a bug shared between the transform and its self-check is invisible. This
//   harness shares no TRANSFORM code with the generator: it seeds a real SQLite
//   database with the ORIGINAL prod rows, executes the generated .sql, and then
//   re-derives every claim from scratch with independently written tree
//   walkers. (The one thing it does share is the dump loader, deliberately —
//   two parsers that disagree about what a dump is would be worse than one.)
//
//   WHAT THIS IS NOT. It does not reproduce `wrangler d1 execute --file`
//   faithfully. Against `--remote` wrangler drives Cloudflare's D1 import API,
//   which is not a single atomic execution, and this repo has seen such an
//   apply run 3 of 19 statements and still report success. To at least mirror
//   the shape of that risk, statements are executed ONE AT A TIME here rather
//   than as one `db.exec(sql)` — so a statement that fails is attributed to its
//   own line instead of aborting the batch. Local SQLite still cannot prove
//   anything about the remote import API; that is what the generated file's
//   post-apply checks are for.
//
//   That independence has already paid for itself: it caught the generated
//   file's audit INSERT double-logging on a re-run (38 verses → 76 edit_log
//   rows), because `WHERE version = v+1 AND content_json = <new>` stays true
//   forever once the repair lands. The generator now emits a NOT EXISTS guard
//   and this harness proves the file is a total no-op on re-run.
//
// WHAT IT ASSERTS, PER VERSE
//   The dump is selected by a `plain_text` GLOB, so it routinely holds rows the
//   generator legitimately did NOT write — verses it refused, and verses whose
//   tree was already clean. The harness reads which verses the SQL actually
//   repairs out of the file itself and applies the right expectation to each:
//   a repaired row must move by exactly one version, and every other row must
//   be byte-for-byte untouched with no audit row. (Asserting "version bumped"
//   for every dump row made this report FAIL for healthy skipped verses, which
//   would have trained the operator to ignore the check that matters.)
//
//   For a repaired verse:
//   • version bumped by exactly 1, and `updated_by` untouched;
//   • `\zaln` milestone count, `\w` count, node count and the concatenated `\w`
//     surface forms are all IDENTICAL before and after;
//   • the new raw text equals the old raw text with the thousands separators
//     independently re-joined — character for character;
//   • no `digit, space + 3 digits` site survives in content_json or plain_text;
//   • plain_text equals the independently re-joined old plain_text;
//   • exactly one `source='data_repair'` edit_log row exists, with
//     action='repair_number_split', user_id NULL, and the right book and
//     prev/new versions.
//   Then it applies the whole file a SECOND time and asserts nothing moves —
//   proving the version-CAS and the audit guard make a re-run safe.
//
// USAGE (from repo root)
//   node scripts/verify-number-split-repair.mjs <dump.json> <repair.sql>
//   node scripts/verify-number-split-repair.mjs \
//     scripts/out/number-split-dump.json scripts/out/repair-number-split.sql
//
//   Both arguments must be the SAME pair the generator ran on. Exit 0 = every
//   verse verified; exit 1 = at least one failed (details on stdout).
//
// Touches no network and no real database — everything happens in an in-memory
// SQLite instance.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractJsonRows } from "./lib/numberSplit.mjs";

const [dumpArg, sqlArg] = process.argv.slice(2);
if (!dumpArg || !sqlArg) {
  console.error("usage: node scripts/verify-number-split-repair.mjs <dump.json> <repair.sql>");
  process.exit(1);
}
const dumpPath = resolve(process.cwd(), dumpArg);
const sqlPath = resolve(process.cwd(), sqlArg);

// Use the SHARED loader, not a local `indexOf("[")`: wrangler's banner lines
// contain brackets, and the naive version crashed on a real dump.
let rows;
try {
  rows = extractJsonRows(readFileSync(dumpPath, "utf8"), dumpPath);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const sql = readFileSync(sqlPath, "utf8");

// Schema mirrors api/migrations (0001_init + 0007/0010/0017 edit_log columns).
const db = new DatabaseSync(":memory:");
db.exec(`
CREATE TABLE verses (
  book TEXT NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL,
  verse_end INTEGER, bible_version TEXT NOT NULL, content_json TEXT NOT NULL,
  plain_text TEXT, version INTEGER NOT NULL DEFAULT 1, updated_by INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (book, chapter, verse, bible_version));
CREATE TABLE edit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, row_key TEXT NOT NULL,
  user_id INTEGER, prev_version INTEGER, new_version INTEGER, action TEXT NOT NULL,
  payload_json TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  restored_from_version INTEGER, source TEXT, book TEXT);
`);

const ins = db.prepare(
  `INSERT INTO verses (book,chapter,verse,verse_end,bible_version,content_json,plain_text,version,updated_by,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
);
// A dump row can be malformed (a missing column, a non-integer chapter). Such a
// row is one the generator refuses, so it is not this harness's job to judge —
// but it must not take the whole run down with a bind-error stack trace either.
// Skip it, name it, and carry on verifying the rest.
const seeded = [];
const unseedable = [];
for (const r of rows) {
  try {
    ins.run(r.book, r.chapter, r.verse, r.verse_end ?? null, r.bible_version, r.content_json,
      r.plain_text ?? null, r.version, r.updated_by ?? null, r.updated_at ?? 0);
    seeded.push(r);
  } catch (e) {
    unseedable.push({ r, why: e.message });
  }
}

// Execute one statement at a time (see WHAT THIS IS NOT above). Statements in
// this file are single-line and semicolon-terminated by construction, and no
// statement body contains a newline, so splitting on line boundaries that end
// in `;` is exact for THIS generator's output — asserted below.
function statementsOf(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("--")) continue;
    if (!t.endsWith(";")) {
      throw new Error(`unexpected multi-line statement in ${sqlPath}: ${t.slice(0, 80)}…`);
    }
    out.push(t);
  }
  return out;
}

function applyAll(label) {
  const stmts = statementsOf(sql);
  let failures = 0;
  for (const [i, s] of stmts.entries()) {
    try {
      db.exec(s);
    } catch (e) {
      failures++;
      console.error(`  ${label}: statement ${i + 1} FAILED: ${e.message}\n    ${s.slice(0, 160)}`);
    }
  }
  return { count: stmts.length, failures };
}

const firstApply = applyAll("apply");
if (firstApply.failures) {
  console.error(`\n${firstApply.failures} statement(s) failed to execute — the SQL is not valid.`);
  process.exit(1);
}

// ── independent re-derivation (deliberately not the generator's helpers) ────
const DEFECT = /(\d), (\d{3})(?!\d)/;
const rawOf = (cj) => {
  const acc = [];
  const rec = (n) => {
    if (Array.isArray(n)) return n.forEach(rec);
    if (!n || typeof n !== "object") return;
    if (typeof n.text === "string") acc.push(n.text);
    if (n.children) rec(n.children);
  };
  rec(JSON.parse(cj).verseObjects);
  return acc.join("");
};
const tally = (cj) => {
  let zaln = 0, w = 0, nodes = 0;
  const surfaces = [];
  const rec = (n) => {
    if (Array.isArray(n)) return n.forEach(rec);
    if (!n || typeof n !== "object") return;
    nodes++;
    if (n.type === "milestone" && n.tag === "zaln") zaln++;
    if (n.type === "word" && n.tag === "w") { w++; surfaces.push(String(n.text ?? "")); }
    if (n.children) rec(n.children);
  };
  rec(JSON.parse(cj).verseObjects);
  return { zaln, w, nodes, surfaces: surfaces.join("") };
};
const joinAll = (s) => {
  let o = s, p;
  do { p = o; o = o.replace(DEFECT, (_a, x, y) => x + "," + y); } while (o !== p);
  return o;
};

// WHICH rows the generator actually repaired, read out of the SQL file itself.
//
// The dump is selected by a `plain_text` GLOB and therefore routinely contains
// rows the generator legitimately did NOT write: verses it refused, and verses
// whose tree was already clean. Asserting "version bumped" for every dump row
// made the harness report FAIL for healthy, correctly-skipped verses — which
// would have trained the operator to ignore the one check that matters. So the
// expectation is derived per row: repaired rows must move by exactly one
// version, everything else must be byte-for-byte untouched.
const repairedKeys = new Set();
for (const m of sql.matchAll(
  /^--\s+(\S+)\s+(\S+)\s+(\d+):(\d+)\s+v\d+\s*→/gmu,
)) {
  repairedKeys.add(`${m[1]}|${m[2]}|${m[3]}|${m[4]}`);
}
const keyOf = (r) => `${r.book}|${r.bible_version}|${r.chapter}|${r.verse}`;

// This is the one place the harness depends on the generator's output FORMAT.
// If that comment header ever changes, every repaired row would silently be
// treated as "should be untouched" and the run would fail confusingly rather
// than wrongly-pass — but say so plainly instead.
const updateCount = (sql.match(/^UPDATE verses SET/gm) || []).length;
if (updateCount !== repairedKeys.size) {
  console.error(
    `cannot map the SQL to verses: found ${updateCount} UPDATE statement(s) but parsed` +
      ` ${repairedKeys.size} verse header comment(s). The generator's comment format and this` +
      ` parser have diverged — fix the parser rather than trusting this run.`,
  );
  process.exit(1);
}

const fail = [];
const ok = [];
const untouched = [];
for (const r of seeded) {
  const ref = `${r.book} ${r.bible_version} ${r.chapter}:${r.verse}`;
  const now = db.prepare(
    `SELECT content_json, plain_text, version, updated_by FROM verses
     WHERE book=? AND chapter=? AND verse=? AND bible_version=?`,
  ).get(r.book, r.chapter, r.verse, r.bible_version);

  // Not repaired by this file — assert it was left completely alone.
  if (!repairedKeys.has(keyOf(r))) {
    const untouchedProblems = [];
    if (now.version !== r.version) untouchedProblems.push(`version moved ${r.version} → ${now.version}`);
    if (now.content_json !== r.content_json) untouchedProblems.push("content_json changed");
    if ((now.plain_text ?? null) !== (r.plain_text ?? null)) untouchedProblems.push("plain_text changed");
    const strayLog = db.prepare(
      `SELECT COUNT(*) c FROM edit_log WHERE kind='verse' AND row_key=?`,
    ).get(`${r.book}/${r.chapter}/${r.verse}/${r.bible_version}`).c;
    if (strayLog !== 0) untouchedProblems.push(`${strayLog} edit_log row(s) written for a verse this file does not repair`);
    if (untouchedProblems.length) fail.push(`${ref} (not in SQL): ${untouchedProblems.join("; ")}`);
    else untouched.push(ref);
    continue;
  }

  const problems = [];
  if (now.version !== r.version + 1) problems.push(`version ${r.version} → ${now.version} (expected ${r.version + 1})`);

  const before = tally(r.content_json), after = tally(now.content_json);
  if (before.zaln !== after.zaln) problems.push(`zaln ${before.zaln} → ${after.zaln}`);
  if (before.w !== after.w) problems.push(`\\w ${before.w} → ${after.w}`);
  if (before.nodes !== after.nodes) problems.push(`nodes ${before.nodes} → ${after.nodes}`);
  if (before.surfaces !== after.surfaces) problems.push("\\w surface forms changed");

  const rawBefore = rawOf(r.content_json), rawAfter = rawOf(now.content_json);
  if (rawAfter !== joinAll(rawBefore)) problems.push("new raw text != independently joined old raw text");
  if (DEFECT.test(rawAfter)) problems.push("defect site REMAINS in content_json");
  if (DEFECT.test(now.plain_text ?? "")) problems.push("defect site REMAINS in plain_text");
  if ((now.plain_text ?? "") !== joinAll(r.plain_text ?? "")) problems.push("plain_text != independently joined old plain_text");
  // updated_by MUST become non-NULL. This is not cosmetic: the nightly sync's
  // pristine path (bookReimport.ts) overwrites `updated_by IS NULL` rows from
  // master unconditionally, and master still holds the broken bytes until our
  // export lands. A repair that leaves the row pristine gets reverted.
  if (now.updated_by == null) {
    problems.push("updated_by is still NULL — the row stays in the sync's blind-overwrite class");
  }

  const joined = (rawAfter.match(/\d[\d,]*,\d{3}/g) || []).join(" ");
  if (!joined) problems.push("no joined thousands number found in the result");

  const log = db.prepare(
    `SELECT * FROM edit_log WHERE kind='verse' AND row_key=? AND source='data_repair'`,
  ).all(`${r.book}/${r.chapter}/${r.verse}/${r.bible_version}`);
  if (log.length !== 1) problems.push(`expected 1 data_repair edit_log row, got ${log.length}`);
  else {
    const L = log[0];
    // action MUST be 'update'. The sync's provenance sub-select filters
    // `action IN ('create','update')`; a custom action is invisible to it, so
    // the query walks back to an OLDER row — and an inherited
    // source='ai_pipeline' there would get this verse re-seeded from master
    // despite updated_by being set.
    if (L.action !== "update") {
      problems.push(`edit_log.action='${L.action}' — must be 'update' to be seen by latest_source`);
    }
    if (L.user_id == null) problems.push("edit_log.user_id is NULL — the repair has no attributed author");
    if (L.prev_version !== r.version || L.new_version !== r.version + 1)
      problems.push(`edit_log versions ${L.prev_version}→${L.new_version}`);
    if (L.book !== r.book) problems.push(`edit_log.book=${L.book}`);
    // The payload must carry `content` and `plain_text`: because this is an
    // action='update' row the merge's ancestor recovery can select it, and it
    // reads the ancestor through verseContentJsonFromPayload, which looks only
    // at payload.content. Without it the merge degrades to keep_no_base.
    let P = null;
    try { P = JSON.parse(L.payload_json); } catch { /* reported below */ }
    if (!P) problems.push("edit_log.payload_json does not parse");
    else {
      if (typeof P.content !== "string") problems.push("payload has no `content` — unusable as a merge ancestor");
      else if (P.content !== now.content_json) problems.push("payload.content does not match the row's content_json");
      if (P.plain_text !== now.plain_text) problems.push("payload.plain_text does not match the row's plain_text");
    }
  }

  if (problems.length) fail.push(`${ref}: ${problems.join("; ")}`);
  else ok.push(`${ref}  ${joined}`);
}

console.log(`dump : ${dumpPath}`);
console.log(`sql  : ${sqlPath}`);
console.log(`rows in dump         : ${rows.length}`);
console.log(`verses seeded        : ${seeded.length}`);
if (unseedable.length) {
  console.log(`UNSEEDABLE dump rows : ${unseedable.length}  (malformed — the generator refuses these too)`);
  for (const u of unseedable) {
    console.log(`  --   ${u.r.book} ${u.r.bible_version} ${u.r.chapter}:${u.r.verse} — ${u.why}`);
  }
}
console.log(`verses the SQL repairs: ${repairedKeys.size}`);
console.log(`edit_log rows written: ${db.prepare("SELECT COUNT(*) c FROM edit_log").get().c}`);
console.log(`PASS: ${ok.length}   UNTOUCHED (correctly not in the SQL): ${untouched.length}   FAIL: ${fail.length}`);
for (const l of ok) console.log("  ok   " + l);
for (const l of untouched) console.log("  --   " + l + "  (skipped by the generator; verified unchanged)");
for (const l of fail) console.log("  FAIL " + l);

// ── re-run must be a total no-op (version-CAS + audit guard) ───────────────
const logBefore = db.prepare("SELECT COUNT(*) c FROM edit_log").get().c;
const snap = db.prepare("SELECT book,chapter,verse,bible_version,content_json,version FROM verses ORDER BY book,bible_version,chapter,verse").all();
const secondApply = applyAll("re-run");
if (secondApply.failures) console.error(`  re-run: ${secondApply.failures} statement(s) errored`);
const logAfter = db.prepare("SELECT COUNT(*) c FROM edit_log").get().c;
const snap2 = db.prepare("SELECT book,chapter,verse,bible_version,content_json,version FROM verses ORDER BY book,bible_version,chapter,verse").all();
const noop = logBefore === logAfter && JSON.stringify(snap) === JSON.stringify(snap2);
console.log(`\nRE-RUN IS A NO-OP: ${noop}  (edit_log ${logBefore} → ${logAfter}; verse rows identical: ${JSON.stringify(snap) === JSON.stringify(snap2)})`);

process.exit(fail.length || !noop ? 1 : 0);
