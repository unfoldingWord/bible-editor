// Issue #660: a no-op re-save that clears a pending review flag
// (rows.ts's "allMatch" short-circuit around line ~759) must broadcast the
// fresh row to other open tabs, same as the reorder-only fast path already
// does a few lines below it (~826-831). Before this fix, the clear branch
// updated D1 and returned 200 to the caller's own tab, but every OTHER tab
// on that chapter kept showing the stale review-flag chip until their next
// book-lint refetch or chapter reload.
//
// Run from api/:
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/reviewFlagBroadcast.test.mjs
//
// Driven through the REAL Hono router against the REAL migration schema,
// mirroring rowRestoreNoop.test.mjs — the fix is a control-flow decision in
// the handler (does this branch call broadcastChapter), so re-typing the SQL
// would prove nothing about it. Unlike that file's ctx.waitUntil (which
// swallows the promise), this one collects and awaits it so the broadcast
// side effect can actually be asserted on.

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
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
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

// A fake CHAPTER_ROOM Durable Object namespace that records every
// stub.fetch(POST /broadcast) body, mirroring broadcastChapter's real call
// shape (wsEvents.ts) without needing an actual DO.
function makeChapterRoom(calls) {
  return {
    idFromName(name) {
      return { name };
    },
    get(id) {
      return {
        async fetch(req) {
          const event = JSON.parse(await req.text());
          calls.push({ roomName: id.name, event });
          return new Response("ok");
        },
      };
    },
  };
}

const BOOK = "JER";
const ID = "ab12";
const NOTE = "The prophet is speaking to the exiles.";

function freshApp() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  app.route("/api/rows", rows);

  const broadcasts = [];
  const env = { DB: makeDb(sqlite), CHAPTER_ROOM: makeChapterRoom(broadcasts) };
  // Unlike rowRestoreNoop.test.mjs, collect (rather than swallow) the
  // waitUntil promise so the broadcast fetch has actually resolved by the
  // time the test asserts on `broadcasts`.
  const pending = [];
  const ctx = {
    waitUntil(p) {
      pending.push(Promise.resolve(p).catch((e) => { throw e; }));
    },
    passThroughOnException() {},
  };
  const patch = async (body, ifMatch, kind = "tn") => {
    const res = await app.request(
      `/api/rows/${kind}/${ID}?book=${BOOK}`,
      {
        method: "PATCH",
        headers: { "if-match": String(ifMatch), "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
      ctx,
    );
    await Promise.all(pending);
    return res;
  };
  return { sqlite, patch, broadcasts };
}

function seedRow(sqlite, { note = NOTE, version = 4, reviewKind = "quote", reviewReason = "adapted quote, please verify" } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, updated_by, review_kind, review_reason)
       VALUES (?, ?, 36, 21, '36:21', ?, 10, ?, 9, ?, ?)`,
    )
    .run(ID, BOOK, note, version, reviewKind, reviewReason);
}

const row = (sqlite) => sqlite.prepare(`SELECT * FROM tn_rows WHERE id = ? AND book = ?`).all(ID, BOOK)[0];

const QUESTION = "What did the prophet say?";

// tq/twl gained review_kind/review_reason in migration 0047 — the no-op clear
// branch above is kind-generic (KIND_TO_TABLE-driven), so it must work for
// them too, not just tn.
function seedTqRow(sqlite, { question = QUESTION, version = 4, reviewKind = "quote", reviewReason = "adapted quote, please verify" } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, sort_order, version, updated_by, review_kind, review_reason)
       VALUES (?, ?, 36, 21, '36:21', ?, 10, ?, 9, ?, ?)`,
    )
    .run(ID, BOOK, question, version, reviewKind, reviewReason);
}

const tqRow = (sqlite) => sqlite.prepare(`SELECT * FROM tq_rows WHERE id = ? AND book = ?`).all(ID, BOOK)[0];

console.log("\n[a no-op re-save that clears a review flag broadcasts the fresh row]");
{
  const { sqlite, patch, broadcasts } = freshApp();
  seedRow(sqlite);

  const res = await patch({ note: NOTE }, 4);
  eq(res.status, 200, "the no-op save is accepted");

  const r = row(sqlite);
  eq(r.review_kind, null, "review_kind is cleared in D1");
  eq(r.review_reason, null, "review_reason is cleared in D1");
  eq(r.version, 4, "no version bump — this is a bit-toggle, not a content edit");

  eq(broadcasts.length, 1, "exactly one chapter broadcast fired");
  const { roomName, event } = broadcasts[0];
  eq(roomName, `${BOOK}:36`, "broadcast targets the row's own chapter room");
  eq(event.type, "row.upserted", "broadcast carries the row.upserted contract other tabs already replace-on");
  eq(event.kind, "tn", "broadcast carries the row kind");
  eq(event.row.id, ID, "broadcast carries the fresh row");
  eq(
    event.row.review_kind,
    null,
    "broadcasts row.upserted on a no-op review-flag clear — client-side refetch is covered in Shell",
  );
  eq(event.row.review_reason, null, "…and review_reason cleared too");
}

console.log("\n[an ordinary no-op save on a row with no review flag stays silent]");
{
  // Guards against over-broadcasting: a plain re-save of unflagged content
  // must not gain a new side effect from this fix.
  const { sqlite, patch, broadcasts } = freshApp();
  seedRow(sqlite, { reviewKind: null, reviewReason: null });

  const res = await patch({ note: NOTE }, 4);
  eq(res.status, 200, "the no-op save is accepted");
  eq(broadcasts.length, 0, "no broadcast — there was no flag to clear, and no content moved");
}

console.log("\n[a reorder-only patch on a flagged row does NOT acknowledge the flag]");
{
  // The no-op clear branch explicitly excludes sort_order-only patches
  // (reorderOnly guard) — a drag must not clear a review. That path still
  // broadcasts (the pre-existing reorder fast path), but with the flag
  // intact.
  const { sqlite, patch, broadcasts } = freshApp();
  seedRow(sqlite);

  const res = await patch({ sort_order: 20 }, 4);
  eq(res.status, 200, "the reorder is accepted");

  const r = row(sqlite);
  eq(r.review_kind, "quote", "review_kind survives a mere reorder");

  eq(broadcasts.length, 1, "the pre-existing reorder fast path still broadcasts exactly once");
  eq(broadcasts[0].event.row.review_kind, "quote", "…and the broadcast row still carries the untouched flag");
}

console.log("\n[tq: a no-op re-save that clears a review flag broadcasts the fresh row]");
{
  // Mirrors the tn block above — the clear branch is kind-generic
  // (KIND_TO_TABLE[kind]), and tq carries review_kind/review_reason since
  // migration 0047, so this must behave identically for tq.
  const { sqlite, patch, broadcasts } = freshApp();
  seedTqRow(sqlite);

  const res = await patch({ question: QUESTION }, 4, "tq");
  eq(res.status, 200, "the no-op save is accepted");

  const r = tqRow(sqlite);
  eq(r.review_kind, null, "review_kind is cleared in D1");
  eq(r.review_reason, null, "review_reason is cleared in D1");
  eq(r.version, 4, "no version bump — this is a bit-toggle, not a content edit");

  eq(broadcasts.length, 1, "exactly one chapter broadcast fired");
  const { roomName, event } = broadcasts[0];
  eq(roomName, `${BOOK}:36`, "broadcast targets the row's own chapter room");
  eq(event.type, "row.upserted", "broadcast carries the row.upserted contract other tabs already replace-on");
  eq(event.kind, "tq", "broadcast carries the row kind");
  eq(event.row.id, ID, "broadcast carries the fresh row");
  eq(event.row.review_kind, null, "broadcasts row.upserted on a no-op review-flag clear — client-side refetch is covered in Shell");
  eq(event.row.review_reason, null, "…and review_reason cleared too");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll review-flag-clear broadcast assertions passed.");
