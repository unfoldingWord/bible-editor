// Issue #1342: a straight ' or " in a tn Quote / SupportReference or a tq
// Quote fails Door43's straight-quote check (en_tn validate_tn_files.py check
// 15, en_tq validate_tq_files.py check 13, both error severity), and the export
// writes those columns as stored, so since #1336 the nightly export holds the
// whole book. Refuse the write at save time instead, so nobody loses a night.
// Note / Question / Response are curled at export (educateQuotes) and are NOT
// refused here. A PATCH that leaves the column out is never refused, even when
// the stored value already holds a straight quote.
//
// Run from api/ (needs the sqlite flag and the resolve hook, since rows.ts
// imports its siblings extensionless):
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/tnTqQuoteRoute.test.mjs
//
// Driven through the REAL Hono router against the REAL migration schema (same
// harness as twlLinkShapeRoute.test.mjs).

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { rows } from "./rows.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Minimal D1 shim over node:sqlite — same shape as twlLinkShapeRoute.test.mjs.
function makeDb(sqlite) {
  const mk = (sql, args) => ({
    sql,
    args,
    bind: (...a) => mk(sql, a),
    all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    run() {
      if (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql)) {
        const results = sqlite.prepare(sql).all(...args);
        return { results, success: true, meta: { changes: /^\s*(SELECT|WITH)\b/i.test(sql) ? 0 : results.length } };
      }
      const r = sqlite.prepare(sql).run(...args);
      return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
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

const BOOK = "JER";
const ID = "qbg9";
const SUPPORT = "rc://*/ta/man/translate/figs-metaphor";
const QUOTE = "רָעָה";

// storedQuote lets a test start from a row that ALREADY holds a straight quote
// (an AI import or reimport wrote it), to prove a PATCH that leaves Quote out
// is not refused for it.
function freshApp({ storedQuote = QUOTE } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();
  // POST probes that the chapter exists before inserting.
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text)
       VALUES (?, 4, 6, NULL, 'ULT', '{}', 'text')`,
    )
    .run(BOOK);
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, support_reference, quote, occurrence, note, sort_order, version, updated_by)
       VALUES (?, ?, 4, 6, '4:6', ?, ?, 1, 'a note', 10, 3, 9)`,
    )
    .run(ID, BOOK, SUPPORT, storedQuote);
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, quote, occurrence, question, response, sort_order, version, updated_by)
       VALUES (?, ?, 4, 6, '4:6', ?, 1, 'Who?', 'God.', 10, 3, 9)`,
    )
    .run(ID, BOOK, storedQuote);

  const app = new Hono();
  // Stand in for attachAuth — requireEditor reads exactly these two.
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  app.route("/api/rows", rows);

  const env = { DB: makeDb(sqlite) };
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const patch = (kind, body, ifMatch = 3) =>
    app.request(
      `/api/rows/${kind}/${ID}?book=${BOOK}`,
      {
        method: "PATCH",
        headers: { "if-match": String(ifMatch), "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
      ctx,
    );
  const base = {
    tn: { support_reference: SUPPORT, quote: QUOTE, occurrence: 1, note: "a new note" },
    tq: { quote: QUOTE, occurrence: 1, question: "Why?", response: "Because." },
  };
  const create = (kind, body) =>
    app.request(
      `/api/rows/${kind}?book=${BOOK}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ book: BOOK, chapter: 4, verse: 6, ref_raw: "4:6", ...base[kind], ...body }),
      },
      env,
      ctx,
    );
  return { sqlite, patch, create };
}

const row = (sqlite, kind) => sqlite.prepare(`SELECT * FROM ${kind}_rows WHERE id = ? AND book = ?`).all(ID, BOOK)[0];
const rowCount = (sqlite, kind) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${kind}_rows WHERE book = ?`).all(BOOK)[0].n;
const logCount = (sqlite, kind) => sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE kind = ?`).all(kind)[0].n;

const CASES = [
  { kind: "tn", field: "quote", column: "Quote", stored: QUOTE, curlyFix: true },
  { kind: "tn", field: "support_reference", column: "SupportReference", stored: SUPPORT, curlyFix: false },
  { kind: "tq", field: "quote", column: "Quote", stored: QUOTE, curlyFix: true },
];

console.log("\n[PATCH with a straight quote in the column is refused and the row is untouched]");
for (const { kind, field, column, stored, curlyFix } of CASES) {
  const bads =
    field === "support_reference"
      ? ["rc://*/ta/man/translate/figs-o'x", 'rc://*/ta/man/translate/"figs-metaphor"']
      : ["אֵ'ת", 'say "this"'];
  for (const bad of bads) {
    const { sqlite, patch } = freshApp();
    const res = await patch(kind, { [field]: bad });
    eq(res.status, 400, `${kind} PATCH ${field}=${JSON.stringify(bad)} -> 400`);
    const body = await res.json().catch(() => ({}));
    const msg = body.message ?? "";
    eq(body.error, "invalid_body", "…with the usual invalid_body code");
    eq(msg.startsWith(`${column} cannot contain a straight quote`), true, `…and a message naming ${column} and the fault`);
    eq(/curly quote \(’ “ ”\)/.test(msg), curlyFix, `…${curlyFix ? "suggesting" : "not suggesting"} a curly quote`);
    eq(msg.length <= 200, true, "…short enough for the outbox drawer's 200-character cap");
    const r = row(sqlite, kind);
    eq(r[field], stored, `…the stored ${field} is unchanged`);
    eq(r.version, 3, "…the version does not move");
    eq(logCount(sqlite, kind), 0, "…and nothing is written to the audit log");
  }
}
{
  const { patch } = freshApp();
  const body = await (await patch("tn", { quote: "it's \"x\"" })).json().catch(() => ({}));
  eq(/straight quote \(' and "\)/.test(body.message ?? ""), true, "both quote marks are named");
}

console.log("\n[POST with a straight quote in the column is refused and no row is inserted]");
for (const { kind, field } of CASES) {
  const { sqlite, create } = freshApp();
  const res = await create(kind, { [field]: field === "quote" ? "it's" : "rc://*/ta/man/translate/figs-o'x" });
  eq(res.status, 400, `${kind} POST ${field} with a straight quote -> 400`);
  const body = await res.json().catch(() => ({}));
  eq(body.error, "invalid_body", "…with the usual invalid_body code");
  eq(rowCount(sqlite, kind), 1, "…no row is inserted");
  eq(logCount(sqlite, kind), 0, "…and nothing is written to the audit log");
}

console.log("\n[controls: a PATCH without the column is not refused, even over a stored straight quote]");
for (const kind of ["tn", "tq"]) {
  const { sqlite, patch } = freshApp({ storedQuote: "it's" });
  const res = await patch(kind, kind === "tn" ? { note: "a new note" } : { question: "Why?" });
  eq(res.status, 200, `${kind} PATCH of only the ${kind === "tn" ? "Note" : "Question"} over a stored straight-quote Quote -> 200`);
  const r = row(sqlite, kind);
  eq(r.quote, "it's", "…the stored Quote is untouched (lint flags it)");
  eq(r.version, 4, "…with a version bump");
}
console.log("\n[controls: Note / Question / Response may hold a straight quote (curled at export)]");
{
  const { sqlite, patch } = freshApp();
  const res = await patch("tn", { note: 'He said "go" and it\'s done.' });
  eq(res.status, 200, "tn PATCH note with straight quotes -> 200");
  eq(row(sqlite, "tn").note, 'He said "go" and it\'s done.', "…and it is stored");
}
{
  const { patch } = freshApp();
  const res = await patch("tq", { question: "Who's there?", response: 'He said "go".' });
  eq(res.status, 200, "tq PATCH question/response with straight quotes -> 200");
}
console.log("\n[controls: curly quotes, blank and null save as before]");
for (const { kind, field } of CASES) {
  for (const ok of field === "quote" ? ["it’s “this”", "", null] : ["", null]) {
    const { sqlite, patch } = freshApp();
    const res = await patch(kind, { [field]: ok });
    eq(res.status, 200, `${kind} PATCH ${field}=${JSON.stringify(ok)} -> 200`);
    eq(row(sqlite, kind)[field], ok, "…and it is stored");
  }
}
for (const kind of ["tn", "tq"]) {
  const { sqlite, create } = freshApp();
  const res = await create(kind, { quote: "it’s" });
  eq(res.status, 201, `${kind} POST with a curly-quote Quote -> 201`);
  eq(rowCount(sqlite, kind), 2, "…and inserts the row");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll tnTqQuoteRoute assertions passed.");
