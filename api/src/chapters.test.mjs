// Regression test for issue #906: the chapter GET's tn/tq/twl SELECTs must
// list columns explicitly (no `t.*`) so `review_master_json` never reaches
// the client, while every other column the TnRow/TqRow/TwlRow types expect
// stays present. Runs the exact SQL text chapters.ts uses against real
// SQLite, applied through the real migrations (#927) rather than a
// hand-written schema copy, so a future migration that adds or renames a
// column and a stale column list here shows up as a test failure naming the
// missing column, not a silent client-side drop.
//
// Run from api/:
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/chapters.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TN_CHAPTER_SELECT_SQL,
  TQ_CHAPTER_SELECT_SQL,
  TWL_CHAPTER_SELECT_SQL,
} from "./chapterSelectSql.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Columns the chapter GET intentionally withholds from the client (#906).
const WITHHELD_COLUMNS = new Set(["review_master_json"]);

function tableColumns(d, table) {
  return d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function db() {
  const d = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    d.exec(readFileSync(join(dir, f), "utf8"));
  }

  d.exec(`
    INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version,
      trashed_at, preserve, hint, review_kind, review_reason, review_master_json,
      last_change_action, last_change_source, last_change_actor)
    VALUES ('ab12', 'ZEC', 1, 3, '1:3', 'a note', 1, 2,
      NULL, 1, 0, 'quote', 'needs a look', '{"quote":"stale"}',
      'update', 'user', 'jane');

    INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order,
      version, review_kind, review_reason, review_master_json,
      last_change_action, last_change_source, last_change_actor)
    VALUES ('cd34', 'ZEC', 1, 3, '1:3', 'why?', 'because', 1, 1,
      NULL, NULL, NULL, 'create', 'user', 'jane');

    INSERT INTO twl_rows (id, book, chapter, verse, ref_raw, orig_words, tw_link, sort_order,
      version, review_kind, review_reason, review_master_json,
      last_change_action, last_change_source, last_change_actor)
    VALUES ('ef56', 'ZEC', 1, 3, '1:3', 'הוא', 'rc://*/tw/dict/bible/kt/god', 1, 1,
      'ref_moved', 'moved from 1:2', '{"ref_raw":"1:2"}', 'update', 'dcs_sync', 'Door43 sync');

    INSERT INTO edit_log (kind, row_key, book, source, action, created_at)
    VALUES ('tn', 'ab12', 'ZEC', 'ai_pipeline', 'update', 0);
  `);
  return d;
}

const EXPECTED_TN_KEYS = [
  "id", "book", "chapter", "verse", "ref_raw", "tags", "support_reference", "quote",
  "occurrence", "note", "sort_order", "version", "restored_from_version", "updated_by",
  "updated_at", "deleted_at", "trashed_at", "preserve", "hint", "review_kind",
  "review_reason", "last_change_action", "last_change_source", "last_change_actor",
  "latest_source",
].sort();

// Every non-withheld column the real (migrated) table carries must appear in
// the matching SELECT's output keys. Schema-driven (not a hand-written list),
// so a migration that adds a column to tn/tq/twl_rows without updating
// chapterSelectSql.ts fails here, naming the missing column, instead of the
// client silently never seeing it (#927).
function assertExposesTableColumns(d, table, row, label) {
  for (const col of tableColumns(d, table)) {
    if (WITHHELD_COLUMNS.has(col)) continue;
    assert(col in row, `${label} row exposes column '${col}'`);
  }
}

const d = db();

const tnRow = d.prepare(TN_CHAPTER_SELECT_SQL).all("ZEC", 1)[0];
assert(!!tnRow, "tn select returns the seeded row");
assert(!("review_master_json" in tnRow), "tn row does not carry review_master_json");
assertExposesTableColumns(d, "tn_rows", tnRow, "tn");
assert(tnRow.latest_source === "ai_pipeline", "tn row's latest_source is resolved from edit_log");
assert(tnRow.review_kind === "quote", "tn row keeps review_kind (display evidence lives elsewhere)");

const tqRow = d.prepare(TQ_CHAPTER_SELECT_SQL).all("ZEC", 1)[0];
assert(!!tqRow, "tq select returns the seeded row");
assert(!("review_master_json" in tqRow), "tq row does not carry review_master_json");
assertExposesTableColumns(d, "tq_rows", tqRow, "tq");
assert(tqRow.latest_source == null, "tq row's latest_source is null with no edit_log entry");

const twlRow = d.prepare(TWL_CHAPTER_SELECT_SQL).all("ZEC", 1)[0];
assert(!!twlRow, "twl select returns the seeded row");
assert(!("review_master_json" in twlRow), "twl row does not carry review_master_json");
assertExposesTableColumns(d, "twl_rows", twlRow, "twl");
assert(twlRow.review_kind === "ref_moved", "twl row keeps review_kind");

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll chapters (#906) select-SQL tests passed.");
