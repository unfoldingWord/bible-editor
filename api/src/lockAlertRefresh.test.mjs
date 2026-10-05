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

console.log("\n[a lock change leaves an alert with no lock-dependent wording untouched, even after rows resolved (issue #1110 round 2)]");
{
  // Two overwrites with pointers (nothing lock-dependent), dismissed; one is
  // resolved by a save during the day with no re-raise. A lock toggle must not
  // rebuild the alert from the shrunken live rows: that mints a new key and
  // resurrects what people dismissed.
  const { sqlite, env, lockRoute } = freshApp();
  for (const [verse, version] of [[1, 4], [2, 5]]) {
    sqlite
      .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES ('verse', ?, ?, 7, ?, 'update')`)
      .run(`${BOOK}/2/${verse}/UST`, BOOK, version);
  }
  await recordVerseMergeConflicts(env, BOOK, "ust", "UST", [
    { chapter: 2, verse: 1, action: "adopt_conflict", reason: "both_changed_wording", overwrittenVersion: 4, alignment: null, observedVersion: null },
    { chapter: 2, verse: 2, action: "adopt_conflict", reason: "both_changed_wording", overwrittenVersion: 5, alignment: null, observedVersion: null },
  ], 1000);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", { observedAt: 1000 });
  sqlite.prepare(`UPDATE system_alerts SET dismissed_at = 5000 WHERE source = ? AND resolved_at IS NULL`).run(SOURCE);
  const snapshot = () =>
    sqlite.prepare(`SELECT id, username, condition_key, dismissed_at, resolved_at FROM system_alerts WHERE source = ? ORDER BY id`).all(SOURCE);
  const before = JSON.stringify(snapshot());
  sqlite
    .prepare(`UPDATE verse_merge_conflicts SET resolved_at = 6000, resolved_by = 7 WHERE book = ? AND chapter = 2 AND verse = 2`)
    .run(BOOK);
  await lockRoute("PUT");
  await lockRoute("DELETE");
  assert(JSON.stringify(snapshot()) === before, "the dismissed alerts and their keys are untouched; no new row is minted");
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

console.log("\n[a dismissed mixed alert whose only lock-dependent row resolved stays dismissed across a lock toggle (issue #1118 item 2)]");
{
  // An overwrite with a pointer (wording independent of the lock) plus a kept
  // row (wording depends on the lock), raised unlocked and dismissed. The kept
  // row is resolved by a save during the day, with no re-raise. The stored key
  // still lists the kept row, but the live rows hold nothing whose wording a
  // lock changes: a lock toggle has nothing to re-word and must not rebuild the
  // alert from the shrunken live rows (that mints a new key and brings the
  // dismissed alert back).
  const { sqlite, env, lockRoute } = freshApp();
  sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES ('verse', ?, ?, 7, 4, 'update')`)
    .run(`${BOOK}/2/1/UST`, BOOK);
  await recordVerseMergeConflicts(env, BOOK, "ust", "UST", [
    { chapter: 2, verse: 1, action: "adopt_conflict", reason: "both_changed_wording", overwrittenVersion: 4, alignment: null, observedVersion: null },
    { chapter: 1, verse: 8, action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null, alignment: null, observedVersion: null },
  ], 1000);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", { observedAt: 1000 });
  sqlite.prepare(`UPDATE system_alerts SET dismissed_at = 5000 WHERE source = ? AND resolved_at IS NULL`).run(SOURCE);
  const snapshot = () =>
    sqlite.prepare(`SELECT id, username, condition_key, dismissed_at, resolved_at FROM system_alerts WHERE source = ? ORDER BY id`).all(SOURCE);
  const before = JSON.stringify(snapshot());
  sqlite
    .prepare(`UPDATE verse_merge_conflicts SET resolved_at = 6000, resolved_by = 7 WHERE book = ? AND chapter = 1 AND verse = 8`)
    .run(BOOK);
  await lockRoute("PUT");
  assert(JSON.stringify(snapshot()) === before, `lock: the dismissed alerts and their keys are untouched (got ${JSON.stringify(snapshot())})`);
  await lockRoute("DELETE");
  assert(JSON.stringify(snapshot()) === before, "unlock: still untouched, no new row is minted");
}

console.log("\n[a refresh whose lock read went stale before its write re-checks and ends on the current lock (issue #1118 item 3)]");
{
  // Lock, then a quick unlock. The lock's refresh reads "locked" just before
  // the unlock lands, the unlock's refresh runs and finishes first (nothing to
  // re-word yet), then the lock's refresh writes the locked wording. Simulated
  // by serving the first lock read as locked while book_locks says unlocked.
  const { sqlite, env, live } = freshApp();
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", {
    noBaseCount: 1,
    noBaseRefs: ["1:6"],
    noBaseEditorRefs: [{ chapter: 1, verse: 6, version: 2 }],
    observedAt: 1000,
  });
  sqlite.prepare(`INSERT INTO book_locks (book, locked, set_at) VALUES (?, 0, 2000)`).run(BOOK);
  let staleReads = 1;
  const staleEnv = {
    ...env,
    DB: {
      ...env.DB,
      prepare: (sql) => {
        const s = env.DB.prepare(sql);
        if (!/FROM book_locks/.test(sql)) return s;
        return {
          ...s,
          bind: (...args) => {
            const b = s.bind(...args);
            return {
              ...b,
              first: async () => (staleReads-- > 0 ? { locked: 1, reason: null } : b.first()),
            };
          },
        };
      },
    },
  };
  await refreshVerseMergeAlertsAfterLockChange(staleEnv, BOOK);
  for (const u of [ADMIN, EDITOR]) {
    const m = live(u)[0]?.message ?? "";
    assert(/tonight's export/.test(m), `${u}: the book is unlocked, so the alert ends with the overwrite wording (got: ${m})`);
  }
}

console.log("\n[an UNDISMISSED locked alert whose only kept row resolved loses its locked wording on unlock (#1118 review, Cursor)]");
{
  // Raised while locked with an overwrite (pointer) and a kept row, so its key
  // carries keptBookLocked. The kept row is resolved during the day; the
  // overwrite keeps the banner up. Nobody dismissed it. On unlock the standing
  // alert must not keep the locked key: the guard against rebuilding from live
  // rows protects DISMISSED alerts only.
  const { sqlite, env, lockRoute, live } = freshApp();
  sqlite.prepare(`INSERT INTO book_locks (book, locked, set_at) VALUES (?, 1, 900)`).run(BOOK);
  sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES ('verse', ?, ?, 7, 4, 'update')`)
    .run(`${BOOK}/2/1/UST`, BOOK);
  await recordVerseMergeConflicts(env, BOOK, "ust", "UST", [
    { chapter: 2, verse: 1, action: "adopt_conflict", reason: "both_changed_wording", overwrittenVersion: 4, alignment: null, observedVersion: null },
    { chapter: 1, verse: 8, action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null, alignment: null, observedVersion: null },
  ], 1000);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", { bookLocked: true, observedAt: 1000 });
  assert(live(ADMIN)[0]?.condition_key.includes(`"keptBookLocked":true`), "setup: the locked admin key carries keptBookLocked");
  sqlite
    .prepare(`UPDATE verse_merge_conflicts SET resolved_at = 6000, resolved_by = 7 WHERE book = ? AND chapter = 1 AND verse = 8`)
    .run(BOOK);
  await lockRoute("DELETE");
  const admin = live(ADMIN);
  assert(admin.length === 1, `after the unlock, one undismissed admin alert stands (got ${admin.length})`);
  assert(!admin[0]?.condition_key.includes("keptBookLocked"), `after the unlock, the admin key no longer carries the lock (got ${admin[0]?.condition_key})`);
  assert(!/locked/.test(admin[0]?.message ?? ""), `after the unlock, the admin message no longer names the lock (got ${admin[0]?.message})`);
}

console.log("\n[a pass whose raise writes nothing stops the refresh instead of repeating it (#1118 review, Cursor)]");
{
  // The lock says the wording must change, but every system_alerts write fails
  // (the raise logs and returns). The refresh must notice the stored key did
  // not change and stop, not repeat to its pass cap and warn that the lock
  // kept changing.
  const { sqlite, env, live } = freshApp();
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", {
    noBaseCount: 1,
    noBaseRefs: ["1:6"],
    noBaseEditorRefs: [{ chapter: 1, verse: 6, version: 2 }],
    observedAt: 1000,
  });
  const keyBefore = live(ADMIN)[0]?.condition_key;
  sqlite.prepare(`INSERT INTO book_locks (book, locked, set_at) VALUES (?, 1, 2000)`).run(BOOK);
  let conflictReads = 0;
  const failingEnv = {
    ...env,
    DB: {
      ...env.DB,
      prepare: (sql) => {
        if (/FROM verse_merge_conflicts/.test(sql)) conflictReads++;
        if (/^\s*(INSERT|UPDATE|DELETE)[\s\S]*system_alerts/i.test(sql)) throw new Error("simulated system_alerts write failure");
        return env.DB.prepare(sql);
      },
    },
  };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    await refreshVerseMergeAlertsAfterLockChange(failingEnv, BOOK);
  } finally {
    console.warn = realWarn;
  }
  assert(live(ADMIN)[0]?.condition_key === keyBefore, "setup: the failed writes left the stored key as it was");
  assert(!warnings.some((w) => /kept changing/.test(w)), `no "lock kept changing" warning when the lock is stable (got: ${JSON.stringify(warnings)})`);
  assert(conflictReads <= 4, `the refresh stopped after the pass that wrote nothing (conflict-table reads: ${conflictReads})`);
}

console.log("\n[an UNDISMISSED unlocked alert whose kept row resolved is rebuilt from live rows on a lock toggle (#1118 re-review)]");
{
  // Raised unlocked with an overwrite (pointer) and a kept row; a save resolves
  // the kept row; the overwrite keeps the banner up. Nobody dismissed it. On
  // main a lock refresh rebuilt it from live rows (dropping the resolved row);
  // the refresh must still do that for an undismissed alert.
  const { sqlite, env, lockRoute, live } = freshApp();
  sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES ('verse', ?, ?, 7, 4, 'update')`)
    .run(`${BOOK}/2/1/UST`, BOOK);
  await recordVerseMergeConflicts(env, BOOK, "ust", "UST", [
    { chapter: 2, verse: 1, action: "adopt_conflict", reason: "both_changed_wording", overwrittenVersion: 4, alignment: null, observedVersion: null },
    { chapter: 1, verse: 8, action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null, alignment: null, observedVersion: null },
  ], 1000);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", { observedAt: 1000 });
  assert(live(ADMIN)[0]?.condition_key.includes("alignment_shrink"), "setup: the admin key lists the kept row");
  sqlite
    .prepare(`UPDATE verse_merge_conflicts SET resolved_at = 6000, resolved_by = 7 WHERE book = ? AND chapter = 1 AND verse = 8`)
    .run(BOOK);
  await lockRoute("PUT");
  const admin = live(ADMIN);
  assert(admin.length === 1, `after the lock, one undismissed admin alert stands (got ${admin.length})`);
  assert(!admin[0]?.condition_key.includes("alignment_shrink"), `after the lock, the resolved kept row is gone from the key (got ${admin[0]?.condition_key})`);
  assert(!/alignment_shrink|1:8/.test(admin[0]?.message ?? ""), `after the lock, the message no longer names the resolved kept row (got ${admin[0]?.message})`);
}

console.log("\n[an UNDISMISSED locked no-base alert whose kept row resolved is rebuilt on a second lock (#1118 re-review)]");
{
  // Raised locked with a no-ancestor verse and a kept row; the kept row is
  // resolved; the lock is set again. The lock flags already match, but the
  // undismissed alert still lists the resolved row, so it is rebuilt.
  const { sqlite, env, lockRoute, live } = freshApp();
  sqlite.prepare(`INSERT INTO book_locks (book, locked, set_at) VALUES (?, 1, 900)`).run(BOOK);
  await recordVerseMergeConflicts(env, BOOK, "ust", "UST", [
    { chapter: 1, verse: 8, action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null, alignment: null, observedVersion: null },
  ], 1000);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", {
    noBaseCount: 1,
    noBaseRefs: ["1:6"],
    noBaseEditorRefs: [{ chapter: 1, verse: 6, version: 2 }],
    bookLocked: true,
    observedAt: 1000,
  });
  assert(live(ADMIN)[0]?.condition_key.includes("alignment_shrink"), "setup: the locked admin key lists the kept row");
  sqlite
    .prepare(`UPDATE verse_merge_conflicts SET resolved_at = 6000, resolved_by = 7 WHERE book = ? AND chapter = 1 AND verse = 8`)
    .run(BOOK);
  await lockRoute("PUT");
  const admin = live(ADMIN);
  assert(admin.length === 1, `after the second lock, one undismissed admin alert stands (got ${admin.length})`);
  assert(!admin[0]?.condition_key.includes("alignment_shrink"), `after the second lock, the resolved kept row is gone from the key (got ${admin[0]?.condition_key})`);
  assert(admin[0]?.condition_key.includes(`"noBaseBookLocked":true`), "…and the no-base verse keeps the locked wording");
  assert(!/tonight's export/.test(admin[0]?.message ?? ""), "…with no claim that tonight's export writes");
}

// Wraps env so `afterRead(n)` runs right after the nth read of
// verse_merge_conflicts completes: a save or a reimport landing between two
// reads of the refresh.
function afterConflictReads(env, afterRead) {
  let n = 0;
  const wrap = (s) => ({
    ...s,
    bind: (...args) => wrap(s.bind(...args)),
    all: async () => {
      const r = await s.all();
      afterRead(++n);
      return r;
    },
  });
  return {
    ...env,
    DB: {
      ...env.DB,
      prepare: (sql) => (/FROM verse_merge_conflicts/.test(sql) ? wrap(env.DB.prepare(sql)) : env.DB.prepare(sql)),
    },
  };
}

console.log("\n[a save resolving the last lock-dependent row between the refresh's read and the raise leaves a dismissed alert dismissed (#1129 item 1)]");
{
  // A dismissed mixed alert (an overwrite with a pointer, plus a kept row whose
  // wording depends on the lock), raised unlocked. The book is locked. The
  // refresh reads the live rows, sees the kept row, and decides to re-word;
  // then a save resolves the kept row before the raise reads the rows again.
  // The raise must not rebuild the alert from the smaller set: nothing left in
  // it depends on the lock, and people dismissed it.
  const { sqlite, env } = freshApp();
  sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES ('verse', ?, ?, 7, 4, 'update')`)
    .run(`${BOOK}/2/1/UST`, BOOK);
  await recordVerseMergeConflicts(env, BOOK, "ust", "UST", [
    { chapter: 2, verse: 1, action: "adopt_conflict", reason: "both_changed_wording", overwrittenVersion: 4, alignment: null, observedVersion: null },
    { chapter: 1, verse: 8, action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null, alignment: null, observedVersion: null },
  ], 1000);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", { observedAt: 1000 });
  sqlite.prepare(`UPDATE system_alerts SET dismissed_at = 5000 WHERE source = ? AND resolved_at IS NULL`).run(SOURCE);
  const snapshot = () =>
    sqlite.prepare(`SELECT id, username, condition_key, dismissed_at, resolved_at FROM system_alerts WHERE source = ? ORDER BY id`).all(SOURCE);
  const before = JSON.stringify(snapshot());
  sqlite.prepare(`INSERT INTO book_locks (book, locked, set_at) VALUES (?, 1, 2000)`).run(BOOK);
  const racingEnv = afterConflictReads(env, (n) => {
    if (n === 1) {
      sqlite
        .prepare(`UPDATE verse_merge_conflicts SET resolved_at = 6000, resolved_by = 7 WHERE book = ? AND chapter = 1 AND verse = 8`)
        .run(BOOK);
    }
  });
  await refreshVerseMergeAlertsAfterLockChange(racingEnv, BOOK);
  assert(JSON.stringify(snapshot()) === before, `the dismissed alerts and their keys are untouched; no new row is minted (got ${JSON.stringify(snapshot())})`);
}

console.log("\n[key churn from concurrent saves with a stable lock does not blame the lock (#1129 item 3)]");
{
  // An undismissed overwrite-only alert on an unlocked book. Every read of the
  // conflict table is followed by a new overwrite landing (a reimport recording
  // rows), so every pass re-keys the alert and the refresh reaches its pass
  // cap. The lock never changed, so the warning must not say it did.
  const { sqlite, env } = freshApp();
  sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES ('verse', ?, ?, 7, 4, 'update')`)
    .run(`${BOOK}/2/1/UST`, BOOK);
  await recordVerseMergeConflicts(env, BOOK, "ust", "UST", [
    { chapter: 2, verse: 1, action: "adopt_conflict", reason: "both_changed_wording", overwrittenVersion: 4, alignment: null, observedVersion: null },
  ], 1000);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", { observedAt: 1000 });
  const churnEnv = afterConflictReads(env, (n) => {
    sqlite
      .prepare(
        `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
         VALUES (?, 'ust', 3, ?, 'adopt_conflict', 'both_changed_wording', 9, 1000)`,
      )
      .run(BOOK, n);
  });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    await refreshVerseMergeAlertsAfterLockChange(churnEnv, BOOK);
  } finally {
    console.warn = realWarn;
  }
  assert(warnings.some((w) => /kept changing/.test(w)), `setup: the churn drove the refresh to its pass cap (got: ${JSON.stringify(warnings)})`);
  assert(!warnings.some((w) => /lock kept changing/.test(w)), `the cap warning does not blame a lock that never changed (got: ${JSON.stringify(warnings)})`);
  // #1129 review A2: nothing in this alert depends on the lock, so no pass read
  // it; the warning must not claim the reads agreed.
  assert(
    warnings.some((w) => /lock was not read/.test(w)) && !warnings.some((w) => /read the same each time/.test(w)),
    `the cap warning says the lock was never read (got: ${JSON.stringify(warnings)})`,
  );
}

console.log("\n[a failing lock read during key churn is reported as such, not as a stable lock (#1129 review A2)]");
{
  // A no-base alert (its wording depends on the lock), key churn from
  // concurrent overwrites, and every lock read failing. The fallback wording
  // is the unlocked one, but the warning must say the lock could not be read.
  const { sqlite, env } = freshApp();
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", {
    noBaseCount: 1,
    noBaseRefs: ["1:6"],
    noBaseEditorRefs: [{ chapter: 1, verse: 6, version: 2 }],
    observedAt: 1000,
  });
  const churnEnv = afterConflictReads(env, (n) => {
    sqlite
      .prepare(
        `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
         VALUES (?, 'ust', 3, ?, 'adopt_conflict', 'both_changed_wording', 9, 1000)`,
      )
      .run(BOOK, n);
  });
  const failingLockEnv = {
    ...churnEnv,
    DB: {
      ...churnEnv.DB,
      prepare: (sql) => {
        if (/FROM book_locks/.test(sql)) throw new Error("simulated book_locks read failure");
        return churnEnv.DB.prepare(sql);
      },
    },
  };
  const warnings = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  console.error = () => {};
  try {
    await refreshVerseMergeAlertsAfterLockChange(failingLockEnv, BOOK);
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
  assert(warnings.some((w) => /lock could not be read/.test(w)), `the cap warning says the lock read failed (got: ${JSON.stringify(warnings)})`);
  assert(!warnings.some((w) => /read the same each time/.test(w)), `…and does not claim a stable lock (got: ${JSON.stringify(warnings)})`);
}

console.log("\n[a dismissed editor alert survives a lock toggle when only its own refs changed (#1129 item 4)]");
{
  // Two overwrites (pointers) of the editor's work. The editor dismissed their
  // alert; the admin did not. A save resolves one of them during the day. A
  // lock toggle rebuilds the undismissed admin alert from the live rows, but
  // nothing in the editor's alert depends on the lock, so it stays dismissed.
  const { sqlite, env, lockRoute, live } = freshApp();
  for (const [verse, version] of [[1, 4], [2, 5]]) {
    sqlite
      .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES ('verse', ?, ?, 7, ?, 'update')`)
      .run(`${BOOK}/2/${verse}/UST`, BOOK, version);
  }
  await recordVerseMergeConflicts(env, BOOK, "ust", "UST", [
    { chapter: 2, verse: 1, action: "adopt_conflict", reason: "both_changed_wording", overwrittenVersion: 4, alignment: null, observedVersion: null },
    { chapter: 2, verse: 2, action: "adopt_conflict", reason: "both_changed_wording", overwrittenVersion: 5, alignment: null, observedVersion: null },
  ], 1000);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", { observedAt: 1000 });
  assert(live(EDITOR).length === 1, "setup: the editor has an alert");
  sqlite.prepare(`UPDATE system_alerts SET dismissed_at = 5000 WHERE source = ? AND username = ? AND resolved_at IS NULL`).run(SOURCE, EDITOR);
  sqlite
    .prepare(`UPDATE verse_merge_conflicts SET resolved_at = 6000, resolved_by = 7 WHERE book = ? AND chapter = 2 AND verse = 2`)
    .run(BOOK);
  await lockRoute("PUT");
  await lockRoute("DELETE");
  assert(live(EDITOR).length === 0, `the dismissed editor alert stays dismissed (got ${JSON.stringify(live(EDITOR))})`);
  const admin = live(ADMIN);
  assert(admin.length === 1 && !/2:2/.test(admin[0]?.message ?? ""), `the undismissed admin alert is still rebuilt from the live rows (got ${admin[0]?.message})`);
}

console.log("\n[an undismissed editor alert is re-worded even when the admin's dismissed alert already matches the lock (#1129 item 4)]");
{
  // The admin's alert carries the locked wording and was dismissed; the
  // editor's alert still carries the unlocked wording (its write never landed)
  // and is undismissed. A lock refresh must fix the editor's wording, not stop
  // at the admin's dismissed row.
  const { sqlite, env, live } = freshApp();
  const noBase = {
    noBaseCount: 1,
    noBaseRefs: ["1:6"],
    noBaseEditorRefs: [{ chapter: 1, verse: 6, version: 2 }],
  };
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", { ...noBase, observedAt: 1000 });
  const unlockedEditor = live(EDITOR)[0];
  sqlite.prepare(`INSERT INTO book_locks (book, locked, set_at) VALUES (?, 1, 1500)`).run(BOOK);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", { ...noBase, bookLocked: true, observedAt: 2000 });
  sqlite
    .prepare(`UPDATE system_alerts SET condition_key = ?, message = ? WHERE id = ?`)
    .run(unlockedEditor.condition_key, unlockedEditor.message, live(EDITOR)[0].id);
  sqlite.prepare(`UPDATE system_alerts SET dismissed_at = 5000 WHERE source = ? AND username = ? AND resolved_at IS NULL`).run(SOURCE, ADMIN);
  await refreshVerseMergeAlertsAfterLockChange(env, BOOK);
  const m = live(EDITOR)[0]?.message ?? "";
  assert(!/tonight's export/.test(m) && /locked/.test(m), `the editor's alert now carries the locked wording (got: ${m})`);
  assert(live(ADMIN).length === 0, "the admin's dismissed alert stays dismissed");
}

console.log("\n[a dismissed editor alert with the other lock wording is corrected even when the admin's dismissed alert matches (#1129 review A1)]");
{
  // Raised unlocked with a no-ancestor verse. The editor's write of the locked
  // wording landed once (an earlier refresh) but the admin's did not: the
  // editor's key carries the lock flag on an unlocked book. Both are
  // dismissed. A lock refresh on the still-unlocked book must re-word the
  // editor's alert so it warns about tonight's export again (#1006), and leave
  // the admin's matching dismissed alert alone.
  const { sqlite, env, live } = freshApp();
  const noBase = {
    noBaseCount: 1,
    noBaseRefs: ["1:6"],
    noBaseEditorRefs: [{ chapter: 1, verse: 6, version: 2 }],
  };
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", { ...noBase, observedAt: 1000 });
  const editorRow = live(EDITOR)[0];
  sqlite
    .prepare(`UPDATE system_alerts SET condition_key = ?, message = 'locked wording (book locked; an admin pushes it)' WHERE id = ?`)
    .run(verseMergeEditorConditionKey(BOOK, "ust", EDITOR, ["1:6"], true), editorRow.id);
  sqlite.prepare(`UPDATE system_alerts SET dismissed_at = 5000 WHERE source = ? AND resolved_at IS NULL`).run(SOURCE);
  const adminBefore = JSON.stringify(
    sqlite.prepare(`SELECT id, condition_key, dismissed_at, resolved_at FROM system_alerts WHERE source = ? AND username = ?`).all(SOURCE, ADMIN),
  );
  await refreshVerseMergeAlertsAfterLockChange(env, BOOK);
  const m = live(EDITOR)[0]?.message ?? "";
  assert(/tonight's export/.test(m), `the editor's alert is re-worded for the unlocked book and stands again (got: ${m})`);
  assert(
    JSON.stringify(
      sqlite.prepare(`SELECT id, condition_key, dismissed_at, resolved_at FROM system_alerts WHERE source = ? AND username = ?`).all(SOURCE, ADMIN),
    ) === adminBefore,
    "the admin's matching dismissed alert is untouched",
  );
}

console.log("\n[a failed lock read does not bring back dismissed locked alerts (#1129 review B1)]");
{
  // The book is locked; the admin's and editor's no-base alerts carry the
  // locked wording and were dismissed. A refresh whose lock read throws falls
  // back to the unlocked wording, but must not resurface a dismissed alert on
  // a lock it could not read.
  const { sqlite, env } = freshApp();
  sqlite.prepare(`INSERT INTO book_locks (book, locked, set_at) VALUES (?, 1, 900)`).run(BOOK);
  await raiseVerseMergeConflictAlert(env, BOOK, "ust", {
    noBaseCount: 1,
    noBaseRefs: ["1:6"],
    noBaseEditorRefs: [{ chapter: 1, verse: 6, version: 2 }],
    bookLocked: true,
    observedAt: 1000,
  });
  sqlite.prepare(`UPDATE system_alerts SET dismissed_at = 5000 WHERE source = ? AND resolved_at IS NULL`).run(SOURCE);
  const snapshot = () =>
    sqlite.prepare(`SELECT id, username, condition_key, dismissed_at, resolved_at FROM system_alerts WHERE source = ? ORDER BY id`).all(SOURCE);
  const before = JSON.stringify(snapshot());
  assert(JSON.parse(before).length === 2, "setup: an admin and an editor alert stand, both dismissed");
  const failingLockEnv = {
    ...env,
    DB: {
      ...env.DB,
      prepare: (sql) => {
        if (/FROM book_locks/.test(sql)) throw new Error("simulated book_locks read failure");
        return env.DB.prepare(sql);
      },
    },
  };
  const realError = console.error;
  console.error = () => {};
  try {
    await refreshVerseMergeAlertsAfterLockChange(failingLockEnv, BOOK);
  } finally {
    console.error = realError;
  }
  assert(JSON.stringify(snapshot()) === before, `nothing resurfaces and no row is minted (got ${JSON.stringify(snapshot())})`);
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll lockAlertRefresh tests passed");
}
