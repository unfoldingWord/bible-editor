// #886: /api/catalogs used to run its full tw_articles + twl_rows GROUP BY
// scan on every request — including a fresh request per NoteCard/WordRow
// mount. This proves the isolate-scope memo added to catalogs.ts actually
// stops later requests from re-querying (within its TTL), while still
// answering correctly on the first request of a cold isolate.
//
// Run from api/ (real router against the real migration schema, same harness
// as dismissReview.test.mjs):
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/catalogs.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { catalogs } from "./catalogs.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Minimal D1 shim over node:sqlite — same shape as dismissReview.test.mjs.
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
  return { prepare: (sql) => mk(sql, []) };
}

function freshApp() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  const app = new Hono();
  app.route("/api/catalogs", catalogs);
  const env = { DB: makeDb(sqlite) };
  const get = () => app.request("/api/catalogs", {}, env);
  return { sqlite, get };
}

function seedArticle(sqlite, id, title) {
  sqlite
    .prepare(
      `INSERT INTO tw_articles (id, category, title, tw_link) VALUES (?, 'kt', ?, ?)`,
    )
    .run(id, title, `rc://*/tw/dict/bible/${id}`);
}

console.log("\n[first request returns the canonical catalog, cached at isolate scope]");
{
  // NOTE: catalogs.ts memoizes at MODULE scope (real isolate-reuse
  // behavior) — this file's requests all share that one memo, matching how
  // Cloudflare reuses a warm isolate across requests. Order matters below.
  const { sqlite, get } = freshApp();
  seedArticle(sqlite, "kt/god", "God, god");

  const res = await get();
  eq(res.status, 200, "200 on a cold isolate");
  eq(res.headers.get("cache-control"), "private, max-age=300", "cache-control set for the browser/CDN layer");
  const body = await res.json();
  eq(body.twLinks, ["rc://*/tw/dict/bible/kt/god"], "canonical tw_link surfaced");
  eq(body.twTitles, { "rc://*/tw/dict/bible/kt/god": "God, god" }, "twTitles carries the headword line");
  eq(Array.isArray(body.supportReferences), true, "supportReferences present");

  console.log("\n[a later request within the TTL is served from the memo, not a fresh scan]");
  // Insert a second article directly against the SAME sqlite handle this
  // app's env is bound to, then hit the route again on the SAME (module-
  // scope-memoized) catalogs router. If the memo were bypassed, this new
  // article would appear in the response.
  seedArticle(sqlite, "kt/love", "love, loving");
  const res2 = await get();
  eq(res2.status, 200, "still 200");
  const body2 = await res2.json();
  eq(body2, body, "byte-identical to the first response — the DB was not re-queried");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll catalogs cache assertions passed.");
