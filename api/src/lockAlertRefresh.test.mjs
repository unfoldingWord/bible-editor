// Issue #1110 (follow-up to #1006): locking or unlocking a book re-derives its
// standing verse-merge alerts with the new lock state, with no reimport run.
//
// Before this, the lock was read only when a Door43 reimport raised the alert.
// After an unlock with Door43's file unchanged, the reimport returns before the
// alert path, so a locked alert ("the export skips it, ask an admin") kept
// standing, and a DISMISSED locked alert stayed dismissed, while the first
// post-unlock export wrote over Door43's version of those verses.
//
// Driven through the REAL Hono router (PUT/DELETE /api/books/:book/lock) on the
// REAL migration schema, same harness as dismissReview.test.mjs.
//
// Run from api/:
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/lockAlertRefresh.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { books } from "./bookImport.ts";
import {
  raiseVerseMergeConflictAlert,
  recordVerseMergeConflicts,
  refreshVerseMergeAlertsAfterLockChange,
} from "./verseMergeConflicts.ts";
import { reviewConditionKey, verseMergeEditorConditionKey } from "./reviewAlerts.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const BOOK = "JER"; // not in PUBLISHED_BOOKS, so the lock comes only from book_locks
const SOURCE = `verse_merge_conflict:${BOOK}:ust`;
const ADMIN = "deferredreward";
const EDITOR = "bethoakes";

function freshApp() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 101, ?)`).run(ADMIN);
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 707, ?)`).run(EDITOR);
  sqlite.prepare(`INSERT OR IGNORE INTO book_lock_admins (dcs_username) VALUES (?)`).run(ADMIN);
  // bethoakes wrote v2 of JER 1:6 UST, the verse kept with no recoverable ancestor.
  sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES ('verse', ?, ?, 7, 2, 'update')`)
    .run(`${BOOK}/1/6/UST`, BOOK);

  const stmt = (sql, args = []) => ({
    _sql: sql,
    _args: args,
    bind: (...next) => stmt(sql, next),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  });
  const env = {
    DB: {
      prepare: (sql) => stmt(sql),
      batch: async (stmts) => {
        sqlite.exec("BEGIN");
        try {
          const out = stmts.map((s) => ({ meta: { changes: Number(sqlite.prepare(s._sql).run(...s._args).changes) } }));
          sqlite.exec("COMMIT");
          return out;
        } catch (e) {
          sqlite.exec("ROLLBACK");
          throw e;
        }
      },
    },
  };

  const app = new Hono();
  // Stand in for attachAuth: requireEditor and the lock-admin check read these.
  app.use("*", async (c, next) => {
    c.set("userId", 1);
    c.set("role", "admin");
    c.set("username", ADMIN);
    await next();
  });
  app.route("/api/books", books);

  const pending = [];
  const ctx = {
    waitUntil(p) {
      pending.push(p);
    },
    passThroughOnException() {},
  };
  const lockRoute = async (method) => {
    const res = await app.request(
      `/api/books/${BOOK}/lock`,
      { method, headers: { "content-type": "application/json" }, body: method === "PUT" ? "{}" : undefined },
      env,
      ctx,
    );
    // The refresh is best-effort work after the response; let it finish.
    await Promise.all(pending.splice(0));
    return res;
  };
  const live = (username) =>
    sqlite
      .prepare(
        `SELECT id, message, condition_key FROM system_alerts
          WHERE username = ? AND source = ? AND dismissed_at IS NULL AND resolved_at IS NULL`,
      )
      .all(username, SOURCE);
  return { sqlite, env, lockRoute, live };
}

console.log("\n[unlock and lock re-derive the standing verse-merge alerts, no reimport (issue #1110)]");
{
  const { sqlite, env, lockRoute, live } = freshApp();
  // A kept-for-alignment verse (a verse_merge_conflicts row) and a no-ancestor
  // verse (keep_no_base: no row, only the alert carries it), raised by a
  // reimport while the book was unlocked.
  await recordVerseMergeConflicts(env, BOOK, "ust", "UST", [
    {
      chapter: 1, verse: 8, action: "keep_alignment_refused", reason: "alignment_shrink",
      overwrittenVersion: null, alignment: null, observedVersion: null,
    },
  ], 1000);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", {
    noBaseCount: 1,
    noBaseRefs: ["1:6"],
    noBaseEditorRefs: [{ chapter: 1, verse: 6, version: 2 }],
    observedAt: 1000,
  });
  const unlockedKeys = { [ADMIN]: live(ADMIN)[0]?.condition_key, [EDITOR]: live(EDITOR)[0]?.condition_key };
  const unlockedMessages = { [ADMIN]: live(ADMIN)[0]?.message, [EDITOR]: live(EDITOR)[0]?.message };
  assert(/tonight's export/.test(unlockedMessages[ADMIN] ?? ""), "setup: the unlocked admin alert warns about tonight's export");
  assert(/tonight's export/.test(unlockedMessages[EDITOR] ?? ""), "setup: the unlocked editor alert warns about tonight's export");
  assert(
    unlockedKeys[ADMIN] ===
      reviewConditionKey("verse_merge_conflict", { book: BOOK, resource: "ust" }, {
        rows: [{ chapter: 1, verse: 8, action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null }],
        noBase: [{ chapter: 1, verse: 6, version: 2 }],
        noBaseCount: 1,
        recordingFailed: false,
      }),
    "setup: the unlocked admin key has its pre-#1110 shape",
  );
  assert(
    unlockedKeys[EDITOR] === verseMergeEditorConditionKey(BOOK, "ust", EDITOR, ["1:6"]),
    "setup: the unlocked editor key has its pre-#1110 shape",
  );

  // Lock: no reimport runs, but the alerts must stop saying tonight's export writes.
  const lockRes = await lockRoute("PUT");
  assert(lockRes.status === 200, "PUT lock succeeds");
  for (const u of [ADMIN, EDITOR]) {
    const rows = live(u);
    assert(rows.length === 1, `${u}: one standing alert after the lock`);
    assert(!/tonight's export/.test(rows[0]?.message ?? ""), `${u}: after the lock, no sentence claims tonight's export writes (got: ${rows[0]?.message})`);
    assert(/locked/.test(rows[0]?.message ?? ""), `${u}: after the lock, the alert names the lock`);
  }
  assert(live(ADMIN)[0]?.message.includes("Verses (sample): 1:6."), "admin: the no-ancestor verse survives the lock refresh (it has no table row)");

  // People read the locked alerts and dismiss them.
  sqlite.prepare(`UPDATE system_alerts SET dismissed_at = 5000 WHERE source = ? AND resolved_at IS NULL`).run(SOURCE);

  // Unlock: still no reimport. The overwrite warning must come back undismissed.
  const unlockRes = await lockRoute("DELETE");
  assert(unlockRes.status === 200, "DELETE lock succeeds");
  for (const u of [ADMIN, EDITOR]) {
    const rows = live(u);
    assert(rows.length === 1, `${u}: after the unlock, a fresh undismissed alert stands`);
    assert(/tonight's export/.test(rows[0]?.message ?? ""), `${u}: …carrying the overwrite warning again`);
    assert(rows[0]?.condition_key === unlockedKeys[u], `${u}: …under the same unlocked condition key as before the lock`);
  }
  assert(live(EDITOR)[0]?.message === unlockedMessages[EDITOR], "editor: the unlocked message is byte-identical to the reimport's");
}

console.log("\n[a book with no standing verse-merge alert: lock changes write nothing (issue #1110)]");
{
  const { sqlite, lockRoute } = freshApp();
  await lockRoute("PUT");
  await lockRoute("DELETE");
  const n = sqlite.prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source LIKE 'verse_merge_conflict:%'`).get().n;
  assert(n === 0, "no verse-merge alert is invented by a lock change");
}

console.log("\n[a dismissed alert whose condition did not change stays dismissed across a no-op refresh (issue #1110)]");
{
  // Only an adopt_conflict overwrite: nothing in it depends on the lock, so a
  // lock change must not resurrect it.
  const { sqlite, env, lockRoute, live } = freshApp();
  sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES ('verse', ?, ?, 7, 4, 'update')`)
    .run(`${BOOK}/2/1/UST`, BOOK);
  await recordVerseMergeConflicts(env, BOOK, "ust", "UST", [
    {
      chapter: 2, verse: 1, action: "adopt_conflict", reason: "both_changed_wording",
      overwrittenVersion: 4, alignment: null, observedVersion: null,
    },
  ], 1000);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", { observedAt: 1000 });
  sqlite.prepare(`UPDATE system_alerts SET dismissed_at = 5000 WHERE source = ? AND resolved_at IS NULL`).run(SOURCE);
  await lockRoute("PUT");
  await lockRoute("DELETE");
  assert(live(ADMIN).length === 0 && live(EDITOR).length === 0, "the dismissed overwrite alerts stay dismissed");
}

console.log("\n[a late refresh carrying a stale lock state still words the alert for the CURRENT lock (issue #1110 review A1)]");
{
  // Lock and unlock in quick succession: the two waitUntil refreshes can finish
  // out of order. The refresh must read the lock when it raises, not trust the
  // value its request saw.
  const { sqlite, env, live } = freshApp();
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", {
    noBaseCount: 1,
    noBaseRefs: ["1:6"],
    noBaseEditorRefs: [{ chapter: 1, verse: 6, version: 2 }],
    observedAt: 1000,
  });
  // The book is now locked; a refresh from an earlier unlock request finishes late.
  sqlite.prepare(`INSERT INTO book_locks (book, locked, set_at) VALUES (?, 1, 2000)`).run(BOOK);
  await refreshVerseMergeAlertsAfterLockChange(env, BOOK, false);
  for (const u of [ADMIN, EDITOR]) {
    const m = live(u)[0]?.message ?? "";
    assert(!/tonight's export/.test(m) && /locked/.test(m), `${u}: the stale "unlocked" refresh still produces the locked wording (got: ${m})`);
  }
  // And the reverse: unlocked now, a late refresh from a lock request.
  sqlite.prepare(`UPDATE book_locks SET locked = 0 WHERE book = ?`).run(BOOK);
  await refreshVerseMergeAlertsAfterLockChange(env, BOOK, true);
  for (const u of [ADMIN, EDITOR]) {
    const m = live(u)[0]?.message ?? "";
    assert(/tonight's export/.test(m), `${u}: the stale "locked" refresh still produces the overwrite wording (got: ${m})`);
  }
}

console.log("\n[a reimport that started before the lock change still lands after it (issue #1110)]");
{
  // The refresh re-words the stored measurement at that measurement's own
  // observation time. A reimport observed later (it started before the lock
  // change, raises after it) must not be dropped as "older than the stored one".
  const { env, lockRoute, live } = freshApp();
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", {
    noBaseCount: 1,
    noBaseRefs: ["1:6"],
    noBaseEditorRefs: [{ chapter: 1, verse: 6, version: 2 }],
    observedAt: 1000,
  });
  await lockRoute("PUT");
  await recordVerseMergeConflicts(env, BOOK, "ust", "UST", [
    {
      chapter: 3, verse: 4, action: "keep_alignment_refused", reason: "alignment_shrink",
      overwrittenVersion: null, alignment: null, observedVersion: null,
    },
  ], 1500);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", {
    noBaseCount: 1,
    noBaseRefs: ["1:6"],
    noBaseEditorRefs: [{ chapter: 1, verse: 6, version: 2 }],
    bookLocked: true,
    observedAt: 1500,
  });
  assert(live(ADMIN)[0]?.message.includes("alignment_shrink: 3:4"), `the later reimport's new verse reaches the alert (got: ${live(ADMIN)[0]?.message})`);
}

console.log("\n[the lock is read only when the alert has a lock-dependent sentence (issue #1110)]");
{
  const { sqlite, env, live } = freshApp();
  let reads = 0;
  const reader = async () => {
    reads++;
    return true;
  };
  sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES ('verse', ?, ?, 7, 4, 'update')`)
    .run(`${BOOK}/2/1/UST`, BOOK);
  await recordVerseMergeConflicts(env, BOOK, "ust", "UST", [
    {
      chapter: 2, verse: 1, action: "adopt_conflict", reason: "both_changed_wording",
      overwrittenVersion: 4, alignment: null, observedVersion: null,
    },
  ], 1000);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", { bookLocked: reader, observedAt: 1000 });
  assert(reads === 0, "an overwrite-only alert spends no D1 read on the lock");

  await recordVerseMergeConflicts(env, BOOK, "ust", "UST", [
    {
      chapter: 1, verse: 8, action: "keep_alignment_refused", reason: "alignment_shrink",
      overwrittenVersion: null, alignment: null, observedVersion: null,
    },
  ], 1000);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", { bookLocked: reader, observedAt: 2000 });
  assert(reads === 1, "a kept row makes the alert read the lock once");
  const admin = live(ADMIN)[0];
  assert(!/tonight's export/.test(admin?.message ?? ""), "locked, kept row only: no claim that tonight's export writes");
  assert(admin?.condition_key.includes(`"keptBookLocked":true`), "locked, kept row only: the key carries the lock");
  assert(!admin?.condition_key.includes("noBaseBookLocked"), "no no-base verse: the no-base lock flag stays out of the key");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll lockAlertRefresh tests passed");
}
