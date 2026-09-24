// Tests for the read-only SQL guard behind scripts/d1-select.mjs.
// Run from the repo root:
//   npm run test:scripts
//   node scripts/lib/readOnlySql.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import assert from "node:assert/strict";
import { readOnlySqlProblem } from "./readOnlySql.mjs";

const allowed = [
  "SELECT 1",
  "select book, chapter from verses where book='JER' order by chapter;",
  "SELECT content_json FROM verses WHERE bible_version = 'UST'  ;  ",
  "WITH x AS (SELECT book FROM verses) SELECT * FROM x",
  "EXPLAIN QUERY PLAN SELECT * FROM edit_log",
  "SELECT deleted_at, updated_at FROM tn_rows",               // keyword inside an identifier
  "SELECT * FROM verses WHERE plain_text LIKE '%delete; drop%'", // keywords and ; inside a literal
  "SELECT 'it''s' AS s",                                       // doubled-quote escape
  "SELECT 1 -- DELETE FROM verses; trailing comment",
  "SELECT /* UPDATE x; */ 1",
  'SELECT "update" FROM t',                                    // quoted identifier
  "SELECT replace(plain_text, ' ', '') FROM verses",          // scalar replace()
  "SELECT REPLACE (plain_text, 'a', 'b') FROM verses",
];
for (const sql of allowed) assert.equal(readOnlySqlProblem(sql), null, sql);

const refused = [
  ["", "empty SQL"],
  ["SELECT 1; DELETE FROM verses", "more than one statement"],
  ["SELECT 1;DELETE FROM verses;", "more than one statement"],
  ["DELETE FROM verses", "must start with SELECT, WITH or EXPLAIN"],
  ["  update verses set version = 1", "must start with SELECT, WITH or EXPLAIN"],
  ["PRAGMA table_info(verses)", "must start with SELECT, WITH or EXPLAIN"],
  ["WITH x AS (SELECT 1) DELETE FROM verses", "forbidden keyword DELETE"],
  ["WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", "forbidden keyword INSERT"],
  ["EXPLAIN DELETE FROM verses", "forbidden keyword DELETE"],
  ["SELECT 1 /* unterminated", "unterminated string literal or comment"],
  ["SELECT 'unterminated", "unterminated string literal or comment"],
  ["SELECT 'a'; DROP TABLE verses; --'", "more than one statement"],
  ["--file=evil.sql\nSELECT 1", "must not start with '-'"],
  ["WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x", "forbidden keyword REPLACE"],
  ["WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c", "refused as potentially expensive: RECURSIVE"],
  ["SELECT randomblob(1000000000)", "refused as potentially expensive: RANDOMBLOB"],
  ["  -- note\nSELECT 1", "must not start with '-'"],
];
for (const [sql, why] of refused) assert.equal(readOnlySqlProblem(sql), why, sql);

console.log(`readOnlySql: ${allowed.length + refused.length} cases passed`);
