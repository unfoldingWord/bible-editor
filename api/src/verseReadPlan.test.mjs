// Query-plan guard for applyVerseRows' existing-verse read (issue #1386).
//
// Run from api/:
//   node --experimental-strip-types --experimental-sqlite --no-warnings \
//     --import ./src/tsResolveHook.mjs src/verseReadPlan.test.mjs
// (or `npm test`, which passes the same flags via scripts/run-tests.mjs)
//
// Not a test framework; failures exit non-zero.
//
// base_payload and base_row_exists filter edit_log on
//   (action IN (...) AND <boundary>) OR (action = 'baseline' AND created_at < ?)
// Each OR arm is indexable on its own, the second through
// edit_log_kind_action_created (migration 0073, added for the retention sweep),
// so unhinted SQLite plans a MULTI-INDEX OR whose baseline arm walks every
// kind='verse' baseline row in the table for each verse. On prod 2026-11-15
// that read 153,179 rows for one 23-verse chapter, and the nightly's chunk
// steps failed with "D1 DB is overloaded". The two sub-selects name
// edit_log_row (kind, row_key) with INDEXED BY. This file proves (1) every
// edit_log read in the query goes through edit_log_row in all three shapes
// (no watermark, id boundary, timestamp boundary), (2) the unhinted query does
// plan the costly path, so (1) is testing something, and (3) the hint
// changes no result.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existingVerseRowsSql } from "./bookReimport.ts";

const HINT = " INDEXED BY edit_log_row";

function freshDb() {
  const d = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    d.exec(readFileSync(join(dir, f), "utf8"));
  }
  return d;
}

const SHAPES = [
  { name: "no watermark", merge: null, reads: 1 },
  { name: "id boundary", merge: { idBoundary: true }, reads: 7 },
  { name: "timestamp boundary", merge: { idBoundary: false }, reads: 7 },
];
const edReads = (details) => details.filter((x) => /^(SEARCH|SCAN) edit_log\b/.test(x));

// (1) Every edit_log read uses edit_log_row, and nothing plans a MULTI-INDEX OR.
{
  const d = freshDb();
  for (const s of SHAPES) {
    for (const chapters of [1, 3]) {
      const sql = existingVerseRowsSql(chapters, s.merge);
      const details = d.prepare("EXPLAIN QUERY PLAN " + sql).all().map((r) => r.detail);
      const reads = edReads(details);
      assert.equal(reads.length, s.reads, `${s.name}: ${s.reads} edit_log read(s) (got ${reads.join(" | ")})`);
      for (const x of reads) assert.match(x, /USING (COVERING )?INDEX edit_log_row \(kind=\? AND row_key=\?/, `${s.name}: ${x}`);
      assert.ok(!details.some((x) => x.includes("MULTI-INDEX OR")), `${s.name}: no MULTI-INDEX OR (${details.join(" | ")})`);
    }
    console.log(`  ok: ${s.name}: every edit_log read seeks edit_log_row`);
  }
}

// (2) Without the hint the planner takes the costly path, so (1) guards a real
// regression. Shown for the id-boundary shape, the one prod's EXPLAIN matched;
// on an empty table node:sqlite happens to plan the timestamp shape through
// edit_log_row unhinted, but nothing stops a different table or SQLite
// version from choosing the OR there too, so (1) pins both.
{
  const d = freshDb();
  for (const s of SHAPES.filter((s) => s.merge?.idBoundary)) {
    const sql = existingVerseRowsSql(1, s.merge);
    assert.ok(sql.includes(HINT), `${s.name}: sanity, the query carries the hint`);
    const details = d.prepare("EXPLAIN QUERY PLAN " + sql.replaceAll(HINT, "")).all().map((r) => r.detail);
    assert.ok(
      details.some((x) => x.includes("edit_log_kind_action_created")),
      `${s.name}: unhinted, a sub-select walks edit_log_kind_action_created (${details.join(" | ")})`,
    );
    console.log(`  ok: ${s.name}: unhinted plan uses edit_log_kind_action_created`);
  }
}

// (3) The hint changes the access path only, never the result.
{
  const d = freshDb();
  let seed = 1386;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const books = ["PSA", "ZEC", "LAM"];
  const versions = ["ULT", "UST"];
  const insV = d.prepare(`INSERT INTO verses (book, chapter, verse, bible_version, content_json, plain_text, version) VALUES (?, ?, ?, ?, '{}', '', 1)`);
  for (const b of books) for (const bv of versions) for (let c = 1; c <= 3; c++) for (let v = 1; v <= 8; v++) insV.run(b, c, v, bv);
  const actions = ["create", "update", "update", "baseline", "baseline", "bridge", "split", "delete", "normalize-align-order", "restore_master_verse"];
  const insE = d.prepare(`INSERT INTO edit_log (kind, row_key, book, action, created_at, source, payload_json, new_version) VALUES ('verse', ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < 4000; i++) {
    const b = pick(books);
    const key = `${b}/${1 + Math.floor(rnd() * 3)}/${1 + Math.floor(rnd() * 9)}/${pick(versions)}`;
    insE.run(key, rnd() < 0.1 ? null : pick([b, b, "LAM"]), pick(actions), 1000 + Math.floor(rnd() * 9000),
      pick([null, null, "ai_pipeline", "dcs_reimport"]), `{"i":${i}}`, 1 + (i % 9));
  }
  let compared = 0;
  for (const s of SHAPES) {
    const sql = existingVerseRowsSql(2, s.merge);
    const plain = sql.replaceAll(HINT, "");
    for (const b of books) for (const bv of versions) for (const boundary of [1500, 2500, 6000]) {
      const bind = s.merge ? [b, bv, 1, 3, boundary, boundary + 500] : [b, bv, 1, 3];
      const order = (rows) => rows.map((r) => JSON.stringify(r)).sort();
      const hinted = order(d.prepare(sql).all(...bind));
      const unhinted = order(d.prepare(plain).all(...bind));
      assert.ok(hinted.length > 0, `${s.name} ${b} ${bv}: rows read`);
      assert.deepEqual(hinted, unhinted, `${s.name} ${b} ${bv} @${boundary}: hinted and unhinted reads agree`);
      compared++;
    }
  }
  // The seeded history must exercise the columns, not just return NULLs.
  const sample = d.prepare(existingVerseRowsSql(1, { idBoundary: false })).all("PSA", "ULT", 1, 6000, 6000);
  assert.ok(sample.some((r) => r.base_payload != null) && sample.some((r) => r.human_edit_after_export === 1) && sample.some((r) => r.restore_master_version != null), "seed exercises base_payload, human_edit_after_export and restore_master_version");
  console.log(`  ok: ${compared} hinted reads match their unhinted twins`);
}

console.log("\nverseReadPlan: ok");
