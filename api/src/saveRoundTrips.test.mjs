// Issue #905: the hot save routes (row PATCH, row create, verse PATCH) fold
// their read-only pre-checks — book lock, current row/verse, active pipeline —
// into ONE db.batch(), and replace the post-write re-SELECT with RETURNING.
// This file pins every invariant that change had to keep:
//   - latest_source in the PATCH response is what selectRowWithLatestSource's
//     edit_log subquery computes after the write (not just "some value");
//   - 409 (version mismatch on a live row) vs 404 (missing / soft-deleted);
//   - 423 book lock still fires before ANY write, on all three routes, and
//     bookLockGuard still gates the non-hot writes it always did;
//   - the AI-pipeline 409 still fires (tq) and still respects chapter scope;
//   - response bodies are byte-identical to the old re-SELECT shapes;
//   - the round-trip count actually dropped.
//
// Run from api/ (needs the sqlite flag and the resolve hook, since rows.ts /
// verses.ts import their siblings extensionless):
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/saveRoundTrips.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { rows } from "./rows.ts";
import { verses } from "./verses.ts";
import { bookLockGuard, isSelfLockCheckedRoute } from "./bookLockGuard.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// D1 shim over node:sqlite that also counts D1 round trips: every standalone
// first()/all()/run() is one, and a whole batch() is one. Like real D1, a
// row-returning statement (SELECT, or DML with RETURNING) carries `results`.
function makeDb(sqlite, stats) {
  const returnsRows = (sql) => /^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql);
  const exec = (sql, args) => {
    stats.sql.push(sql);
    if (returnsRows(sql)) {
      const results = sqlite.prepare(sql).all(...args);
      const changes = /^\s*(SELECT|WITH)\b/i.test(sql) ? 0 : results.length;
      return { results, success: true, meta: { changes } };
    }
    const r = sqlite.prepare(sql).run(...args);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  const mk = (sql, args) => ({
    sql,
    args,
    bind: (...a) => mk(sql, a),
    _exec: () => exec(sql, args),
    async all() {
      stats.roundTrips++;
      return exec(sql, args);
    },
    async first() {
      stats.roundTrips++;
      const r = exec(sql, args).results;
      return r.length ? r[0] : null;
    },
    async run() {
      stats.roundTrips++;
      return exec(sql, args);
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      // The post-save lane reopen (laneReopen.ts) is counted apart: it is not
      // a save pre-check or write, and for rows it runs in waitUntil, off the
      // response's critical path.
      if (stmts.some((s) => /verse_lane_checks/.test(s.sql))) stats.laneReopen++;
      else stats.roundTrips++;
      // Real D1 runs a batch as one transaction.
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => s._exec());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const BOOK = "JER";

function freshApp() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();

  const app = new Hono();
  // Stand in for attachAuth — requireEditor / bookLockGuard read these.
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    c.set("username", "translator");
    await next();
  });
  // Mounted exactly as index.ts mounts it for these route groups.
  app.use("/api/verses/:book/*", bookLockGuard);
  app.use("/api/rows/*", bookLockGuard);
  app.route("/api/rows", rows);
  app.route("/api/verses", verses);

  const stats = { roundTrips: 0, laneReopen: 0, sql: [] };
  const env = { DB: makeDb(sqlite, stats) };
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const req = async (method, path, body, ifMatch) => {
    stats.roundTrips = 0;
    stats.laneReopen = 0;
    stats.sql = [];
    const headers = { "content-type": "application/json" };
    if (ifMatch != null) headers["if-match"] = String(ifMatch);
    const res = await app.request(
      path,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      env,
      ctx,
    );
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json, roundTrips: stats.roundTrips, sql: [...stats.sql] };
  };
  return { sqlite, req };
}

// Seed: a chapter's verses (ULT 1:1, 1:2) so creates pass the chapter probe,
// one tn row with an AI-sourced audit entry, one tq row, one twl row.
function seed(sqlite) {
  for (const v of [1, 2]) {
    sqlite
      .prepare(
        `INSERT INTO verses (book, chapter, verse, bible_version, content_json, plain_text, version)
         VALUES (?, 1, ?, 'ULT', ?, ?, 3)`,
      )
      .run(BOOK, v, JSON.stringify({ verseObjects: [{ type: "text", text: `Verse ${v} text.` }] }), `Verse ${v} text.`);
  }
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version)
       VALUES ('tn01', ?, 1, 1, '1:1', 'AI wrote this.', 100, 4)`,
    )
    .run(BOOK);
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
       VALUES ('tn', 'tn01', ?, NULL, 3, 4, 'update', '{}', 'ai_pipeline')`,
    )
    .run(BOOK);
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version)
       VALUES ('tq01', ?, 1, 1, '1:1', 'Who?', 'Jeremiah.', 2)`,
    )
    .run(BOOK);
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
       VALUES ('tq', 'tq01', ?, NULL, 1, 2, 'update', '{}', 'ai_pipeline')`,
    )
    .run(BOOK);
  sqlite
    .prepare(
      `INSERT INTO twl_rows (id, book, chapter, verse, ref_raw, orig_words, occurrence, tw_link, sort_order, version)
       VALUES ('tw01', ?, 1, 1, '1:1', 'word', 1, 'rc://*/tw/dict/bible/kt/god', 100, 1)`,
    )
    .run(BOOK);
}

// Exactly the SQL selectRowWithLatestSource runs — the oracle the PATCH
// response's latest_source must match after the write.
const rowWithLatestSource = (sqlite, kind, id) =>
  sqlite
    .prepare(
      `SELECT t.*, (
         SELECT source FROM edit_log
          WHERE kind = ?3 AND row_key = t.id
            AND (book = t.book OR book IS NULL)
          ORDER BY id DESC LIMIT 1
       ) AS latest_source
          FROM ${kind}_rows t
         WHERE t.id = ?1 AND book = ?2`,
    )
    .all(id, BOOK, kind)[0];
const plainRow = (sqlite, kind, id) =>
  sqlite.prepare(`SELECT * FROM ${kind}_rows WHERE id = ? AND book = ?`).all(id, BOOK)[0];
const logCount = (sqlite) => sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log`).all()[0].n;
const bookLockReads = (sql) => sql.filter((s) => /FROM book_locks/.test(s)).length;

console.log("\n[tn PATCH: latest_source in the response is the post-write edit_log truth]");
{
  const { sqlite, req } = freshApp();
  seed(sqlite);
  eq(rowWithLatestSource(sqlite, "tn", "tn01").latest_source, "ai_pipeline", "precondition: the row carries an AI chip");

  const res = await req("PATCH", `/api/rows/tn/tn01?book=${BOOK}`, { note: "A human rewrite." }, 4);
  eq(res.status, 200, "content edit is accepted");
  const oracle = rowWithLatestSource(sqlite, "tn", "tn01");
  eq(oracle.latest_source, null, "oracle: a human content edit clears the AI chip");
  eq(res.json, oracle, "response is byte-identical (keys, order, values) to the old selectRowWithLatestSource re-read");
  eq(res.json.version, 5, "version bumped");
  eq(res.roundTrips, 2, "row PATCH costs 2 D1 round trips (pre-check batch + write batch), was 4 for tn");
  eq(bookLockReads(res.sql), 1, "book_locks read exactly once — the middleware skipped this route, the handler batched it");
  eq(
    res.sql.some((s) => /^\s*SELECT t\.\*/.test(s) && res.sql.indexOf(s) > res.sql.findIndex((x) => /^\s*UPDATE tn_rows/.test(x))),
    false,
    "no post-write re-SELECT",
  );
}

console.log("\n[tn PATCH no-op: returns the pre-check row, latest_source intact]");
{
  const { sqlite, req } = freshApp();
  seed(sqlite);
  const res = await req("PATCH", `/api/rows/tn/tn01?book=${BOOK}`, { note: "AI wrote this." }, 4);
  eq(res.status, 200, "no-op save accepted");
  eq(res.json, rowWithLatestSource(sqlite, "tn", "tn01"), "response equals the row with latest_source");
  eq(res.json.latest_source, "ai_pipeline", "AI chip survives a no-op save");
  eq(res.roundTrips, 1, "no-op PATCH is one round trip");
}

console.log("\n[tn reorder-only PATCH: latest_source unchanged]");
{
  const { sqlite, req } = freshApp();
  seed(sqlite);
  const res = await req("PATCH", `/api/rows/tn/tn01?book=${BOOK}`, { sort_order: 250 }, 4);
  eq(res.status, 200, "reorder accepted");
  eq(res.json.latest_source, "ai_pipeline", "a drag does not clear the AI chip");
  eq(res.json, rowWithLatestSource(sqlite, "tn", "tn01"), "response equals the row with latest_source");
}

console.log("\n[409 vs 404 disambiguation]");
{
  const { sqlite, req } = freshApp();
  seed(sqlite);
  const before = logCount(sqlite);
  const stale = await req("PATCH", `/api/rows/tn/tn01?book=${BOOK}`, { note: "Stale edit." }, 3);
  eq(stale.status, 409, "version mismatch on an existing row is 409, not 404");
  eq(stale.json.error, "version_mismatch", "409 body error");
  eq(stale.json.current, plainRow(sqlite, "tn", "tn01"), "409 body carries the current row");
  eq(plainRow(sqlite, "tn", "tn01").note, "AI wrote this.", "stale write did not land");
  eq(logCount(sqlite), before, "no orphan audit row on a mismatch");

  const missing = await req("PATCH", `/api/rows/tn/nope?book=${BOOK}`, { note: "x" }, 1);
  eq(missing.status, 404, "missing row is 404, not 409");
  eq(missing.json, { error: "not_found" }, "404 body");

  sqlite.prepare(`UPDATE tn_rows SET deleted_at = 1 WHERE id = 'tn01'`).run();
  const gone = await req("PATCH", `/api/rows/tn/tn01?book=${BOOK}`, { note: "x" }, 4);
  eq(gone.status, 404, "soft-deleted row is 404");

  // Race: the row moves on AFTER the pre-check batch read it but before the
  // write batch — the CAS in the UPDATE (not the pre-read) must produce 409.
  const { sqlite: s2, req: req2 } = freshApp();
  seed(s2);
  const origPrepare = s2.prepare.bind(s2);
  let bumped = false;
  s2.prepare = (sql) => {
    if (!bumped && /^\s*UPDATE tn_rows/.test(sql)) {
      bumped = true;
      origPrepare(`UPDATE tn_rows SET version = 5, note = 'Racer' WHERE id = 'tn01'`).run();
    }
    return origPrepare(sql);
  };
  const beforeRace = logCount(s2);
  const raced = await req2("PATCH", `/api/rows/tn/tn01?book=${BOOK}`, { note: "Loser." }, 4);
  eq(raced.status, 409, "a write racing past the pre-check still 409s via the UPDATE's version CAS");
  eq(raced.json.current.version, 5, "409 carries the racer's version");
  eq(origPrepare(`SELECT note FROM tn_rows WHERE id = 'tn01'`).all()[0].note, "Racer", "racer's content survives");
  eq(logCount(s2), beforeRace, "edit_log INSERT stayed gated on changes() > 0");
}

console.log("\n[blank-note guard still runs before the write]");
{
  const { sqlite, req } = freshApp();
  seed(sqlite);
  const res = await req("PATCH", `/api/rows/tn/tn01?book=${BOOK}`, { note: "" }, 4);
  eq(res.status, 422, "blanking a substantive note is refused");
  eq(plainRow(sqlite, "tn", "tn01").version, 4, "no write");
}

console.log("\n[tq PATCH: pipeline lock from the batched read, chapter-scoped]");
{
  const { sqlite, req } = freshApp();
  seed(sqlite);
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state)
       VALUES ('j-other', 9, 'tqs', ?, 2, 3, 'k', 'running')`,
    )
    .run(BOOK);
  const ok = await req("PATCH", `/api/rows/tq/tq01?book=${BOOK}`, { question: "Who spoke?" }, 2);
  eq(ok.status, 200, "a tqs run on OTHER chapters does not lock chapter 1");
  eq(ok.json, rowWithLatestSource(sqlite, "tq", "tq01"), "tq response equals the row with latest_source");
  eq(ok.json.latest_source, null, "tq human edit clears the AI chip");
  eq(ok.roundTrips, 2, "tq PATCH costs 2 D1 round trips, was 5");

  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, created_at)
       VALUES ('j-here', 9, 'tqs', ?, 1, 1, 'k', 'running', 5)`,
    )
    .run(BOOK);
  const locked = await req("PATCH", `/api/rows/tq/tq01?book=${BOOK}`, { question: "Again?" }, 3);
  eq(locked.status, 409, "a tqs run covering chapter 1 locks it");
  eq(locked.json.error, "chapter_locked", "chapter_locked body");
  eq(locked.json.jobId, "j-here", "names the covering job");
  eq(plainRow(sqlite, "tq", "tq01").version, 3, "no write while locked");
}

console.log("\n[twl PATCH: RETURNING * shape, no latest_source key]");
{
  const { sqlite, req } = freshApp();
  seed(sqlite);
  const res = await req("PATCH", `/api/rows/twl/tw01?book=${BOOK}`, { tags: "keyterm" }, 1);
  eq(res.status, 200, "twl edit accepted");
  eq(res.json, plainRow(sqlite, "twl", "tw01"), "twl response equals SELECT * byte-for-byte");
  eq("latest_source" in res.json, false, "twl carries no latest_source");
}

console.log("\n[row create: batched pre-checks + INSERT RETURNING]");
{
  const { sqlite, req } = freshApp();
  seed(sqlite);
  const res = await req("POST", `/api/rows/tn`, { book: "jer", chapter: 1, verse: 1, ref_raw: "1:1", note: "New." });
  eq(res.status, 201, "create accepted");
  eq(res.json, plainRow(sqlite, "tn", res.json.id), "create response equals SELECT * byte-for-byte");
  eq(res.json.sort_order, 200, "sort_order defaulted to max+100 from the batched read");
  eq(res.roundTrips, 2, "create costs 2 D1 round trips, was 6 (lock, chapter probe, pipeline, max sort_order, insert, re-read)");

  const bad = await req("POST", `/api/rows/tn`, { book: BOOK, chapter: 99, verse: 1, ref_raw: "99:1", note: "x" });
  eq(bad.status, 404, "unknown chapter still 404");
  eq(bad.json, { error: "not_found", reason: "unknown_chapter" }, "404 body");

  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state)
       VALUES ('j-notes', 9, 'notes', ?, 1, 1, 'k', 'running')`,
    )
    .run(BOOK);
  const lockedCreate = await req("POST", `/api/rows/tn`, { book: BOOK, chapter: 1, verse: 2, ref_raw: "1:2", note: "x" });
  eq(lockedCreate.status, 409, "notes run locks tn creates");
  eq(lockedCreate.json.error, "chapter_locked", "chapter_locked body");
}

console.log("\n[book lock: 423 before any write, on every hot route; guard still gates the rest]");
{
  const { sqlite, req } = freshApp();
  seed(sqlite);
  sqlite.prepare(`INSERT INTO book_locks (book, locked, reason) VALUES (?, 1, 'frozen')`).run(BOOK);
  const body423 = { error: "book_locked", book: BOOK, reason: "frozen", source: "explicit" };
  const before = logCount(sqlite);

  const p = await req("PATCH", `/api/rows/tn/tn01?book=${BOOK}`, { note: "x" }, 4);
  eq([p.status, p.json], [423, body423], "row PATCH → 423 with the book_locked body");
  eq(p.sql.some((s) => /^\s*(UPDATE|INSERT|DELETE)/i.test(s)), false, "row PATCH issued no mutating statement");
  const noIfMatch = await req("PATCH", `/api/rows/tn/tn01?book=${BOOK}`, { note: "x" });
  eq(noIfMatch.status, 423, "423 still precedes the 428 If-Match check, as with the middleware");

  const cr = await req("POST", `/api/rows/tn`, { book: BOOK, chapter: 1, verse: 1, ref_raw: "1:1", note: "x" });
  eq([cr.status, cr.json], [423, body423], "row create → 423");
  eq(cr.sql.some((s) => /^\s*(UPDATE|INSERT|DELETE)/i.test(s)), false, "row create issued no mutating statement");

  const vp = await req(
    "PATCH",
    `/api/verses/${BOOK}/1/1/ULT`,
    { content: { verseObjects: [{ type: "text", text: "x" }] }, plain_text: "x" },
    3,
  );
  eq([vp.status, vp.json], [423, body423], "verse PATCH → 423");
  eq(vp.sql.some((s) => /^\s*(UPDATE|INSERT|DELETE)/i.test(s)), false, "verse PATCH issued no mutating statement");

  eq(logCount(sqlite), before, "no audit rows written");
  eq(plainRow(sqlite, "tn", "tn01").version, 4, "tn row untouched");

  const pres = await req("POST", `/api/rows/tn/tn01/preserve?book=${BOOK}`, { preserved: true });
  eq(pres.status, 423, "non-hot write (/preserve) still 423s via bookLockGuard");

  // A published-default book is locked with no book_locks row at all.
  const pub = await req("PATCH", `/api/verses/ZEC/1/1/ULT`, { content: { verseObjects: [{ type: "text", text: "x" }] } }, 1);
  eq([pub.status, pub.json.source], [423, "published"], "published-default lock still applies to verse PATCH");
}

console.log("\n[verse PATCH: batched pre-checks + UPDATE RETURNING]");
{
  const { sqlite, req } = freshApp();
  seed(sqlite);
  const content = { verseObjects: [{ type: "text", text: "Verse 1 text, revised." }] };
  const res = await req("PATCH", `/api/verses/${BOOK}/1/1/ULT`, { content, plain_text: "Verse 1 text, revised." }, 3);
  eq(res.status, 200, "verse edit accepted");
  const row = sqlite.prepare(`SELECT * FROM verses WHERE book = ? AND chapter = 1 AND verse = 1 AND bible_version = 'ULT'`).all(BOOK)[0];
  eq(res.json, { ...row, content: JSON.parse(row.content_json) }, "response equals the old SELECT * re-read + parsed content");
  eq(res.json.version, 4, "version bumped");
  // Save-path round trips only; reopenLaneChecks' own DELETE batch (awaited
  // by design, #931) is unchanged by #905 and counted separately by the shim.
  eq(res.sql.filter((s) => /^\s*SELECT \* FROM verses/.test(s)).length, 1, "verses read once (pre-check), no post-write re-SELECT");
  eq(res.roundTrips, 2, "verse PATCH save path costs 2 D1 round trips (pre-check batch + write batch), was 5");

  const stale = await req("PATCH", `/api/verses/${BOOK}/1/1/ULT`, { content, plain_text: "x" }, 3);
  eq(stale.status, 409, "stale verse save is 409");
  eq(stale.json.error, "version_mismatch", "409 body");
  eq(stale.json.current.version, 4, "409 carries current");

  const missing = await req("PATCH", `/api/verses/${BOOK}/1/7/ULT`, { content, plain_text: "x" }, 1);
  eq(missing.status, 404, "missing verse is 404");

  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state)
       VALUES ('j-gen', 9, 'generate', ?, 1, 1, 'k', 'running')`,
    )
    .run(BOOK);
  const locked = await req("PATCH", `/api/verses/${BOOK}/1/1/ULT`, { content, plain_text: "x" }, 4);
  eq([locked.status, locked.json.error], [409, "chapter_locked"], "generate run locks verse writes");
}

console.log("\n[isSelfLockCheckedRoute matches exactly the three hot routes]");
{
  eq(isSelfLockCheckedRoute("PATCH", "/api/rows/tn/ab12"), true, "row PATCH");
  eq(isSelfLockCheckedRoute("POST", "/api/rows/tn"), true, "row create");
  eq(isSelfLockCheckedRoute("PATCH", "/api/verses/JER/1/2/ULT"), true, "verse PATCH");
  eq(isSelfLockCheckedRoute("DELETE", "/api/rows/tn/ab12"), false, "row DELETE stays guarded");
  eq(isSelfLockCheckedRoute("POST", "/api/rows/tn/ab12/preserve"), false, "/preserve stays guarded");
  eq(isSelfLockCheckedRoute("POST", "/api/verses/JER/1/2/ULT/bridge"), false, "/bridge stays guarded");
  eq(isSelfLockCheckedRoute("PATCH", "/api/rows/tn/ab12/"), false, "trailing slash stays guarded");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nsaveRoundTrips.test.mjs: all assertions passed");
