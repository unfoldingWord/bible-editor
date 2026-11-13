// Regression tests for the `export_lock_override:{book}:{resource}` row that
// exportWorkflow.ts's exportOne writes whenever a human bypasses the book-lock
// guard (`allowLocked` on a locked book — the admin panel's "Lock & push").
//
// Issue #1363 (current shape): the row is a durable RECORD of the bypass, not a
// decision anyone still has to make, so it is written `kind='record'`. It must
// stay out of the personal sync-warnings badge (GET /api/alerts/me, which shows
// only kind='review') and show up in the admin activity log
// (GET /api/admin/sync-activity, which shows only kind='record') — the split
// issue #535 drew. Before the fix it was written as the default 'review', so
// every Lock & push put five info rows (one per resource) in the badge.
//
// Carried forward from earlier issues:
//   - #514: the message carries the run's instanceId, so every bypass leaves
//     its own row (the audit trail stays per-run).
//   - #587: a dry-run bypass (no Door43 push) still leaves a row, and its
//     message says it was a dry run.
//
// Driven through the REAL code: exportOne on a real ExportWorkflow instance,
// and the REAL alerts / admin Hono routers, over every api/migrations/*.sql.
// exportWorkflow.ts imports `cloudflare:workers` (WorkflowEntrypoint), which
// does not exist under Node, so a load hook below supplies a stub base class
// before the module is imported dynamically. The static-import-free shape is
// deliberate: static imports are hoisted above the hook registration.
//
// Run from api/:
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/lockOverrideAlert.test.mjs

import "./tsResolveHook.mjs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: "stub:cloudflare-workers", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "stub:cloudflare-workers") {
      return {
        format: "module",
        source: "export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { Hono } = await import("hono");
const { ExportWorkflow } = await import("./exportWorkflow.ts");
const { alerts } = await import("./alerts.ts");
const { admin } = await import("./admin.ts");

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Nothing in this test may reach the network.
globalThis.fetch = async (url) => {
  throw new Error(`unexpected fetch in lockOverrideAlert.test.mjs: ${url}`);
};

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

// exportWorkflow.ts's EXPORT_ALERT_USERNAME: the account whose badge the
// export alerts land in. The test reads /api/alerts/me AS this user, so an
// "absent from the badge" result cannot pass just by asking as someone else.
const EXPORT_ALERT_USERNAME = "deferredreward";
const BOOK = "REV";
const RESOURCE = "ult";
const SOURCE = `export_lock_override:${BOOK}:${RESOURCE}`;

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 101, ?)`).run(EXPORT_ALERT_USERNAME);
  sqlite.prepare(`INSERT OR IGNORE INTO user_roles (dcs_username, role) VALUES (?, 'admin')`).run(EXPORT_ALERT_USERNAME);
  // Control row: a genuine review alert for the same user, so the badge feed
  // is proven to return this user's rows (an empty feed proves nothing).
  sqlite
    .prepare(
      `INSERT INTO system_alerts (username, severity, source, message, link_url) VALUES (?, 'error', 'control_review', 'a real problem', NULL)`,
    )
    .run(EXPORT_ALERT_USERNAME);
  const env = { DB: makeDb(sqlite), DCS_BASE_URL: "https://dcs.example.test" };

  const app = new Hono();
  // Stand in for attachAuth: requireAuth / requireAdmin read these.
  app.use("*", async (c, next) => {
    c.set("userId", 1);
    c.set("username", EXPORT_ALERT_USERNAME);
    c.set("role", "admin");
    await next();
  });
  app.route("/api/alerts", alerts);
  app.route("/api/admin", admin);
  const get = async (path) => {
    const res = await app.request(path, {}, env);
    if (res.status !== 200) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  };

  // A real ExportWorkflow instance without running its constructor's runtime
  // wiring: exportOne only needs `this.env` and its own private methods.
  const wf = Object.create(ExportWorkflow.prototype);
  wf.env = env;
  // exportOne with allowLocked on a locked book: the exact call a Lock & push
  // makes per (book, resource). dcsAllowed=false keeps it a dry run; with no
  // verses seeded the render is empty and exportOne returns `no_rows` right
  // after the lock-override write, so nothing past it needs a binding.
  const lockPush = (instanceId, { dcsAllowed = false } = {}) =>
    wf.exportOne(BOOK, RESOURCE, instanceId, dcsAllowed, false, new Set([BOOK]), true);

  return { sqlite, get, lockPush };
}

const overrideRows = (sqlite) =>
  sqlite.prepare(`SELECT kind, severity, message, event_key FROM system_alerts WHERE source = ? ORDER BY id`).all(SOURCE);

const RUN_1 = "export-2026-11-13T15-00-00-000Z-run1";
const RUN_2 = "export-2026-11-13T16-00-00-000Z-run2";

console.log("\n[issue #1363: a Lock & push writes the override as a record, not a badge alert]");
{
  const { sqlite, get, lockPush } = freshEnv();
  const result = await lockPush(RUN_1);
  eq(result.dcsSkippedReason, "no_rows", "setup: exportOne ran past the lock gate to the (empty) render");

  const rows = overrideRows(sqlite);
  eq(rows.length, 1, "the bypass leaves exactly one override row");
  eq(rows[0]?.kind, "record", "the override row is kind='record'");
  eq(rows[0]?.severity, "info", "severity stays 'info'");
  eq(rows[0]?.message.includes(RUN_1), true, "the message names the run (instanceId) — per-run audit trail (#514)");
  eq(rows[0]?.message.includes("(dry run"), true, "a dry-run bypass says so (#587)");

  const me = await get("/api/alerts/me");
  eq(me.alerts.some((a) => a.source === "control_review"), true, "control: the badge feed returns this user's review rows");
  eq(me.alerts.some((a) => a.source === SOURCE), false, "the override row is NOT in /api/alerts/me (the badge)");

  const activity = await get("/api/admin/sync-activity");
  const logged = activity.entries.filter((e) => e.source === SOURCE);
  eq(logged.length, 1, "the override row IS in /api/admin/sync-activity");
  eq(logged[0]?.message.includes(RUN_1), true, "the activity-log entry carries the run id");
}

console.log("\n[each Lock & push keeps its own record; a retried step does not duplicate one]");
{
  const { sqlite, get, lockPush } = freshEnv();
  await lockPush(RUN_1);
  // The workflow wraps exportOne in a retried step.do; a replay of the same
  // run must not add a second record for the same (run, book, resource).
  await lockPush(RUN_1);
  eq(overrideRows(sqlite).length, 1, "a replay of the same run leaves one record, not two");

  // A later, separate Lock & push of the same book+resource is a new event.
  await lockPush(RUN_2, { dcsAllowed: true });
  const activity = await get("/api/admin/sync-activity");
  const logged = activity.entries.filter((e) => e.source === SOURCE);
  eq(logged.length, 2, "two separate pushes leave two activity-log entries");
  eq(logged.some((e) => e.message.includes(RUN_2) && !e.message.includes("(dry run")), true, "the live push's entry names its run and is not marked dry run");
  const me = await get("/api/alerts/me");
  eq(me.alerts.some((a) => a.source === SOURCE), false, "neither push reaches the badge");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll lockOverrideAlert assertions passed.");
