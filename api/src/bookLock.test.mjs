// Regression test for issue #602: POST /books/:book/lock/push created the
// same branchless, allowLocked:true export that #584's
// autoMergeConfirmationRequired (publishedGuard.ts) exists to gate, but
// reached EXPORT_WORKFLOW.create without ever consulting it — the policy
// lived only at the /exports/run call site. bookLock.ts's
// requireAutoMergeConfirmation is the fix: a single choke point, backed by a
// REAL lock lookup against the production schema, that both routes now call.
//
// Run from api/ (needs the sqlite flag):
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/bookLock.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { requireAutoMergeConfirmation } from "./bookLock.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Minimal D1 shim over node:sqlite — same shape reimportJourney.test.mjs and
// exportLockDryRun.test.mjs use. effectiveBookLock only needs
// .prepare().bind().first().
function makeDb(sqlite) {
  const mk = (sql, args) => ({
    sql,
    args,
    bind: (...a) => mk(sql, a),
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
  });
  return { prepare: (sql) => mk(sql, []) };
}

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  return { sqlite, env: { DB: makeDb(sqlite) } };
}

// The shim above deliberately omits .run() — issue INSERTs directly against
// the underlying sqlite handle, same as reimportJourney.test.mjs's fixtures.
function insertLock(sqlite, book, reason) {
  sqlite.prepare(`INSERT INTO book_locks (book, locked, reason) VALUES (?, 1, ?)`).run(book, reason);
}

console.log("\n[POST /books/:book/lock/push's default (empty body → no branchName) on a locked book is refused without allowAutoMerge]");
{
  const { sqlite, env } = freshEnv();
  insertLock(sqlite, "ZEC", "cut release");

  const result = await requireAutoMergeConfirmation(env, "ZEC", {
    allowLocked: true,
    branchName: undefined,
    allowAutoMerge: undefined, // an empty-body call, exactly as bookImport.ts used to reach EXPORT_WORKFLOW.create with
  });

  assert(
    result !== null && result.book === "ZEC" && result.reason === "cut release",
    "an empty-body lock/push against a locked book is now refused by the centralized check (the #602 bypass)",
  );
}

console.log("\n[the route's own 'publish now' acknowledgement (allowAutoMerge:true when branchName is absent) is honored]");
{
  const { sqlite, env } = freshEnv();
  insertLock(sqlite, "ZEC", "cut release");

  const result = await requireAutoMergeConfirmation(env, "ZEC", {
    allowLocked: true,
    branchName: undefined,
    allowAutoMerge: true, // bookImport.ts's route now passes this explicitly for the publish-now path
  });

  assert(result === null, "an explicit allowAutoMerge:true acknowledgement clears the check, matching /exports/run's contract");
}

console.log("\n[a branchName is an equally valid acknowledgement — the review-branch path stays unblocked]");
{
  const { sqlite, env } = freshEnv();
  insertLock(sqlite, "ZEC", "cut release");

  const result = await requireAutoMergeConfirmation(env, "ZEC", {
    allowLocked: true,
    branchName: "review/zec-fix",
    allowAutoMerge: undefined,
  });

  assert(result === null, "branchName alone satisfies the confirmation — no need to also pass allowAutoMerge");
}

console.log("\n[an unlocked book never triggers the check, regardless of allowLocked]");
{
  const { env } = freshEnv();
  // No book_locks row and GEN is in the PUBLISHED_BOOKS snapshot only if
  // it's actually published — use a book with no row and no default lock.
  const result = await requireAutoMergeConfirmation(env, "ZEC", {
    allowLocked: true,
    branchName: undefined,
    allowAutoMerge: undefined,
  });

  assert(result === null, "no book_locks row and no published-default lock means nothing to confirm");
}

console.log("\n[allowLocked:false never triggers the check even against a locked book]");
{
  const { sqlite, env } = freshEnv();
  insertLock(sqlite, "ZEC", "cut release");

  const result = await requireAutoMergeConfirmation(env, "ZEC", {
    allowLocked: false,
    branchName: undefined,
    allowAutoMerge: undefined,
  });

  assert(result === null, "allowLocked:false means this export never bypasses the lock gate in the first place — nothing to confirm");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall bookLock tests passed");
