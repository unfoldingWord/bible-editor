// Issue #1165: a verse-range notes run (#1160) locks only the notes it can
// touch. The range import stages, applies and sweeps by ANCHOR verse inside the
// range (pipelineImport.ts), so a note anchored outside it is never read or
// written by the run and stays editable. Everything else keeps the whole-chapter
// lock: other resources, whole-chapter runs, and any job whose stored range
// cannot be read (fail closed).
//
// Driven through the REAL rows router against the REAL migration schema.
// Run from api/:
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/tnRangeLock.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { rows } from "./rows.ts";
import { tnLockVerseRange } from "./chapterLock.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function makeDb(sqlite) {
  const exec = (sql, args) => {
    if (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql)) {
      return { results: sqlite.prepare(sql).all(...args), success: true, meta: { changes: 0 } };
    }
    const r = sqlite.prepare(sql).run(...args);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  const mk = (sql, args) => ({
    sql,
    bind: (...a) => mk(sql, a),
    _exec: () => exec(sql, args),
    async all() { return exec(sql, args); },
    async first() { const r = exec(sql, args).results; return r.length ? r[0] : null; },
    async run() { return exec(sql, args); },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
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
const CH = 36;
const RANGE = JSON.stringify({ verseRange: { start: 10, end: 15 } });

function freshApp() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, bible_version, content_json, plain_text, version)
       VALUES (?, ?, 1, 'ULT', '{"verseObjects":[]}', '', 1)`,
    )
    .run(BOOK, CH);
  const tn = (id, verse, ref = `${CH}:${verse}`) =>
    sqlite
      .prepare(
        `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, updated_by)
         VALUES (?, ?, ?, ?, ?, 'a note', 100, 1, 9)`,
      )
      .run(id, BOOK, CH, verse, ref);
  tn("n3", 3);
  tn("n4", 4);
  tn("n12", 12);
  tn("n13", 13);
  tn("nbr", 9, `${CH}:9-11`); // a bridge anchored before the range, reaching into it
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version)
       VALUES ('q3', ?, ?, 3, '36:3', 'Who?', 'Baruch.', 1)`,
    )
    .run(BOOK, CH);

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    c.set("username", "translator");
    await next();
  });
  app.route("/api/rows", rows);
  const env = { DB: makeDb(sqlite) };
  const ctx = { waitUntil(p) { if (p && typeof p.catch === "function") p.catch(() => {}); }, passThroughOnException() {} };
  const req = async (method, path, body, ifMatch) => {
    const headers = { "content-type": "application/json" };
    if (ifMatch != null) headers["if-match"] = String(ifMatch);
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env, ctx);
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const job = (id, type, optionsJson = null, { state = "running", chain = null, start = CH, end = CH } = {}) =>
    sqlite
      .prepare(
        `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, options_json, follow_up_chain)
         VALUES (?, 9, ?, ?, ?, ?, 'k', ?, ?, ?)`,
      )
      .run(id, type, BOOK, start, end, state, optionsJson, chain);
  const row = (kind, id) => sqlite.prepare(`SELECT * FROM ${kind}_rows WHERE id = ? AND book = ?`).all(id, BOOK)[0];
  const createTn = (verse) =>
    req("POST", `/api/rows/tn`, { book: BOOK, chapter: CH, verse, ref_raw: `${CH}:${verse}`, note: "" });
  const del = (kind, id) => req("DELETE", `/api/rows/${kind}/${id}?book=${BOOK}`, undefined, row(kind, id).version);
  const patch = (id, body) => req("PATCH", `/api/rows/tn/${id}?book=${BOOK}`, body, row("tn", id).version);
  return { sqlite, req, job, row, createTn, del, patch };
}

const ok = (s) => s === 200 || s === 201;

console.log("\n[tnLockVerseRange: which jobs narrow the tn lock]");
{
  const base = { pipeline_type: "notes", follow_up_chain: null, start_chapter: CH, end_chapter: CH, options_json: RANGE };
  eq(tnLockVerseRange(base), { start: 10, end: 15 }, "one-chapter notes job with a valid range → that range");
  eq(tnLockVerseRange({ ...base, options_json: null }), null, "no options → whole chapter");
  eq(tnLockVerseRange({ ...base, options_json: JSON.stringify({ verseRange: { start: 15, end: 10 } }) }), null, "invalid range → whole chapter (fail closed)");
  eq(tnLockVerseRange({ ...base, options_json: "{not json" }), null, "unparseable options → whole chapter (fail closed)");
  eq(tnLockVerseRange({ ...base, pipeline_type: "tqs" }), null, "not a notes job → whole chapter");
  eq(tnLockVerseRange({ ...base, follow_up_chain: '[{"pipelineType":"tqs"}]' }), null, "a job with a chain → whole chapter");
  eq(tnLockVerseRange({ ...base, end_chapter: CH + 1 }), null, "a multi-chapter job → whole chapter");
}

console.log("\n[range 10-15 notes run: only notes anchored in 10-15 are locked]");
{
  const { job, row, createTn, del, patch } = freshApp();
  job("j-range", "notes", RANGE);

  const c3 = await createTn(3);
  eq(ok(c3.status), true, "POST a note at verse 3 (outside the range) succeeds");
  const c12 = await createTn(12);
  eq([c12.status, c12.json?.error, c12.json?.jobId], [409, "chapter_locked", "j-range"], "POST a note at verse 12 (inside) is refused chapter_locked");
  const c0 = await createTn(0);
  eq(ok(c0.status) || c0.status === 400, true, "verse 0 (intro) is outside every range: not refused as chapter_locked");

  eq(ok((await patch("n3", { note: "edited at 3" })).status), true, "PATCH a note at verse 3 succeeds");
  eq(row("tn", "n3").note, "edited at 3", "…and the edit landed");
  eq(ok((await patch("n12", { note: "edited at 12" })).status), true, "PATCH content of a note at verse 12 still succeeds (the tn PATCH carve-out is unchanged: an edit makes the note kept)");

  const mv = await patch("n4", { verse: 12, ref_raw: `${CH}:12` });
  eq([mv.status, mv.json?.error], [409, "chapter_locked"], "moving a note from verse 4 INTO the range is refused");
  eq([row("tn", "n4").verse, row("tn", "n4").ref_raw], [4, `${CH}:4`], "…and the note did not move");
  const mvRef = await patch("n4", { ref_raw: `${CH}:11` });
  eq([mvRef.status, mvRef.json?.error], [409, "chapter_locked"], "a move by ref_raw alone into the range is refused too");
  eq(row("tn", "n4").verse, 4, "…and the note did not move");
  eq(ok((await patch("n4", { verse: 5, ref_raw: `${CH}:5` })).status), true, "moving a note within the outside part (4 → 5) succeeds");
  eq(ok((await patch("n13", { verse: 2, ref_raw: `${CH}:2` })).status), true, "moving a note OUT of the range succeeds (the run no longer reads it)");

  eq(ok((await del("tn", "n3")).status), true, "DELETE a note at verse 3 succeeds");
  eq(row("tn", "n3").deleted_at != null, true, "…and it is deleted");
  const d12 = await del("tn", "n12");
  eq([d12.status, d12.json?.error], [409, "chapter_locked"], "DELETE a note at verse 12 is refused");
  eq(row("tn", "n12").deleted_at, null, "…and it is not deleted");
  eq(ok((await del("tn", "nbr")).status), true, "a bridge anchored at 9 (outside) reaching into 10-11 is unlocked: the import keys on the anchor and never touches it");
}

console.log("\n[questions keep the whole-chapter lock]");
{
  const { req, job } = freshApp();
  job("j-range", "notes", RANGE);
  job("j-tqs", "tqs", null);
  const q = await req("POST", `/api/rows/tq`, { book: BOOK, chapter: CH, verse: 3, ref_raw: `${CH}:3`, question: "Q?", response: "A." });
  eq([q.status, q.json?.error, q.json?.jobId], [409, "chapter_locked", "j-tqs"], "a questions run still refuses a TQ at verse 3");
}

console.log("\n[whole-chapter notes run: still locks verse 3]");
{
  const { job, row, createTn, del, patch } = freshApp();
  job("j-whole", "notes", JSON.stringify({ noIntro: true }));
  const c3 = await createTn(3);
  eq([c3.status, c3.json?.error], [409, "chapter_locked"], "POST at verse 3 refused");
  eq((await del("tn", "n3")).status, 409, "DELETE at verse 3 refused");
  eq(ok((await patch("n4", { verse: 12, ref_raw: `${CH}:12` })).status), true, "a move is NOT newly blocked under a whole-chapter run (unchanged behavior)");
  eq(row("tn", "n4").verse, 12, "…and it moved");
}

console.log("\n[fail closed]");
for (const [label, opts, extra] of [
  ["invalid stored range (15-10)", JSON.stringify({ verseRange: { start: 15, end: 10 } }), {}],
  ["unparseable options_json", "{not json", {}],
  ["range job carrying a follow-up chain", RANGE, { chain: '[{"pipelineType":"tqs"}]' }],
]) {
  const { job, createTn } = freshApp();
  job("j-bad", "notes", opts, extra);
  const c3 = await createTn(3);
  eq([c3.status, c3.json?.error], [409, "chapter_locked"], `${label} → verse 3 refused`);
}
{
  // Two notes jobs covering the chapter (the bot has one slot, but a paused run
  // plus a dispatching one can overlap): the lock is the union, not the first.
  const { job, createTn } = freshApp();
  job("j-a", "notes", RANGE);
  job("j-b", "notes", JSON.stringify({ verseRange: { start: 1, end: 5 } }), { state: "paused_for_outage" });
  eq((await createTn(3)).status, 409, "a second range job covering verse 3 still locks it");
  eq(ok((await createTn(7)).status), true, "verse 7 is outside both ranges → allowed");
}
{
  const { job, createTn } = freshApp();
  job("j-q", "notes", RANGE, { state: "queued" });
  eq(ok((await createTn(12)).status), true, "a queued range job locks nothing (unchanged)");
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall tnRangeLock tests passed");
