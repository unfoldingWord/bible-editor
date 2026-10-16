// Regression test for GitHub issue #985: the POST-APPLY CHECKS survivor query
// emitted into the generated SQL header must count survivors across the same
// scope the dump was scanned over, not just the books this run repaired.
// A survivor (refused / plain_text-only / release-locked / --exclude'd row)
// routinely sits in a DIFFERENT book than any repaired row, so filtering the
// survivor SELECT down to "books actually repaired" made it return 0 even on
// a fully successful apply.
//
// Runs the real CLI end-to-end against a synthetic dump — no production data,
// no network, no D1 — and inspects the generated SQL text.
//
// Run from the repo root:
//   npm run test:scripts
//   node --no-warnings scripts/repair-number-split-verses.test.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "repair-number-split-verses.mjs");

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok: ${msg}`);
}

// One release-locked book and one unlocked book, read from the same
// PUBLISHED_BOOKS list the CLI reads, so the fixture does not go stale when a
// book is locked (ZEC was unlocked when this test was written, and is not now).
// Both rows carry the same repairable defect. The locked one is skipped and
// becomes the one EXPECTED SURVIVOR, in a book this run never repairs.
const guardSrc = readFileSync(resolve(here, "..", "api", "src", "publishedGuard.ts"), "utf8");
const lockedSet = new Set(
  [.../export const PUBLISHED_BOOKS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(guardSrc)[1].matchAll(/"([A-Z0-9]{3})"/g)].map((x) => x[1]),
);
const CANDIDATES = ["GEN", "EXO", "ZEC", "MAL", "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "REV", "1CH", "2CH", "ISA", "JER", "EZK", "NUM", "ECC"];
const LOCKED = CANDIDATES.find((b) => lockedSet.has(b));
const UNLOCKED = CANDIDATES.find((b) => !lockedSet.has(b));
assert(LOCKED && UNLOCKED, `fixture needs one locked and one unlocked book (got ${LOCKED}, ${UNLOCKED})`);

const row = (book, version) => ({
  book,
  bible_version: "ULT",
  chapter: 1,
  verse: 1,
  version,
  content_json: JSON.stringify({ verseObjects: [{ type: "text", text: "There were 24, 000 men." }] }),
  plain_text: "There were 24, 000 men.",
});
const dump = [row(UNLOCKED, 1), row(LOCKED, 1)];

// The issue's success check: apply the generated file to a SQLite seeded with
// the dump, then run the header's own survivor query. It must return the
// number the header says to expect. Schema as in verify-number-split-repair.mjs.
// `outside` rows sit in the table but not in the dump, as production does.
function survivorsAfterApply(sql, outside = [], rowsInDump = dump) {
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
  restored_from_version INTEGER, source TEXT, book TEXT);`);
  const ins = db.prepare(
    `INSERT INTO verses (book,chapter,verse,bible_version,content_json,plain_text,version) VALUES (?,?,?,?,?,?,?)`,
  );
  for (const r of [...rowsInDump, ...outside]) ins.run(r.book, r.chapter, r.verse, r.bible_version, r.content_json, r.plain_text, r.version);
  db.exec(sql);
  const lines = sql.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes("SELECT book, bible_version, chapter, verse FROM verses"));
  const end = lines.findIndex((l, i) => i >= start && l.includes("ORDER BY book, bible_version, chapter, verse;"));
  const query = lines.slice(start, end + 1).map((l) => l.replace(/^--\s*/, "")).join(" ");
  const expected = Number(/Expect EXACTLY (\d+) survivor/.exec(sql)?.[1] ?? 0);
  return { got: db.prepare(query).all().length, expected };
}

function run(extraArgs, label, rowsInDump = dump) {
  const dir = mkdtempSync(join(tmpdir(), "number-split-985-"));
  const dumpPath = join(dir, "dump.json");
  const sqlPath = join(dir, "out.sql");
  writeFileSync(dumpPath, JSON.stringify(rowsInDump), "utf8");
  try {
    try {
      execFileSync(
      process.execPath,
        [scriptPath, dumpPath, "--out", sqlPath, "--force", ...extraArgs],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e) {
      // The unlocked row's repair + the locked row's skip: no refusals, so this should exit 0.
      console.error(e.stdout, e.stderr);
      throw new Error(`${label}: CLI exited non-zero unexpectedly`);
    }
    return readFileSync(sqlPath, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Rows production holds outside the dump: another book that still matches the
// GLOB, and the scanned book in another resource. The documented workflow
// dumps one book and resource in SQL and runs the CLI with no flags, so the
// survivor query must not count these.
const outside = [
  { ...row(CANDIDATES.find((b) => b !== LOCKED && b !== UNLOCKED), 1) },
  { ...row(UNLOCKED, 1), bible_version: "UST" },
];
const pairList = (books) => books.map((b) => `'${b}/ULT'`).sort().join(", ");

console.log(`no --book/--bible-version filter: survivor query covers the dump's pairs, not ${UNLOCKED} alone and not the whole table`);
{
  const sql = run([], "unfiltered");
  assert(sql.includes("Expect EXACTLY 1 survivor(s)"), `header expects exactly the 1 ${LOCKED} survivor`);
  const glob = sql.split("plain_text GLOB")[1].split("ORDER BY")[0];
  assert(glob.includes(`IN (${pairList([LOCKED, UNLOCKED])})`), `survivor SELECT scopes to both scanned pairs (got: ${glob})`);
  const { got, expected } = survivorsAfterApply(sql, outside);
  assert(got === expected && got === 1, `after apply, the header's survivor query returns what it expects (got ${got}, expected ${expected})`);
}

console.log(`\n--book ${UNLOCKED},${LOCKED}: same scope as the unfiltered run`);
{
  const sql = run(["--book", `${UNLOCKED},${LOCKED}`], "book-filtered");
  const { got, expected } = survivorsAfterApply(sql, outside);
  assert(got === expected && got === 1, `after apply, the header's survivor query returns what it expects (got ${got}, expected ${expected})`);
}

console.log(`\n--book ${UNLOCKED}: the ${LOCKED} row was not scanned, so it is neither expected nor counted`);
{
  const sql = run(["--book", UNLOCKED], "one-book");
  assert(sql.includes("Expect 0 survivors"), "header expects 0 survivors");
  const { got } = survivorsAfterApply(sql, outside);
  assert(got === 0, `after apply, the header's survivor query returns 0 (got ${got})`);
}

// Issue #1191: a row the transform calls `clean` (no tree defect) can still match
// the survivor GLOB. "5, 1000" is the case: DETECT_RE requires (?!\d) after the
// three digits so it is not a defect, but the GLOB has no such guard. The row
// keeps matching after apply, so the header must count it as an expected survivor.
console.log("\na clean row whose plain_text matches the GLOB (\"5, 1000\") is an expected survivor");
{
  const cleanRow = {
    ...row(UNLOCKED, 1),
    verse: 2,
    content_json: JSON.stringify({ verseObjects: [{ type: "text", text: "There were 5, 1000 men." }] }),
    plain_text: "There were 5, 1000 men.",
  };
  const nullPlain = { ...cleanRow, verse: 3, plain_text: null };
  const mixed = [row(UNLOCKED, 1), cleanRow, nullPlain, row(LOCKED, 1)];
  const sql = run([], "clean-glob", mixed);
  const { got, expected } = survivorsAfterApply(sql, outside, mixed);
  assert(got === 2 && expected === 2, `header expects the locked row + the clean GLOB-only row (got ${got}, expected ${expected})`);
  assert(sql.includes("no tree defect (GLOB-only match)"), "the clean row is listed under EXPECTED SURVIVORS with its reason");
}

console.log("\na repaired row that keeps a GLOB-only match (\"3, 000 ... 5, 1000\") is an expected survivor");
{
  const both = {
    ...row(UNLOCKED, 1),
    verse: 4,
    content_json: JSON.stringify({ verseObjects: [{ type: "text", text: "There were 3, 000 men and 5, 1000 horses." }] }),
    plain_text: "There were 3, 000 men and 5, 1000 horses.",
  };
  const mixed = [row(UNLOCKED, 1), both, row(LOCKED, 1)];
  const sql = run([], "repaired-glob", mixed);
  const { got, expected } = survivorsAfterApply(sql, outside, mixed);
  assert(got === 2 && expected === 2, `header expects the locked row + the repaired row's leftover match (got ${got}, expected ${expected})`);
  assert(sql.includes("repaired; GLOB-only match left"), "the repaired row is listed under EXPECTED SURVIVORS with its reason");
}

console.log(`\nrepair-number-split-verses: all ${passed} assertions passed`);
