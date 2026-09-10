// Issue #755: a trashed tn row was only reachable by navigating to its own
// verse, so a note trashed in a chapter nobody revisits sits invisible until
// the nightly finalize (05:30 UTC) permanently tombstones it. GET
// /api/chapters/:book/trash lists every live-but-trashed tn row for the book
// regardless of which chapter is open, and the existing restore route clears
// it from that list.
//
// Run from api/ (needs the sqlite flag and the resolve hook, since chapters.ts
// and rows.ts import their siblings extensionless):
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/bookTrashSummary.test.mjs
//
// Driven through the REAL Hono routers against the REAL migration schema,
// mirroring rowRestoreNoop.test.mjs.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { chapters } from "./chapters.ts";
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

const BOOK = "ZEC";

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
  app.route("/api/chapters", chapters);
  app.route("/api/rows", rows);

  const env = { DB: makeDb(sqlite) };
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const getTrash = () => app.request(`/api/chapters/${BOOK}/trash`, {}, env, ctx);
  const restore = (id) =>
    app.request(`/api/rows/tn/${id}/restore?book=${BOOK}`, { method: "POST" }, env, ctx);
  return { sqlite, getTrash, restore };
}

function seedTrashedRow(sqlite, { id, chapter, verse, refRaw, note, trashedAt }) {
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, version, updated_by, trashed_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 9, ?)`,
    )
    .run(id, BOOK, chapter, verse, refRaw, note, trashedAt);
}

console.log("\n[GET /api/chapters/:book/trash lists trashed rows, most recent first]");
{
  const { sqlite, getTrash } = freshApp();
  seedTrashedRow(sqlite, { id: "aaa1", chapter: 5, verse: 3, refRaw: "5:3", note: "an older trashed note", trashedAt: 100 });
  seedTrashedRow(sqlite, { id: "bbb2", chapter: 0, verse: 0, refRaw: "front:intro", note: "the intro note", trashedAt: 200 });
  // A permanently-deleted row (already finalized) must not appear.
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, version, updated_by, trashed_at, deleted_at)
       VALUES ('ccc3', ?, 2, 1, '2:1', 'finalized already', 1, 9, 50, 999)`,
    )
    .run(BOOK);
  // A live (non-trashed) row must not appear.
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, version, updated_by)
       VALUES ('ddd4', ?, 1, 1, '1:1', 'a live note', 1, 9)`,
    )
    .run(BOOK);

  const res = await getTrash();
  eq(res.status, 200, "the request succeeds");
  const body = await res.json();
  eq(body.book, BOOK, "echoes the book");
  eq(body.rows.length, 2, "only the two trashed, unfinalized rows are listed");
  eq(body.rows[0].id, "bbb2", "most recently trashed first");
  eq(body.rows[0].chapter, 0, "chapter 0 (front:intro) rows are included");
  eq(body.rows[1].id, "aaa1", "the older trashed row follows");
  eq(body.rows[1].note_preview, "an older trashed note", "note preview carries the note text");
}

console.log("\n[Restore clears a row from the book trash list]");
{
  const { sqlite, getTrash, restore } = freshApp();
  seedTrashedRow(sqlite, { id: "eee5", chapter: 5, verse: 3, refRaw: "5:3", note: "trash me then bring me back", trashedAt: 100 });

  const before = await (await getTrash()).json();
  eq(before.rows.length, 1, "the row starts out listed");

  const restoreRes = await restore("eee5");
  eq(restoreRes.status, 200, "restore succeeds");

  const after = await (await getTrash()).json();
  eq(after.rows.length, 0, "the trash list is empty after restore");

  const row = sqlite.prepare(`SELECT trashed_at FROM tn_rows WHERE id = 'eee5'`).all()[0];
  eq(row.trashed_at, null, "trashed_at is cleared on the row itself");

  const auditRow = sqlite
    .prepare(`SELECT action FROM edit_log WHERE kind = 'tn' AND row_key = 'eee5' ORDER BY id DESC LIMIT 1`)
    .all()[0];
  eq(auditRow.action, "untrash", "an untrash edit_log row is written");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll book-trash-summary assertions passed.");
