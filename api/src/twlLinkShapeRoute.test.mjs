// Issue #1316: a TWL link must have the shape Door43's validator accepts, or
// the row blocks the whole book's TWL export. Door43's validate_twl_files.py
// raises a HARD error (not a warning) for any non-blank TWLink that fails
//   TWLINK_RE = ^rc://[^/]+/[^/]+/[^/]+/[^ \\]+$
// The Words picker committed free text, so a translator typing "trouble" and
// pressing Enter saved the bare word, and the API accepted any string.
//
// Run from api/ (needs the sqlite flag and the resolve hook, since rows.ts
// imports its siblings extensionless):
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/twlLinkShapeRoute.test.mjs
//
// Driven through the REAL Hono router against the REAL migration schema (same
// harness as rowRestoreNoop.test.mjs): the guard is a decision in the route
// handlers, so a re-typed check would prove nothing about them.

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

// Minimal D1 shim over node:sqlite — same shape as rowRestoreNoop.test.mjs.
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
const GOOD = "rc://*/tw/dict/bible/other/trouble";

function freshApp() {
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
      `INSERT INTO twl_rows (id, book, chapter, verse, ref_raw, orig_words, occurrence, tw_link, sort_order, version, updated_by)
       VALUES (?, ?, 4, 6, '4:6', 'רָעָה', 1, ?, 10, 3, 9)`,
    )
    .run(ID, BOOK, GOOD);

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
  const patch = (body, ifMatch = 3) =>
    app.request(
      `/api/rows/twl/${ID}?book=${BOOK}`,
      {
        method: "PATCH",
        headers: { "if-match": String(ifMatch), "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
      ctx,
    );
  const create = (body) =>
    app.request(
      `/api/rows/twl?book=${BOOK}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ book: BOOK, chapter: 4, verse: 6, ref_raw: "4:6", orig_words: "רָעָה", occurrence: 1, ...body }),
      },
      env,
      ctx,
    );
  return { sqlite, patch, create };
}

const row = (sqlite) => sqlite.prepare(`SELECT * FROM twl_rows WHERE id = ? AND book = ?`).all(ID, BOOK)[0];
const rowCount = (sqlite) => sqlite.prepare(`SELECT COUNT(*) AS n FROM twl_rows WHERE book = ?`).all(BOOK)[0].n;
const logCount = (sqlite) => sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE kind = 'twl'`).all()[0].n;

console.log("\n[PATCH with a link Door43 would reject is refused and the row is untouched]");
for (const bad of [
  "trouble",
  "rc://*/tw/dict",
  " rc://*/tw/dict/bible/other/trouble",
  "rc://*/tw/dict/bible/other/big trouble",
]) {
  const { sqlite, patch } = freshApp();
  const res = await patch({ tw_link: bad });
  eq(res.status, 400, `PATCH tw_link=${JSON.stringify(bad)} -> 400`);
  const body = await res.json().catch(() => ({}));
  eq(body.error, "invalid_body", "…with the usual invalid_body code");
  eq(
    typeof body.message === "string" && body.message.includes("rc://"),
    true,
    "…and a message the outbox drawer can show",
  );
  const r = row(sqlite);
  eq(r.tw_link, GOOD, "…the stored link is unchanged");
  eq(r.version, 3, "…the version does not move");
  eq(logCount(sqlite), 0, "…and nothing is written to the audit log");
}

console.log("\n[POST with a bare word as the link is refused and no row is inserted]");
{
  const { sqlite, create } = freshApp();
  const res = await create({ tw_link: "trouble" });
  eq(res.status, 400, 'POST tw_link="trouble" -> 400');
  eq(rowCount(sqlite), 1, "…no row is inserted");
  eq(logCount(sqlite), 0, "…and nothing is written to the audit log");
}

console.log("\n[controls: a valid link, a blank link and null still save as before]");
{
  const { sqlite, patch } = freshApp();
  const res = await patch({ tw_link: "rc://*/tw/dict/bible/kt/sin" });
  eq(res.status, 200, "PATCH with a valid link -> 200");
  eq(row(sqlite).tw_link, "rc://*/tw/dict/bible/kt/sin", "…and it is stored");
  eq(row(sqlite).version, 4, "…with a version bump");
}
{
  const { sqlite, patch } = freshApp();
  const res = await patch({ tw_link: null });
  eq(res.status, 200, "PATCH tw_link=null -> 200 (blank stays a lint flag, not a refusal)");
  eq(row(sqlite).tw_link, null, "…and is stored");
}
{
  const { patch } = freshApp();
  const res = await patch({ tw_link: "" });
  eq(res.status, 200, 'PATCH tw_link="" -> 200');
}
{
  const { sqlite, patch } = freshApp();
  const res = await patch({ orig_words: "צָרָה" });
  eq(res.status, 200, "PATCH without tw_link -> 200");
  eq(row(sqlite).tw_link, GOOD, "…and the link is untouched");
}
{
  const { sqlite, create } = freshApp();
  const res = await create({ tw_link: "" });
  eq(res.status, 201, "POST with a blank link (the '+ add word link' stub) -> 201");
  eq(rowCount(sqlite), 2, "…and inserts the stub row");
}
{
  const { sqlite, create } = freshApp();
  const res = await create({ tw_link: GOOD });
  eq(res.status, 201, "POST with a valid link -> 201");
  eq(rowCount(sqlite), 2, "…and inserts the row");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll twlLinkShapeRoute assertions passed.");
