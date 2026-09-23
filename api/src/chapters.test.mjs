// Regression test for issue #906: the chapter GET's tn/tq/twl SELECTs must
// list columns explicitly (no `t.*`) so `review_master_json` never reaches
// the client, while every other column the TnRow/TqRow/TwlRow types expect
// stays present. Runs the exact SQL text chapters.ts uses against real
// SQLite, so a future migration that renames/adds a column and a stale
// column list here would show up as a query error or a missing key, not a
// silent drop.
//
// Run from api/:
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/chapters.test.mjs

import { DatabaseSync } from "node:sqlite";
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

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE tn_rows (
      id TEXT, book TEXT, chapter INTEGER, verse INTEGER, ref_raw TEXT,
      tags TEXT, support_reference TEXT, quote TEXT, occurrence INTEGER,
      note TEXT, sort_order REAL, version INTEGER NOT NULL DEFAULT 1,
      restored_from_version INTEGER, updated_by INTEGER, updated_at INTEGER,
      deleted_at INTEGER, trashed_at INTEGER, preserve INTEGER NOT NULL DEFAULT 0,
      hint INTEGER NOT NULL DEFAULT 0, review_kind TEXT, review_reason TEXT,
      review_master_json TEXT, last_change_action TEXT, last_change_source TEXT,
      last_change_actor TEXT,
      PRIMARY KEY (book, id)
    );
    CREATE TABLE tq_rows (
      id TEXT, book TEXT, chapter INTEGER, verse INTEGER, ref_raw TEXT,
      tags TEXT, quote TEXT, occurrence INTEGER, question TEXT, response TEXT,
      sort_order REAL, version INTEGER NOT NULL DEFAULT 1, restored_from_version INTEGER,
      updated_by INTEGER, updated_at INTEGER, deleted_at INTEGER,
      review_kind TEXT, review_reason TEXT, review_master_json TEXT,
      last_change_action TEXT, last_change_source TEXT, last_change_actor TEXT,
      PRIMARY KEY (book, id)
    );
    CREATE TABLE twl_rows (
      id TEXT, book TEXT, chapter INTEGER, verse INTEGER, ref_raw TEXT,
      tags TEXT, orig_words TEXT, occurrence INTEGER, tw_link TEXT,
      sort_order REAL, version INTEGER NOT NULL DEFAULT 1, restored_from_version INTEGER,
      updated_by INTEGER, updated_at INTEGER, deleted_at INTEGER,
      review_kind TEXT, review_reason TEXT, review_master_json TEXT,
      last_change_action TEXT, last_change_source TEXT, last_change_actor TEXT,
      PRIMARY KEY (book, id)
    );
    CREATE TABLE edit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, row_key TEXT, book TEXT, source TEXT
    );

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

    INSERT INTO edit_log (kind, row_key, book, source) VALUES ('tn', 'ab12', 'ZEC', 'ai_pipeline');
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

const EXPECTED_TQ_KEYS = [
  "id", "book", "chapter", "verse", "ref_raw", "tags", "quote", "occurrence", "question",
  "response", "sort_order", "version", "restored_from_version", "updated_by", "updated_at",
  "deleted_at", "review_kind", "review_reason", "last_change_action", "last_change_source",
  "last_change_actor", "latest_source",
].sort();

const EXPECTED_TWL_KEYS = [
  "id", "book", "chapter", "verse", "ref_raw", "tags", "orig_words", "occurrence", "tw_link",
  "sort_order", "version", "restored_from_version", "updated_by", "updated_at", "deleted_at",
  "review_kind", "review_reason", "last_change_action", "last_change_source", "last_change_actor",
].sort();

const d = db();

const tnRow = d.prepare(TN_CHAPTER_SELECT_SQL).all("ZEC", 1)[0];
assert(!!tnRow, "tn select returns the seeded row");
assert(!("review_master_json" in tnRow), "tn row does not carry review_master_json");
assert(
  JSON.stringify(Object.keys(tnRow).sort()) === JSON.stringify(EXPECTED_TN_KEYS),
  "tn row has exactly the expected column set",
);
assert(tnRow.latest_source === "ai_pipeline", "tn row's latest_source is resolved from edit_log");
assert(tnRow.review_kind === "quote", "tn row keeps review_kind (display evidence lives elsewhere)");

const tqRow = d.prepare(TQ_CHAPTER_SELECT_SQL).all("ZEC", 1)[0];
assert(!!tqRow, "tq select returns the seeded row");
assert(!("review_master_json" in tqRow), "tq row does not carry review_master_json");
assert(
  JSON.stringify(Object.keys(tqRow).sort()) === JSON.stringify(EXPECTED_TQ_KEYS),
  "tq row has exactly the expected column set",
);
assert(tqRow.latest_source == null, "tq row's latest_source is null with no edit_log entry");

const twlRow = d.prepare(TWL_CHAPTER_SELECT_SQL).all("ZEC", 1)[0];
assert(!!twlRow, "twl select returns the seeded row");
assert(!("review_master_json" in twlRow), "twl row does not carry review_master_json");
assert(
  JSON.stringify(Object.keys(twlRow).sort()) === JSON.stringify(EXPECTED_TWL_KEYS),
  "twl row has exactly the expected column set",
);
assert(twlRow.review_kind === "ref_moved", "twl row keeps review_kind");

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll chapters (#906) select-SQL tests passed.");
