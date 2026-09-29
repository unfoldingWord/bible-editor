// Query-plan guard for the hourly edit_log retention sweep (issue #928).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/editLogSweepPlan.test.mjs
//
// Not a test framework; failures exit non-zero.
//
// Without a hint, SQLite (node:sqlite 3.53 and local workerd D1 alike) walks
// every kind='verse' edit_log row through edit_log_row (kind, row_key) in each
// of the sweep's seven verse branches, because that index hands GROUP BY
// row_key its order for free. Cost then scales with the whole table, not with
// the rows past retention: on a synthetic 1.5M-row table the sweep took
// 17.5 s on local workerd. Each branch therefore names the
// (kind, action, created_at) index from migration 0073 with INDEXED BY, which
// seeks straight to the aged rows. This file proves (1) the migration creates
// that index with those columns, (2) the plan actually uses it for every
// edit_log read, and (3) the hint changes no result: the hinted sweep deletes
// exactly the rows the unhinted one does.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EDIT_LOG_SWEEP_SQL } from "./editLogSweep.ts";

const INDEX = "edit_log_kind_action_created";

function freshDb() {
  const d = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    d.exec(readFileSync(join(dir, f), "utf8"));
  }
  return d;
}

// (1) The index exists with the columns the plan relies on.
{
  const d = freshDb();
  const cols = d.prepare(`PRAGMA index_info(${INDEX})`).all().map((r) => r.name);
  assert.deepEqual(cols, ["kind", "action", "created_at"], `${INDEX} indexes (kind, action, created_at)`);
  console.log("  ok: index columns");
}

// (2) Every edit_log read in the sweep's exempt branches uses the index.
{
  const d = freshDb();
  const details = d.prepare("EXPLAIN QUERY PLAN " + EDIT_LOG_SWEEP_SQL).all(0).map((r) => r.detail);
  const elReads = details.filter((x) => /^(SEARCH|SCAN) el\b/.test(x));
  assert.equal(elReads.length, 8, `one edit_log read per branch (got ${elReads.length}: ${elReads.join(" | ")})`);
  for (const x of elReads) assert.match(x, new RegExp(`USING INDEX ${INDEX} \\(kind=\\?`), `branch read uses ${INDEX}: ${x}`);
  console.log("  ok: all 8 branch reads use", INDEX);
}

// (3) The INDEXED BY hint changes the access path only, never the result.
{
  const d = freshDb();
  let seed = 928;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const books = ["ZEC", "LAM", "JER", "RUT"];
  const verseActions = ["create", "update", "update", "update", "baseline", "bridge", "split", "delete", "restore",
    "normalize-align-order", "remove-doubled-q1", "restore_master_verse"];
  const ins = d.prepare(`INSERT INTO edit_log (kind, row_key, book, action, created_at, source) VALUES (?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < 6000; i++) {
    const book = pick(books);
    const createdAt = 1000 + Math.floor(rnd() * 9000);
    if (rnd() < 0.6) {
      ins.run("verse", `${book}/${1 + Math.floor(rnd() * 3)}/${1 + Math.floor(rnd() * 10)}/${pick(["ULT", "UST"])}`,
        rnd() < 0.1 ? null : pick([book, book, book, "LAM"]), pick(verseActions), createdAt, pick([null, null, "ai_pipeline", "dcs_reimport"]));
    } else {
      ins.run(pick(["tn", "tq", "twl"]), `r${Math.floor(rnd() * 40)}`, rnd() < 0.1 ? null : book, pick(["create", "update", "delete"]), createdAt, null);
    }
  }
  const brs = d.prepare(`INSERT INTO book_resource_syncs (book, resource, origin, master_confirmed_at, master_confirmed_edit_id) VALUES (?, ?, 'import', ?, ?)`);
  brs.run("ZEC", "ult", 6000, 3000); brs.run("ZEC", "ust", 7000, null);
  brs.run("LAM", "ult", 4000, 2500); brs.run("JER", "ust", 5000, null);
  brs.run("JER", "ult", null, null); // RUT has no watermark at all
  for (const kind of ["tn", "tq", "twl"]) {
    const t = d.prepare(`INSERT INTO ${kind}_rows (id, book, chapter, verse, ref_raw) VALUES (?, ?, 1, 1, '1:1')`);
    for (const b of books) for (let i = 0; i < 40; i += 2) t.run(`r${i}`, b);
  }

  const unhinted = EDIT_LOG_SWEEP_SQL.replaceAll(` INDEXED BY ${INDEX}`, "");
  assert.notEqual(unhinted, EDIT_LOG_SWEEP_SQL, "sanity: the sweep carries the hint");
  const selectOf = (sql) => sql.replace("DELETE FROM edit_log", "SELECT id FROM edit_log") + " ORDER BY id";
  for (const cutoff of [3000, 5000, 7000, 9000]) {
    const hinted = d.prepare(selectOf(EDIT_LOG_SWEEP_SQL)).all(cutoff).map((r) => r.id);
    const plain = d.prepare(selectOf(unhinted)).all(cutoff).map((r) => r.id);
    const aged = d.prepare(`SELECT COUNT(*) n FROM edit_log WHERE created_at < ?`).get(cutoff).n;
    assert.ok(hinted.length > 0 && hinted.length < aged, `cutoff ${cutoff}: sweep deletes some aged rows and exempts others (${hinted.length}/${aged})`);
    assert.deepEqual(hinted, plain, `cutoff ${cutoff}: hinted and unhinted sweeps pick the same rows`);
    console.log(`  ok: cutoff ${cutoff} deletes the same ${hinted.length} of ${aged} aged rows with and without the hint`);
  }
  // And the literal DELETE removes exactly that set.
  const expected = d.prepare(selectOf(EDIT_LOG_SWEEP_SQL)).all(7000).map((r) => r.id);
  const before = d.prepare(`SELECT COUNT(*) n FROM edit_log`).get().n;
  const res = d.prepare(EDIT_LOG_SWEEP_SQL).run(7000);
  assert.equal(res.changes, expected.length, "DELETE removes exactly the selected rows");
  assert.equal(d.prepare(`SELECT COUNT(*) n FROM edit_log`).get().n, before - expected.length, "row count drops by that much");
  console.log("  ok: literal DELETE matches");
}

console.log("\neditLogSweepPlan: ok");
