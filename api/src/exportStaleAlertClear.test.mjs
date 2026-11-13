// Issue #1364: an `export_stale:{book}:{resource}` error alert stayed in the
// badge after a later export of the same pair passed the freshness gate.
// recordStaleSkipAlert writes it through writeAlert, which only replaces an
// older undismissed row when a NEW stale alert is written; nothing removed it
// once checkMasterFreshness reported the pair fresh again.
//
// Drives the REAL ExportWorkflow.exportOne on the REAL migration schema, with
// Door43 replaced by a fetch stub. exportWorkflow.ts imports
// `cloudflare:workers`, which does not exist outside the Workers runtime, so
// this file stubs that one specifier (WorkflowEntrypoint only stores ctx/env)
// and resolves the api's extensionless imports the same way tsResolveHook.mjs
// does. Both hooks are registered here, before the dynamic import, so the file
// runs under the default runner flags with no scripts/run-tests.mjs entry.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/exportStaleAlertClear.test.mjs

import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKERS_STUB = "stub:cloudflare-workers";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: WORKERS_STUB, shortCircuit: true };
    if (specifier.startsWith(".") && !/\.[a-zA-Z0-9]+$/.test(specifier) && context.parentURL) {
      const target = fileURLToPath(new URL(specifier, context.parentURL));
      for (const ext of [".ts", ".mjs", ".js"]) {
        if (existsSync(target + ext)) return { url: pathToFileURL(target + ext).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === WORKERS_STUB) {
      return {
        format: "module",
        source: "export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { ExportWorkflow } = await import("./exportWorkflow.ts");
// Module-private in exportWorkflow.ts (line ~72); keep in sync.
const EXPORT_ALERT_USERNAME = "deferredreward";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const DCS_BASE_URL = "https://dcs.test";
const WATERMARK = "a".repeat(40);
const FOREIGN_HEAD = "b".repeat(40);

// Door43 stand-in. Only the file-head commit lookup answers; every other URL
// (master TSV fetch, contents API, …) is a 404, so the export stops at a
// fail-closed guard after the freshness gate and never reaches a commit.
// `heads` maps a URL-encoded file path fragment to the master head SHA.
function installFetch(heads) {
  globalThis.fetch = async (input) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (!url.startsWith(DCS_BASE_URL)) throw new Error(`test fetch escaped the stub: ${url}`);
    if (url.includes("/commits?sha=master&path=")) {
      for (const [frag, sha] of Object.entries(heads)) {
        if (url.includes(frag)) {
          return new Response(
            JSON.stringify([{ sha, commit: { message: "Edit by a maintainer", author: { email: "someone@example.test" } } }]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
    }
    return new Response("not found", { status: 404 });
  };
}

function freshEnv() {
  // Flipped on by the failure case AFTER its stale setup, so only the clear
  // under test sees the injected error (writeAlert issues the same DELETE).
  const flags = { failAlertClear: false };
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  const stmt = (sql, args = []) => ({
    _sql: sql,
    _args: args,
    bind: (...next) => stmt(sql, next),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => {
      if (flags.failAlertClear && /^DELETE FROM system_alerts/.test(sql.trim()) && String(args[1]).startsWith("export_stale:")) {
        throw new Error("D1 unavailable (injected)");
      }
      return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } };
    },
  });
  const env = {
    DCS_BASE_URL,
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
    BLOBS: { put: async () => ({}) },
  };
  // Two books with TQ rows and a watermark each, so the gate has something to
  // compare against and buildResource renders a non-empty file.
  for (const book of ["JER", "LAM"]) {
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response) VALUES (?, ?, 1, 1, '1:1', 'Q?', 'A.')`,
      )
      .run(`${book}-q1`, book);
    for (const resource of ["tq", "tn"]) {
      sqlite
        .prepare(`INSERT INTO book_resource_syncs (book, resource, source_sha, origin) VALUES (?, ?, ?, 'reimport')`)
        .run(book, resource, WATERMARK);
    }
  }
  const live = (source) =>
    sqlite
      .prepare(
        `SELECT id, severity, message FROM system_alerts
          WHERE username = ? AND source = ? AND dismissed_at IS NULL AND resolved_at IS NULL`,
      )
      .all(EXPORT_ALERT_USERNAME, source);
  const wf = new ExportWorkflow({}, env);
  const exportOne = (book, resource, { dcsAllowed = true, instanceId = "export-test" } = {}) =>
    wf.exportOne(book, resource, instanceId, dcsAllowed, false, new Set(), false);
  return { sqlite, env, live, exportOne, flags };
}

const tqPath = (book) => encodeURIComponent(`tq_${book}.tsv`);

console.log("\n[a stale skip writes export_stale; a later run that passes the gate clears it (issue #1364)]");
{
  const { live, exportOne } = freshEnv();
  installFetch({ [tqPath("JER")]: FOREIGN_HEAD, [tqPath("LAM")]: FOREIGN_HEAD });

  const stale = await exportOne("JER", "tq", { instanceId: "export-night-1" });
  assert(stale.dcsSkippedReason === "stale_master:master_ahead", `night 1 skips on the freshness gate (got ${stale.dcsSkippedReason})`);
  assert(live("export_stale:JER:tq").length === 1, "night 1 writes one undismissed export_stale:JER:tq alert");
  assert(live("export_stale:JER:tq")[0]?.severity === "error", "…as an error, the row that turns the badge red");

  // An unrelated pair also went stale the same night; it must survive JER TQ's clear.
  await exportOne("LAM", "tq", { instanceId: "export-night-1" });
  assert(live("export_stale:LAM:tq").length === 1, "setup: LAM TQ also has an undismissed export_stale alert");

  // Night 2: D1 caught up, master's head equals the watermark for JER TQ only.
  installFetch({ [tqPath("JER")]: WATERMARK, [tqPath("LAM")]: FOREIGN_HEAD });
  const passed = await exportOne("JER", "tq", { instanceId: "export-night-2" });
  assert(
    !String(passed.dcsSkippedReason ?? "").startsWith("stale_master"),
    `night 2 passes the freshness gate (stopped later at: ${passed.dcsSkippedReason})`,
  );
  assert(live("export_stale:JER:tq").length === 0, "night 2 leaves no undismissed, unresolved export_stale:JER:tq row");
  assert(live("export_stale:LAM:tq").length === 1, "a different book's export_stale alert is left alone");
}

console.log("\n[the clear is scoped to the exact (book, resource) that passed]");
{
  const { sqlite, live, exportOne } = freshEnv();
  installFetch({ [tqPath("JER")]: FOREIGN_HEAD });
  await exportOne("JER", "tq");
  // Same book, different resource: a standing TN stale alert from an earlier night.
  sqlite
    .prepare(`INSERT INTO system_alerts (username, severity, source, message, link_url) VALUES (?, 'error', ?, 'JER TN stale', ?)`)
    .run(EXPORT_ALERT_USERNAME, "export_stale:JER:tn", DCS_BASE_URL);
  installFetch({ [tqPath("JER")]: WATERMARK });
  await exportOne("JER", "tq");
  assert(live("export_stale:JER:tq").length === 0, "JER TQ's alert is cleared");
  assert(live("export_stale:JER:tn").length === 1, "the same book's TN export_stale alert is left alone");
}

console.log("\n[a dry run measures nothing, so it must not clear the alert]");
{
  const { live, exportOne } = freshEnv();
  installFetch({ [tqPath("JER")]: FOREIGN_HEAD });
  await exportOne("JER", "tq");
  assert(live("export_stale:JER:tq").length === 1, "setup: the stale alert stands");
  // Door43 would now say fresh, but a dry run never asks it.
  installFetch({ [tqPath("JER")]: WATERMARK });
  await exportOne("JER", "tq", { dcsAllowed: false });
  assert(live("export_stale:JER:tq").length === 1, "a dry run (dcsAllowed=false) leaves the stale alert standing");
}

console.log("\n[a still-stale run replaces the alert rather than clearing it]");
{
  const { live, exportOne } = freshEnv();
  installFetch({ [tqPath("JER")]: FOREIGN_HEAD });
  await exportOne("JER", "tq", { instanceId: "export-night-1" });
  await exportOne("JER", "tq", { instanceId: "export-night-2" });
  assert(live("export_stale:JER:tq").length === 1, "two stale nights leave exactly one undismissed alert");
}

console.log("\n[a dismissed export_stale row is history, not cleared]");
{
  const { sqlite, exportOne } = freshEnv();
  installFetch({ [tqPath("JER")]: FOREIGN_HEAD });
  await exportOne("JER", "tq");
  sqlite.prepare(`UPDATE system_alerts SET dismissed_at = 5000 WHERE source = 'export_stale:JER:tq'`).run();
  installFetch({ [tqPath("JER")]: WATERMARK });
  await exportOne("JER", "tq");
  const n = sqlite.prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = 'export_stale:JER:tq' AND dismissed_at IS NOT NULL`).get().n;
  assert(Number(n) === 1, "the dismissed row survives (writeAlert's dismissal memory, issue #458)");
}

console.log("\n[a failed clear never fails the export]");
{
  const { live, exportOne, flags } = freshEnv();
  installFetch({ [tqPath("JER")]: FOREIGN_HEAD });
  await exportOne("JER", "tq");
  assert(live("export_stale:JER:tq").length === 1, "setup: the stale alert stands");
  flags.failAlertClear = true;
  installFetch({ [tqPath("JER")]: WATERMARK });
  let threw = null;
  let result = null;
  const origError = console.error;
  console.error = () => {};
  try {
    result = await exportOne("JER", "tq");
  } catch (e) {
    threw = e;
  } finally {
    console.error = origError;
  }
  assert(threw === null, `exportOne does not throw when the clear fails (threw: ${threw?.message})`);
  assert(result !== null && !String(result.dcsSkippedReason ?? "").startsWith("stale_master"), "…and it still runs past the gate");
  assert(live("export_stale:JER:tq").length === 1, "…the alert simply stays until a later clear succeeds");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll exportStaleAlertClear assertions passed.");
