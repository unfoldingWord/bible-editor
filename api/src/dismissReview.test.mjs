// Issue #653 (direction 2): a dismiss-review endpoint that clears a
// review_kind/review_reason flag WITHOUT touching content or bumping
// version — the real affordance for "I looked, it's fine", replacing the
// accidental no-op-resave path. Cold-review follow-up round adds: an
// edit_log audit row, a stale-dismiss guard (echo back the review_kind you
// saw), a trashed-row guard (tn), no-broadcast-on-no-op, and chapter-lock
// parity with PATCH/DELETE for tq/twl.
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
  const broadcasts = [];
  const ctx = {
    waitUntil(p) {
      // The route's only side effect scheduled via waitUntil is the WS
      // broadcast — count invocations rather than inspecting the promise
      // itself (broadcastChapter needs bindings this shim doesn't provide
      // and always rejects; see the existing swallow-and-log pattern below).
      broadcasts.push(p);
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const dismiss = (kind, id, book, extra) =>
    app.request(
      `/api/rows/${kind}/${id}/dismiss-review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ book, ...extra }),
      },
      env,
      ctx,
    );
  return { sqlite, dismiss, broadcasts };
}

// A far-past updated_at makes the "did the UPDATE fire" ablation deterministic
// — `now` in the handler is always later than this, so any real write moves it.
const PAST_UPDATED_AT = 1000000000;

function seedTn(sqlite, { id = "ab12", version = 4, reviewKind = "quote", reviewReason = "verify it", trashedAt = null } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, updated_by, updated_at, review_kind, review_reason, trashed_at)
       VALUES (?, ?, 36, 21, '36:21', ?, 10, ?, 9, ?, ?, ?, ?)`,
    )
    .run(id, BOOK, NOTE, version, PAST_UPDATED_AT, reviewKind, reviewReason, trashedAt);
}

const tnRow = (sqlite, id = "ab12") => sqlite.prepare(`SELECT * FROM tn_rows WHERE id = ? AND book = ?`).all(id, BOOK)[0];
const editLogRows = (sqlite, kind, id) =>
  sqlite.prepare(`SELECT * FROM edit_log WHERE kind = ? AND row_key = ? ORDER BY id`).all(kind, id);

console.log("\n[dismiss clears the flag without bumping version]");
{
  const { sqlite, dismiss, broadcasts } = freshApp();
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
  eq(broadcasts.length, 1, "a real change broadcasts once");
}

console.log("\n[a real dismiss writes an edit_log audit row naming what was cleared]");
{
  const { sqlite, dismiss } = freshApp();
  seedTn(sqlite, { reviewKind: "merge_conflict", reviewReason: "a merged edit" });

  const res = await dismiss("tn", "ab12", BOOK);
  eq(res.status, 200, "accepted");

  const logs = editLogRows(sqlite, "tn", "ab12");
  eq(logs.length, 1, "exactly one audit row");
  eq(logs[0].action, "dismiss_review", "action is the new, non-content action name");
  eq(logs[0].book, BOOK, "book is recorded");
  eq(logs[0].user_id, 9, "the acting user is recorded");
  eq(logs[0].prev_version, 4, "prev_version mirrors the row's (unchanged) version");
  eq(logs[0].new_version, 4, "new_version mirrors the row's (unchanged) version — this is not a content version bump");
  eq(
    JSON.parse(logs[0].payload_json),
    { review_kind: "merge_conflict", review_reason: "a merged edit" },
    "payload records the CLEARED flag values, not row content",
  );
}

console.log("\n[dismiss on an already-clear row is a 200 no-op — no audit row, no broadcast]");
{
  const { sqlite, dismiss, broadcasts } = freshApp();
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
  eq(editLogRows(sqlite, "tn", "ab12").length, 0, "no audit row for a no-op");
  eq(broadcasts.length, 0, "no broadcast for a no-op — nothing changed, don't churn the WS room");
}

console.log("\n[stale-dismiss guard: a mismatched review_kind leaves the flag intact]");
{
  const { sqlite, dismiss, broadcasts } = freshApp();
  // The row was re-stamped by a nightly reimport AFTER the client loaded the
  // lint feed showing 'quote' — the client's dismiss still carries the STALE
  // value it saw.
  seedTn(sqlite, { reviewKind: "merge_conflict", reviewReason: "a newer, unseen warning" });

  const res = await dismiss("tn", "ab12", BOOK, { review_kind: "quote" });
  eq(res.status, 200, "still a 200 (idempotent no-op), not an error");
  const body = await res.json();
  eq(body.review_kind, "merge_conflict", "the response surfaces the CURRENT (different) flag — the client sees the truth");

  const r = tnRow(sqlite);
  eq(r.review_kind, "merge_conflict", "the newer, unseen flag survives — the stale dismiss did not clear it");
  eq(r.updated_at, PAST_UPDATED_AT, "untouched");
  eq(editLogRows(sqlite, "tn", "ab12").length, 0, "no audit row — nothing was actually dismissed");
  eq(broadcasts.length, 0, "no broadcast");
}

console.log("\n[stale-dismiss guard: a MATCHING review_kind clears normally]");
{
  const { sqlite, dismiss } = freshApp();
  seedTn(sqlite, { reviewKind: "quote", reviewReason: "verify it" });

  const res = await dismiss("tn", "ab12", BOOK, { review_kind: "quote" });
  eq(res.status, 200, "accepted");
  const r = tnRow(sqlite);
  eq(r.review_kind, null, "cleared — the client's guess matched what was actually there");
  eq(editLogRows(sqlite, "tn", "ab12").length, 1, "and it's audited");
}

console.log("\n[stale-dismiss guard, second token: same review_kind but a DIFFERENT reason leaves the flag intact]");
{
  const { sqlite, dismiss, broadcasts } = freshApp();
  // The nightly reimport re-stamped the SAME review_kind ('quote') but with
  // NEW content — review_kind alone can't tell these apart, only the reason.
  seedTn(sqlite, { reviewKind: "quote", reviewReason: "a newer, unseen reason" });

  const res = await dismiss("tn", "ab12", BOOK, { review_kind: "quote", review_reason: "the stale reason the client saw" });
  eq(res.status, 200, "still a 200 (idempotent no-op)");
  const body = await res.json();
  eq(body.review_reason, "a newer, unseen reason", "the response surfaces the CURRENT (different) reason");

  const r = tnRow(sqlite);
  eq(r.review_kind, "quote", "the flag survives — kind matched but reason didn't");
  eq(r.review_reason, "a newer, unseen reason", "the newer, unseen reason is untouched");
  eq(editLogRows(sqlite, "tn", "ab12").length, 0, "no audit row — nothing was actually dismissed");
  eq(broadcasts.length, 0, "no broadcast");
}

console.log("\n[stale-dismiss guard, second token: matching kind AND reason clears normally]");
{
  const { sqlite, dismiss } = freshApp();
  seedTn(sqlite, { reviewKind: "quote", reviewReason: "verify it" });

  const res = await dismiss("tn", "ab12", BOOK, { review_kind: "quote", review_reason: "verify it" });
  eq(res.status, 200, "accepted");
  const r = tnRow(sqlite);
  eq(r.review_kind, null, "cleared — both tokens matched what was actually there");
  eq(r.review_reason, null, "cleared");
  eq(editLogRows(sqlite, "tn", "ab12").length, 1, "and it's audited");
}

console.log("\n[absent-vs-wrong: a null-reason flag survives a stale dismiss after a re-stamp WITH a reason]");
{
  // The Codex re-verify bug: the client saw review_reason=null, then the
  // nightly reimport re-stamped the SAME kind with a NEW, non-null reason.
  // A dismiss that omits the review_reason key (the pre-fix client
  // behavior — it dropped null via truthiness) would never guard on it at
  // all and would wrongly clear this newer flag. The fixed client sends
  // review_reason: null explicitly, which must NOT match a row whose
  // stored reason is now a string.
  const { sqlite, dismiss, broadcasts } = freshApp();
  seedTn(sqlite, { reviewKind: "merge_no_base", reviewReason: "a newer reason after the re-stamp" });

  const res = await dismiss("tn", "ab12", BOOK, { review_kind: "merge_no_base", review_reason: null });
  eq(res.status, 200, "still a 200 (idempotent no-op)");
  const body = await res.json();
  eq(body.review_reason, "a newer reason after the re-stamp", "the response surfaces the CURRENT (non-null) reason");

  const r = tnRow(sqlite);
  eq(r.review_kind, "merge_no_base", "the flag survives");
  eq(r.review_reason, "a newer reason after the re-stamp", "…with its new reason untouched");
  eq(editLogRows(sqlite, "tn", "ab12").length, 0, "no audit row — nothing was actually dismissed");
  eq(broadcasts.length, 0, "no broadcast");
}

console.log("\n[absent-vs-wrong: a null-reason flag dismissed with review_reason:null while unchanged clears normally]");
{
  const { sqlite, dismiss } = freshApp();
  seedTn(sqlite, { reviewKind: "merge_no_base", reviewReason: null });

  const res = await dismiss("tn", "ab12", BOOK, { review_kind: "merge_no_base", review_reason: null });
  eq(res.status, 200, "accepted");
  const r = tnRow(sqlite);
  eq(r.review_kind, null, "cleared — both tokens matched (kind equal, reason IS NULL on both sides)");
  eq(editLogRows(sqlite, "tn", "ab12").length, 1, "and it's audited");
}

console.log("\n[an empty-string review_reason round-trips as a real value, not a dropped/falsy one]");
{
  const { sqlite, dismiss } = freshApp();
  seedTn(sqlite, { reviewKind: "quote", reviewReason: "" });

  // A mismatched guess (non-empty) must NOT clear an empty-string reason.
  const stale = await dismiss("tn", "ab12", BOOK, { review_kind: "quote", review_reason: "not empty" });
  eq(stale.status, 200, "idempotent no-op");
  eq(tnRow(sqlite).review_kind, "quote", "an empty stored reason is not matched by a non-empty guess");

  // The matching empty-string guess DOES clear it.
  const res = await dismiss("tn", "ab12", BOOK, { review_kind: "quote", review_reason: "" });
  eq(res.status, 200, "accepted");
  const r = tnRow(sqlite);
  eq(r.review_kind, null, "cleared — the empty-string reason matched exactly");
  eq(editLogRows(sqlite, "tn", "ab12").length, 1, "audited");
}

console.log("\n[a dismiss with no review_kind in the body still works (guard is optional)]");
{
  const { sqlite, dismiss } = freshApp();
  seedTn(sqlite);
  const res = await dismiss("tn", "ab12", BOOK);
  eq(res.status, 200, "accepted with no review_kind sent");
  eq(tnRow(sqlite).review_kind, null, "cleared");
}

console.log("\n[a trashed tn row's flag cannot be dismissed — treated as not_found, like the lint feed excludes it]");
{
  const { sqlite, dismiss, broadcasts } = freshApp();
  seedTn(sqlite, { trashedAt: 1785800000 });

  const res = await dismiss("tn", "ab12", BOOK);
  eq(res.status, 404, "not_found — a trashed row is invisible, same as the lint feed's exclusion");
  const r = tnRow(sqlite);
  eq(r.review_kind, "quote", "the flag is untouched");
  eq(editLogRows(sqlite, "tn", "ab12").length, 0, "no audit row");
  eq(broadcasts.length, 0, "no broadcast");
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

console.log("\n[an empty-string book 400s book_required, same shape as PATCH]");
{
  const { dismiss } = freshApp();
  const res = await dismiss("tn", "ab12", "");
  eq(res.status, 400, "400, not a 404 from a book='' scan that matches nothing");
  const body = await res.json();
  eq(body, { error: "book_required" }, "same error shape PATCH/DELETE use for a missing book");
}

console.log("\n[dismiss works for tq and twl kinds too, and audits each]");
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
  eq(editLogRows(sqlite, "tq", "tq01").length, 1, "tq audit row written");

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
  eq(editLogRows(sqlite, "twl", "tw01").length, 1, "twl audit row written");
}

console.log("\n[an invalid kind is rejected]");
{
  const { dismiss } = freshApp();
  const res = await dismiss("bogus", "ab12", BOOK);
  eq(res.status, 400, "invalid_kind");
}

console.log("\n[chapter-lock parity: a running tqs pipeline blocks a tq dismiss in its chapter]");
{
  const { sqlite, dismiss, broadcasts } = freshApp();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, review_kind, review_reason)
       VALUES ('tq02', ?, 5, 3, '5:3', 'Q?', 'A.', 1, 'merge_conflict', 'x')`,
    )
    .run(BOOK);
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state)
       VALUES ('job1', 9, 'tqs', ?, 5, 5, 'sess1', 'running')`,
    )
    .run(BOOK);

  const res = await dismiss("tq", "tq02", BOOK);
  eq(res.status, 409, "locked — the questions run will overwrite this row when it lands");
  const tqRow = sqlite.prepare(`SELECT * FROM tq_rows WHERE id = 'tq02' AND book = ?`).all(BOOK)[0];
  eq(tqRow.review_kind, "merge_conflict", "the flag survives — the dismiss never ran");
  eq(editLogRows(sqlite, "tq", "tq02").length, 0, "no audit row");
  eq(broadcasts.length, 0, "no broadcast");
}

console.log("\n[chapter-lock parity: tn is exempt (mirrors PATCH's tn carve-out)]");
{
  const { sqlite, dismiss } = freshApp();
  seedTn(sqlite);
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state)
       VALUES ('job2', 9, 'notes', ?, 36, 36, 'sess2', 'running')`,
    )
    .run(BOOK);

  const res = await dismiss("tn", "ab12", BOOK);
  eq(res.status, 200, "tn dismiss goes through even with an active notes run — same carve-out PATCH gives tn");
  eq(tnRow(sqlite).review_kind, null, "cleared");
}

console.log("\n[chapter-lock parity: a lock on a DIFFERENT resource does not block]");
{
  const { sqlite, dismiss } = freshApp();
  sqlite
    .prepare(
      `INSERT INTO twl_rows (id, book, chapter, verse, ref_raw, orig_words, tw_link, version, review_kind, review_reason)
       VALUES ('tw02', ?, 5, 3, '5:3', 'x', 'rc://*/tw/dict/bible/kt/x', 1, 'ref_moved', 'x')`,
    )
    .run(BOOK);
  // A 'tqs' run locks tq only (see chapterLock.ts's PIPELINE_WRITES) — twl is
  // untouched, so a twl dismiss in the same chapter must go through.
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state)
       VALUES ('job3', 9, 'tqs', ?, 5, 5, 'sess3', 'running')`,
    )
    .run(BOOK);

  const res = await dismiss("twl", "tw02", BOOK);
  eq(res.status, 200, "twl is unlocked by a tqs-only run");
}

// ── #653: the Door43 snapshot goes with the flag ────────────────────────────
//
// review_master_json (migration 0057) holds what Door43 held for the row when
// the flag was raised. Behind a NULL review_kind it describes nothing and
// renders nowhere (the lint feed gates `door43` on the flag's presence), so a
// dismissed row must not keep it — same rule every other clear site follows.
console.log("\n[#653: a dismiss clears the Door43 snapshot along with the flag]");
{
  const { sqlite, dismiss } = freshApp();
  seedTn(sqlite, { reviewKind: "merge_no_base", reviewReason: "could not be checked" });
  const snapshot = JSON.stringify({
    ref_raw: "36:21",
    note: "Door43's own note",
    _meta: { flag_at: 1787000000, flag_since: 1786000000 },
  });
  sqlite.prepare(`UPDATE tn_rows SET review_master_json = ? WHERE id = 'ab12' AND book = ?`).run(snapshot, BOOK);

  const res = await dismiss("tn", "ab12", BOOK);
  eq(res.status, 200, "the dismiss is accepted");

  const r = tnRow(sqlite);
  eq(r.review_kind, null, "the flag is cleared");
  eq(r.review_master_json, null, "…and the snapshot with it — no residue of the dismissed warning");
  eq(r.note, NOTE, "…content still untouched");
  eq(r.version, 4, "…and still no version bump");
}

console.log("\n[#653: a NO-OP dismiss leaves the snapshot alone]");
{
  // The stale-dismiss guard's whole point is that a flag the client never saw
  // is not silently dropped. The snapshot rides that decision: if the flag
  // survives, its evidence must survive with it, or the chip would be left
  // describing a comparison the reader can no longer see.
  const { sqlite, dismiss } = freshApp();
  seedTn(sqlite, { reviewKind: "merge_kept", reviewReason: "your value was kept" });
  const snapshot = JSON.stringify({ ref_raw: "36:21", note: "Door43's own note" });
  sqlite.prepare(`UPDATE tn_rows SET review_master_json = ? WHERE id = 'ab12' AND book = ?`).run(snapshot, BOOK);

  const res = await dismiss("tn", "ab12", BOOK, { review_kind: "merge_no_base" });
  eq(res.status, 200, "a stale dismiss still answers 200 with the current truth");
  const r = tnRow(sqlite);
  eq(r.review_kind, "merge_kept", "the flag the client never saw survives");
  eq(r.review_master_json, snapshot, "…and so does the snapshot it is about");
  eq(r.updated_at, PAST_UPDATED_AT, "…the UPDATE never fired at all");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll dismiss-review assertions passed.");
