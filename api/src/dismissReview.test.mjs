// Issue #653 (direction 2): a dismiss-review endpoint that clears a
// review_kind/review_reason flag WITHOUT touching content or bumping
// version — the real affordance for "I looked, it's fine", replacing the
// accidental no-op-resave path.
//
// Run from api/ (needs the sqlite flag and the resolve hook, since rows.ts
// imports its siblings extensionless):
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/dismissReview.test.mjs
//
// Driven through the REAL Hono router against the REAL migration schema
// (same harness as rowRestoreNoop.test.mjs) — a race-tolerant SQL guard is a
// control-flow property of the handler, not something a re-typed UPDATE
// could prove.

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
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
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
const NOTE = "The prophet is speaking to the exiles.";

function freshApp() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();

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
  const dismiss = (kind, id, book) =>
    app.request(
      `/api/rows/${kind}/${id}/dismiss-review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ book }),
      },
      env,
      ctx,
    );
  return { sqlite, dismiss };
}

// A far-past updated_at makes the "did the UPDATE fire" ablation deterministic
// — `now` in the handler is always later than this, so any real write moves it.
const PAST_UPDATED_AT = 1000000000;

function seedTn(sqlite, { id = "ab12", version = 4, reviewKind = "quote", reviewReason = "verify it" } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, updated_by, updated_at, review_kind, review_reason)
       VALUES (?, ?, 36, 21, '36:21', ?, 10, ?, 9, ?, ?, ?)`,
    )
    .run(id, BOOK, NOTE, version, PAST_UPDATED_AT, reviewKind, reviewReason);
}

const tnRow = (sqlite, id = "ab12") => sqlite.prepare(`SELECT * FROM tn_rows WHERE id = ? AND book = ?`).all(id, BOOK)[0];

console.log("\n[dismiss clears the flag without bumping version]");
{
  const { sqlite, dismiss } = freshApp();
  seedTn(sqlite);

  const res = await dismiss("tn", "ab12", BOOK);
  eq(res.status, 200, "the dismiss is accepted");
  const body = await res.json();
  eq(body.review_kind, null, "review_kind is cleared in the response");
  eq(body.review_reason, null, "review_reason is cleared in the response");
  eq(body.version, 4, "version is NOT bumped — this is a metadata flip, not a content edit");

  const r = tnRow(sqlite);
  eq(r.review_kind, null, "review_kind is cleared in the DB");
  eq(r.review_reason, null, "review_reason is cleared in the DB");
  eq(r.version, 4, "the stored version is unchanged");
  eq(r.note, NOTE, "content is untouched");
}

console.log("\n[dismiss on an already-clear row is a 200 no-op]");
{
  const { sqlite, dismiss } = freshApp();
  seedTn(sqlite, { reviewKind: null, reviewReason: null });

  const res = await dismiss("tn", "ab12", BOOK);
  eq(res.status, 200, "still a 200, not a 404 or error");
  const r = tnRow(sqlite);
  eq(r.review_kind, null, "stays null");
  eq(r.version, 4, "version untouched");
  // This is what the `review_kind IS NOT NULL` guard on the UPDATE buys: a
  // dismiss against a row with no flag touches NOTHING, not even updated_at.
  // Without the guard the UPDATE fires unconditionally and this would flip.
  eq(r.updated_at, PAST_UPDATED_AT, "updated_at untouched — the UPDATE never fired, guarded on the flag's own existence");
}

console.log("\n[dismiss on a missing row 404s]");
{
  const { dismiss } = freshApp();
  const res = await dismiss("tn", "zzzz", BOOK);
  eq(res.status, 404, "not_found for a row that doesn't exist at all");
}

console.log("\n[dismiss on a row in a different book 404s (book is mandatory scoping)]");
{
  const { sqlite, dismiss } = freshApp();
  seedTn(sqlite);
  const res = await dismiss("tn", "ab12", "GEN");
  eq(res.status, 404, "wrong book is treated as not found — ids are unique only per (book,id)");
}

console.log("\n[dismiss works for tq and twl kinds too]");
{
  const { sqlite, dismiss } = freshApp();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, review_kind, review_reason)
       VALUES ('tq01', ?, 1, 1, '1:1', 'Q?', 'A.', 3, 'merge_conflict', 'a merged edit')`,
    )
    .run(BOOK);
  const resTq = await dismiss("tq", "tq01", BOOK);
  eq(resTq.status, 200, "tq dismiss accepted");
  const tqRow = sqlite.prepare(`SELECT * FROM tq_rows WHERE id = 'tq01' AND book = ?`).all(BOOK)[0];
  eq(tqRow.review_kind, null, "tq review_kind cleared");
  eq(tqRow.version, 3, "tq version untouched");

  sqlite
    .prepare(
      `INSERT INTO twl_rows (id, book, chapter, verse, ref_raw, orig_words, tw_link, version, review_kind, review_reason)
       VALUES ('tw01', ?, 1, 1, '1:1', 'דָּבָר', 'rc://*/tw/dict/bible/kt/word', 2, 'ref_moved', 'ref differs')`,
    )
    .run(BOOK);
  const resTwl = await dismiss("twl", "tw01", BOOK);
  eq(resTwl.status, 200, "twl dismiss accepted");
  const twlRow = sqlite.prepare(`SELECT * FROM twl_rows WHERE id = 'tw01' AND book = ?`).all(BOOK)[0];
  eq(twlRow.review_kind, null, "twl review_kind cleared");
  eq(twlRow.version, 2, "twl version untouched");
}

console.log("\n[an invalid kind is rejected]");
{
  const { dismiss } = freshApp();
  const res = await dismiss("bogus", "ab12", BOOK);
  eq(res.status, 400, "invalid_kind");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll dismiss-review assertions passed.");
