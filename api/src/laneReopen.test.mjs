// Smoke test for lanesToReopenOnVerseEdit — the pure decision behind which
// verse_lane_checks lanes a content save reopens. Run from api/:
//   node --experimental-strip-types --no-warnings src/laneReopen.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors sortOrder.test.mjs.
//
// Regression: a tiny ULT edit (a comma after "Gilgal", a moved `{…}` brace)
// used to reopen the 'tw' (Words) lane and clear the Board checkoff even though
// no word changed. It must now reopen only 'text' for such edits (HOS 12:11 /
// HOS 8 report from Beth Oakes).

import { DatabaseSync } from "node:sqlite";
import {
  lanesToReopenOnVerseEdit,
  lanesForAdoption,
  reopenLaneChecks,
  reopenLaneChecksBulk,
} from "./laneReopen.ts";

let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n    expected ${e}\n    got      ${a}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

console.log("\n[lanesToReopenOnVerseEdit]");

// ULT punctuation-only edit (comma / brace / whitespace): word sequence
// unchanged → Words stays checked, only Text reopens.
eq(
  lanesToReopenOnVerseEdit("ULT", true),
  ["text"],
  "ULT comma/brace edit (wordSequenceUnchanged) reopens only 'text'",
);

// ULT real word edit: a word changed → Words reopens too ("trickles down").
eq(
  lanesToReopenOnVerseEdit("ULT", false),
  ["text", "tw"],
  "ULT word edit (wordSequence changed) reopens 'text' and 'tw'",
);

// UST edits never touch the Words lane, regardless of word changes.
eq(
  lanesToReopenOnVerseEdit("UST", false),
  ["text"],
  "UST word edit reopens only 'text'",
);
eq(
  lanesToReopenOnVerseEdit("UST", true),
  ["text"],
  "UST punctuation edit reopens only 'text'",
);

console.log("\n[lanesForAdoption]");

// FIX 4 regression, reviewer's exact probe: D1 stores "and"/"the" as two
// separate \w nodes with a bare whitespace text node between them; master's
// adopted content fuses them into one \w node covering "and the". Plain
// text is identical ("and the") on both sides, but the \w TOKENIZATION
// differs (2 word nodes vs 1) — a glue/de-glue shape, not a real word edit.
{
  const w = (text) => JSON.stringify({ type: "word", tag: "w", text, occurrence: "1", occurrences: "1" });
  const t = (text) => JSON.stringify({ type: "text", text });
  const beforeContentJson = `{"verseObjects":[${w("and")},${t(" ")},${w("the")}]}`;
  const afterContentJson = `{"verseObjects":[${w("and the")}]}`;
  const beforePlainText = "and the";
  const afterPlainText = "and the";

  eq(
    lanesForAdoption("ULT", beforePlainText, afterPlainText, beforeContentJson, afterContentJson),
    ["tw"],
    "de-glue-shaped adoption (identical plain text, changed \\w tokenization) reopens 'tw' but not 'text'",
  );

  // Contrast case: plain text AND word sequence both genuinely unchanged
  // (identical content_json) — neither lane should reopen.
  eq(
    lanesForAdoption("ULT", beforePlainText, beforePlainText, beforeContentJson, beforeContentJson),
    [],
    "genuinely unchanged-text adoption (identical content_json) reopens neither lane",
  );

  // UST never touches 'tw', even for the same de-glue shape.
  eq(
    lanesForAdoption("UST", beforePlainText, afterPlainText, beforeContentJson, afterContentJson),
    [],
    "UST de-glue-shaped adoption reopens neither lane ('tw' never applies to UST, and plain text is unchanged)",
  );

  // A genuine word-boundary change (different plain text, different word
  // sequence) reopens both lanes on ULT.
  const changedContentJson = `{"verseObjects":[${w("and the")},${t(" ")},${w("dog")}]}`;
  eq(
    lanesForAdoption("ULT", beforePlainText, "and the dog", beforeContentJson, changedContentJson),
    ["text", "tw"],
    "genuine word-boundary change reopens both 'text' and 'tw' on ULT",
  );
}

console.log("\n[#686 item 3: reopenLaneChecks / reopenLaneChecksBulk leave an edit_log audit trail]");
{
  // Minimal D1 shim over node:sqlite — same shape twlSortOrderApply.test.mjs
  // uses. Both functions here only need .prepare().bind().run() via .batch().
  function makeDb(sqlite) {
    const mk = (sql, args) => ({
      sql,
      args,
      bind: (...a) => mk(sql, a),
      run() {
        const r = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes) } };
      },
    });
    return {
      prepare: (sql) => mk(sql, []),
      async batch(stmts) {
        const out = [];
        for (const s of stmts) out.push(s.run());
        return out;
      },
    };
  }

  function freshDb() {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE verse_lane_checks (
        book TEXT NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL,
        lane TEXT NOT NULL, checked_by INTEGER NOT NULL, checked_at INTEGER NOT NULL,
        PRIMARY KEY (book, chapter, verse, lane, checked_by)
      );
      CREATE TABLE edit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL, row_key TEXT NOT NULL, book TEXT,
        user_id INTEGER, prev_version INTEGER, new_version INTEGER,
        action TEXT NOT NULL, payload_json TEXT, source TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    return sqlite;
  }

  const BOOK = "ZEC";

  console.log("  reopenLaneChecks: a checkoff that actually clears gets exactly one edit_log row");
  {
    const sqlite = freshDb();
    sqlite
      .prepare(
        `INSERT INTO verse_lane_checks (book, chapter, verse, lane, checked_by, checked_at) VALUES (?, 8, 3, 'text', 42, 100)`,
      )
      .run(BOOK);
    const env = { DB: makeDb(sqlite) };
    await reopenLaneChecks(env, BOOK, 8, 3, ["text", "tw"], false);

    eq(sqlite.prepare(`SELECT COUNT(*) AS n FROM verse_lane_checks`).all()[0].n, 0, "the checkoff row was deleted");
    const logRows = sqlite
      .prepare(`SELECT kind, row_key, book, user_id, action, source, payload_json FROM edit_log`)
      .all();
    eq(logRows.length, 1, "exactly one edit_log row was written");
    eq(logRows[0].kind, "verse_lane", "kind is 'verse_lane'");
    eq(logRows[0].row_key, `${BOOK}/8/3`, "row_key is book/chapter/verse");
    eq(logRows[0].book, BOOK, "book column is stamped (previously omitted — #686 item 3)");
    eq(logRows[0].user_id, null, "user_id is NULL — a content-save side effect, not a user's own action");
    eq(logRows[0].source, "lane_reopen", "source is 'lane_reopen'");
    eq(JSON.parse(logRows[0].payload_json).lanes, ["text", "tw"], "payload records which lanes were reopened");
  }

  console.log("  reopenLaneChecks: a no-op reopen (nothing was checked) writes no edit_log row");
  {
    const sqlite = freshDb();
    const env = { DB: makeDb(sqlite) };
    await reopenLaneChecks(env, BOOK, 8, 3, ["text"], false);
    eq(sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log`).all()[0].n, 0, "no edit_log row when the DELETE matched nothing");
  }

  console.log("  reopenLaneChecksBulk: one edit_log row per verse actually cleared, none for a no-op verse");
  {
    const sqlite = freshDb();
    sqlite
      .prepare(
        `INSERT INTO verse_lane_checks (book, chapter, verse, lane, checked_by, checked_at) VALUES (?, 8, 3, 'text', 42, 100)`,
      )
      .run(BOOK);
    const env = { DB: makeDb(sqlite) };
    await reopenLaneChecksBulk(
      env,
      BOOK,
      [
        { chapter: 8, verse: 3, lanes: ["text"] },
        { chapter: 8, verse: 4, lanes: ["text"] }, // nothing checked here — must not log
      ],
      false,
    );
    const logRows = sqlite.prepare(`SELECT row_key, book, source FROM edit_log ORDER BY row_key`).all();
    eq(logRows.length, 1, "only the verse whose checkoff actually cleared got an edit_log row");
    eq(logRows[0].row_key, `${BOOK}/8/3`, "row_key names the cleared verse, not the no-op one");
    eq(logRows[0].book, BOOK, "book column is stamped");
    eq(logRows[0].source, "lane_reopen", "source is 'lane_reopen'");
  }

  console.log("  reopenLaneChecksBulk: a large adoption stays under D1's 100-statement batch cap (Codex #785 P1)");
  {
    // 60 verses, each with a live checkoff. Each entry emits TWO statements
    // (DELETE + audit INSERT), so one 60-entry slice would be 120 statements —
    // over D1's 100-statement cap. With a too-large REOPEN_WRITE_BATCH the whole
    // slice's batch is rejected and reopenLaneChecksBulk's catch swallows it,
    // leaving all 60 checkoffs signed off and unaudited.
    const sqlite = freshDb();
    for (let v = 1; v <= 60; v++) {
      sqlite
        .prepare(`INSERT INTO verse_lane_checks (book, chapter, verse, lane, checked_by, checked_at) VALUES (?, 9, ?, 'text', 42, 100)`)
        .run(BOOK, v);
    }
    // Shim whose batch() throws when a slice exceeds D1's 100-statement cap, the
    // way real D1 rejects an over-limit batch.
    const mk = (sql, args) => ({
      sql,
      args,
      bind: (...a) => mk(sql, a),
      run() {
        const r = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes) } };
      },
    });
    const env = {
      DB: {
        prepare: (sql) => mk(sql, []),
        async batch(stmts) {
          if (stmts.length > 100) throw new Error(`batch of ${stmts.length} exceeds D1's 100-statement cap`);
          const out = [];
          for (const s of stmts) out.push(s.run());
          return out;
        },
      },
    };
    const entries = [];
    for (let v = 1; v <= 60; v++) entries.push({ chapter: 9, verse: v, lanes: ["text"] });
    await reopenLaneChecksBulk(env, BOOK, entries, false);
    eq(
      sqlite.prepare(`SELECT COUNT(*) AS n FROM verse_lane_checks`).all()[0].n,
      0,
      "all 60 checkoffs reopened — no slice breached the 100-statement cap",
    );
    eq(sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log`).all()[0].n, 60, "all 60 reopens are audited");
  }
}

console.log("\n[#686 item 3 (remainder): verse_statuses.updated_by, migration 0069]");
{
  // Same SQL chapters.ts's status-toggle route runs (cross-checked against the
  // real source below) against real SQLite, proving the upsert branch actually
  // stamps updated_by on both a first toggle and a later re-toggle by a
  // different user — not just that the source text mentions the column.
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE verse_statuses (
      book TEXT NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL,
      done INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_by INTEGER,
      PRIMARY KEY (book, chapter, verse)
    );
  `);
  const toggle = (book, chapter, verse, done, now, userId) =>
    sqlite
      .prepare(
        `INSERT INTO verse_statuses (book, chapter, verse, done, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(book, chapter, verse) DO UPDATE SET done = ?4, updated_at = ?5, updated_by = ?6`,
      )
      .run(book, chapter, verse, done, now, userId);

  toggle("ZEC", 5, 3, 1, 100, 7);
  let row = sqlite.prepare(`SELECT done, updated_by FROM verse_statuses WHERE book='ZEC' AND chapter=5 AND verse=3`).get();
  eq(row.done, 1, "first toggle sets done");
  eq(row.updated_by, 7, "first toggle stamps the toggling user");

  toggle("ZEC", 5, 3, 0, 200, 9);
  row = sqlite.prepare(`SELECT done, updated_by FROM verse_statuses WHERE book='ZEC' AND chapter=5 AND verse=3`).get();
  eq(row.done, 0, "re-toggle by a different user updates done");
  eq(row.updated_by, 9, "re-toggle overwrites updated_by with the new toggling user, not the original");
}

console.log("\n[#686 item 3, source check] chapters.ts's three edit_log INSERTs (verse_status, verse_lane x2) carry book");
{
  // chapters.ts imports Hono (routes), so it cannot be driven directly under
  // plain `node --experimental-strip-types` (STATE.md: "a module that imports
  // hono cannot be unit-tested") — same limitation rowProvenanceStamps.test.mjs
  // documents for rows.ts/bookImport.ts. Assert the SOURCE TEXT instead: this
  // proves the three edit_log writes are wired to stamp book, not that they
  // land correctly at runtime.
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const chaptersTs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "chapters.ts"), "utf8");

  const withBook = "INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)";
  const withoutBook = "INSERT INTO edit_log (kind, row_key, user_id, prev_version, new_version, action, payload_json)";
  const occurrences = chaptersTs.split(withBook).length - 1;
  eq(occurrences, 3, "[source] all 3 edit_log INSERTs (verse_status, single lane, bulk lane) include the book column");
  eq(chaptersTs.includes(withoutBook), false, "[source] no edit_log INSERT in chapters.ts still omits book");

  // #686 item 3 (remainder, migration 0069): the verse_statuses row itself
  // had no actor column at all — PR #785 explicitly deferred this half.
  // Same source-text limitation as above; assert the toggle route stamps
  // updated_by on both the insert and the upsert branch.
  const statusInsert = "INSERT INTO verse_statuses (book, chapter, verse, done, updated_at, updated_by)";
  const statusUpsert = "ON CONFLICT(book, chapter, verse) DO UPDATE SET done = ?4, updated_at = ?5, updated_by = ?6";
  eq(chaptersTs.includes(statusInsert), true, "[source] verse_statuses INSERT stamps updated_by");
  eq(chaptersTs.includes(statusUpsert), true, "[source] verse_statuses upsert branch stamps updated_by");
  eq(chaptersTs.includes(".bind(book, chapter, verse, done, now, userId)"), true, "[source] the insert binds userId as updated_by");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll laneReopen assertions passed.");
