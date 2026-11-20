// #1403 journey: the REAL ExportWorkflow.exportOne on the REAL migration
// schema, with Door43 replaced by an in-memory stand-in (master file, one
// export branch, the contents/refs/raw endpoints commitToDcs and the guards
// call) and R2 by a Map. Same loader hooks as exportStaleAlertClear.test.mjs:
// exportWorkflow.ts imports `cloudflare:workers`, stubbed here.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/keepMasterJourney.test.mjs
//
// Each case seeds D1, establishes "our last push" the way production does
// (an export whose render master already holds → unchanged + confirmed, or a
// push whose PR merged per the dcs_commits ledger, or one that never merged),
// changes master like a person editing on Door43, and exports again.

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
const EXPORT_ALERT_USERNAME = "deferredreward"; // module-private in exportWorkflow.ts

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else console.log(`  ok: ${msg}`);
}

const DCS_BASE_URL = "https://dcs.test";
const WATERMARK = "a".repeat(40);
const BOOK = "OBA";
const FILE = `tn_${BOOK}.tsv`;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

// Door43 stand-in. `master` is the file on master; `branch` the file on the
// export branch (null = not on the branch yet). master's head commit always
// equals the D1 watermark, i.e. the nightly sync ran after the Door43 edit
// but (like the preserved notes of #1347) did not bring it into D1.
function door43() {
  const d = { master: null, branch: null, writes: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(typeof input === "string" ? input : input.url));
    const method = (init.method ?? "GET").toUpperCase();
    if (url.origin !== DCS_BASE_URL) throw new Error(`test fetch escaped the stub: ${url}`);
    const p = url.pathname;
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (p.endsWith("/commits") && url.searchParams.get("sha") === "master") {
      return json([{ sha: WATERMARK, commit: { message: `Update ${FILE}`, author: { email: "editor@example.test" } } }]);
    }
    if (p.endsWith(`/raw/${FILE}`)) {
      return d.master == null ? new Response("nf", { status: 404 }) : new Response(d.master);
    }
    if (p.endsWith(`/contents/${FILE}`)) {
      if (method === "GET") {
        const ref = url.searchParams.get("ref");
        const text = ref === "master" || ref === WATERMARK ? d.master : d.branch;
        if (text == null) return new Response("nf", { status: 404 });
        // d.noSize: Door43 gives no byte count, so the master read cannot be
        // proven complete (fetchDcsMasterTextVerified's `verified`).
        const size = d.noSize ? undefined : Buffer.byteLength(text);
        return json({ sha: "blob-" + text.length, size, content: b64(text), encoding: "base64" });
      }
      const body = JSON.parse(init.body);
      d.branch = unb64(body.content);
      d.writes.push(d.branch);
      return json({ content: { sha: "newblob" }, commit: { sha: "c".repeat(40) } }, 201);
    }
    if (p.endsWith("/git/refs/heads/master")) return json({ object: { sha: WATERMARK } });
    if (p.includes("/git/refs/heads/") && method === "PATCH") return json({ ok: true });
    if (p.includes("/branches/") && method === "GET") return json({ name: "b" });
    return new Response("not found", { status: 404 });
  };
  return d;
}

function freshEnv(rows) {
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
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  });
  const r2 = new Map();
  const env = {
    DCS_BASE_URL,
    DCS_SERVICE_TOKEN: "t",
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
    BLOBS: {
      put: async (key, body, opts = {}) => {
        r2.set(key, { body: String(body), customMetadata: opts.customMetadata ?? {} });
        return {};
      },
      get: async (key) => {
        const o = r2.get(key);
        return o ? { text: async () => o.body, customMetadata: o.customMetadata } : null;
      },
      head: async (key) => {
        const o = r2.get(key);
        return o ? { customMetadata: o.customMetadata } : null;
      },
    },
  };
  for (const [id, verse, note] of rows) {
    sqlite
      .prepare(
        `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, support_reference, quote, occurrence, note)
         VALUES (?, ?, 1, ?, ?, 'rc://*/ta/man/translate/figs-metaphor', 'q', 1, ?)`,
      )
      .run(id, BOOK, verse, `1:${verse}`, note);
  }
  sqlite
    .prepare(`INSERT INTO book_resource_syncs (book, resource, source_sha, origin) VALUES (?, 'tn', ?, 'reimport')`)
    .run(BOOK, WATERMARK);
  const wf = new ExportWorkflow({}, env);
  const exportOne = (instanceId, dcsAllowed = true) =>
    wf.exportOne(BOOK, "tn", instanceId, dcsAllowed, false, new Set(), false);
  const live = (source) =>
    sqlite
      .prepare(`SELECT message FROM system_alerts WHERE username = ? AND source = ? AND dismissed_at IS NULL`)
      .all(EXPORT_ALERT_USERNAME, source);
  const reverts = () => sqlite.prepare(`SELECT ref, class FROM export_reverts WHERE book = ?`).all(BOOK);
  // What D1 renders right now (a dry run writes only R2).
  const render = async (tag) => {
    await exportOne(`dry-${tag}`, false);
    return r2.get(`exports/dry-${tag}/${BOOK}/tn/${FILE}`).body;
  };
  return { sqlite, env, r2, exportOne, live, reverts, render };
}

// Replace one row's Note in a rendered TSV (a person editing Door43).
function editNote(tsv, id, note) {
  return tsv
    .split("\n")
    .map((l) => {
      const c = l.split("\t");
      if (c[1] !== id) return l;
      c[6] = note;
      return c.join("\t");
    })
    .join("\n");
}
const noteOf = (tsv, id) => (tsv ?? "").split("\n").find((l) => l.split("\t")[1] === id)?.split("\t")[6];

const ROWS = [
  ["aa11", 1, "First note."],
  ["bb22", 2, "Second note."],
  ["cc33", 3, "Third note."],
];

// Night 1 for the confirmed cases: master already holds D1's render, so the
// export is `unchanged` and stamps master_confirmed_at = pushed_read_at.
async function confirmedNight1(t, d) {
  d.master = await t.render("n1");
  const r = await t.exportOne("export-night-1");
  return r;
}

console.log("\n[1. only master moved → master's row ships, nothing reverted]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  const n1 = await confirmedNight1(t, d);
  ok(n1.dcsSkippedReason === "unchanged", `night 1 is unchanged (got ${n1.dcsSkippedReason})`);
  d.master = editNote(d.master, "bb22", "Second note, fixed on Door43.");
  const n2 = await t.exportOne("export-night-2");
  ok(d.writes.length === 0, `nothing was committed to the branch (writes: ${d.writes.length})`);
  ok(n2.dcsSkippedReason === "unchanged", `the render equals master, so the export is unchanged (got ${n2.dcsSkippedReason})`);
  ok(t.reverts().length === 0, "no export_reverts row recorded");
  ok(t.live(`export_revert:${BOOK}:tn`).length === 0, "no export_revert alert");
  const kept = t.live(`export_kept_master:${BOOK}:tn`);
  ok(kept.length === 1 && kept[0].message.includes("bb22 (1:2)"), "a kept-rows alert names bb22");
  const pushed = t.r2.get(`exports/export-night-2/${BOOK}/tn/${FILE}`).body;
  ok(noteOf(pushed, "bb22") === "Second note, fixed on Door43.", "the R2 copy of the pushed render holds master's row");

  console.log("\n[1b. the next export keeps it kept (D1 still has the old text)]");
  const n3 = await t.exportOne("export-night-3");
  ok(d.writes.length === 0 && n3.dcsSkippedReason === "unchanged", `night 3 still ships master's row (got ${n3.dcsSkippedReason}, writes ${d.writes.length})`);

  console.log("\n[1c. a translator then edits that row → their edit ships (both changed: today's behaviour)]");
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Translator rewrote it.' WHERE id = 'bb22'`).run();
  const n4 = await t.exportOne("export-night-4");
  ok(d.writes.length === 1 && noteOf(d.branch, "bb22") === "Translator rewrote it.", `the edit is committed (got ${n4.dcsSkippedReason})`);

  console.log("\n[1d. once D1 matches master, the kept-rows alert clears]");
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Second note, fixed on Door43.' WHERE id = 'bb22'`).run();
  await t.exportOne("export-night-5");
  ok(t.live(`export_kept_master:${BOOK}:tn`).length === 0, "kept-rows alert cleared on a measured clean pass");
}

console.log("\n[2. ours and master both changed the row → ours ships, as today]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  await confirmedNight1(t, d);
  d.master = editNote(d.master, "bb22", "Door43 wording.");
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Bible Editor wording.' WHERE id = 'bb22'`).run();
  await t.exportOne("export-night-2");
  ok(d.writes.length === 1 && noteOf(d.branch, "bb22") === "Bible Editor wording.", "D1's edit is committed");
  ok(t.live(`export_kept_master:${BOOK}:tn`).length === 0, "no kept-rows alert");
  ok(t.reverts().some((r) => r.ref === "1:2" && r.class === "substantive"), "the revert report still records the overwrite");
}

console.log("\n[3. more rows than the threshold → push refused + alert]");
{
  const many = Array.from({ length: 25 }, (_, i) => [`m${String(i).padStart(3, "0")}`, i + 1, `Note ${i}.`]);
  const d = door43();
  const t = freshEnv(many);
  await confirmedNight1(t, d);
  for (let i = 0; i < 21; i++) d.master = editNote(d.master, `m${String(i).padStart(3, "0")}`, `Fixed ${i}.`);
  const n2 = await t.exportOne("export-night-2");
  ok(String(n2.dcsSkippedReason).startsWith("master_moved_guard:21_kept"), `refused (got ${n2.dcsSkippedReason})`);
  ok(d.writes.length === 0, "nothing committed");
  const alert = t.live(`export_master_moved:${BOOK}:tn`);
  ok(alert.length === 1 && alert[0].message.includes("not pushed"), "a refusal alert is raised");
  const snap = t.sqlite.prepare(`SELECT error FROM export_snapshots WHERE book = ? ORDER BY id DESC LIMIT 1`).get(BOOK);
  ok(String(snap?.error).startsWith("master_moved_guard:"), "the snapshot records the refusal");

  console.log("\n[3b. after a re-sync brings D1 up to master, the push goes through and the alert clears]");
  for (let i = 0; i < 21; i++) {
    t.sqlite.prepare(`UPDATE tn_rows SET note = ? WHERE id = ?`).run(`Fixed ${i}.`, `m${String(i).padStart(3, "0")}`);
  }
  const n3 = await t.exportOne("export-night-3");
  ok(n3.dcsSkippedReason === "unchanged", `ships (got ${n3.dcsSkippedReason})`);
  ok(t.live(`export_master_moved:${BOOK}:tn`).length === 0, "refusal alert cleared");
}

console.log("\n[4. no base (never pushed) → today's behaviour]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  d.master = editNote(await t.render("n0"), "bb22", "Door43 wording.");
  await t.exportOne("export-night-1");
  ok(d.writes.length === 1 && noteOf(d.branch, "bb22") === "Second note.", "D1's render is committed unchanged");
  ok(t.live(`export_kept_master:${BOOK}:tn`).length === 0, "no kept-rows alert");
}

console.log("\n[5. last push never merged → not a base; a translator's unshipped edit still ships]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  const old = await t.render("n0");
  d.master = old; // master holds the old text
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Translator edit.' WHERE id = 'bb22'`).run();
  await t.exportOne("export-night-1"); // pushed to the branch; its PR never merges
  ok(d.writes.length === 1, "night 1 pushed the edit to the branch");
  d.branch = null; // the PR was declined and the branch rebuilt
  await t.exportOne("export-night-2");
  ok(noteOf(d.branch, "bb22") === "Translator edit.", "night 2 still ships the translator's edit, not master's old text");
  ok(t.live(`export_kept_master:${BOOK}:tn`).length === 0, "no kept-rows alert");
}

console.log("\n[6. last push merged per the dcs_commits ledger (no byte confirmation) → it is a base]");
for (const merged of [true, false]) {
  const d = door43();
  const t = freshEnv(ROWS);
  d.master = await t.render("n0");
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Translator edit.' WHERE id = 'aa11'`).run();
  await t.exportOne("export-night-1"); // pushed; PR #77
  const syncs = t.sqlite.prepare(`SELECT pushed_read_at, master_confirmed_at FROM book_resource_syncs WHERE book = ?`).get(BOOK);
  ok(syncs.master_confirmed_at !== syncs.pushed_read_at, "(setup: night 1 is not byte-confirmed)");
  t.sqlite
    .prepare(`UPDATE book_resource_syncs SET pushed_pr_number = 77, pushed_pr_read_at = pushed_read_at WHERE book = ?`)
    .run(BOOK);
  if (merged) {
    t.sqlite
      .prepare(`INSERT INTO dcs_commits (repo, sha, committed_at, message, classification) VALUES ('en_tn', ?, ?, ?, 'ours')`)
      .run("m".repeat(40), syncs.pushed_read_at + 60, `bible-editor: ${BOOK} tn → master (#77)`);
  }
  // Our merge landed, then someone edited bb22 on Door43.
  d.master = editNote(d.branch, "bb22", "Door43 fix after our merge.");
  d.branch = null;
  await t.exportOne("export-night-2");
  const shipped = d.branch;
  if (merged) {
    ok(shipped == null || noteOf(shipped, "bb22") === "Door43 fix after our merge.", "merged: master's fix is kept");
    ok(t.live(`export_kept_master:${BOOK}:tn`).length === 1, "merged: kept-rows alert");
  } else {
    ok(noteOf(shipped, "bb22") === "Second note.", "not proven merged: ships as today");
  }
}

console.log("\n[7. a step.do retry of an export that kept rows keeps them again]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  await confirmedNight1(t, d);
  d.master = editNote(d.master, "bb22", "Door43 fix.");
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Translator edit.' WHERE id = 'aa11'`).run();
  await t.exportOne("export-night-2");
  ok(noteOf(d.branch, "bb22") === "Door43 fix." && noteOf(d.branch, "aa11") === "Translator edit.", "attempt 1 ships the edit and keeps master's row");
  // Same instance again: pushed_r2_key now equals this attempt's key.
  await t.exportOne("export-night-2");
  ok(noteOf(d.branch, "bb22") === "Door43 fix.", "the retry does not push D1's old text over the kept row");
}

console.log("\n[8. a push that kept rows but has not merged yet: the next push still keeps them (review F1)]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  await confirmedNight1(t, d);
  // Night 1 happened earlier than this second (read times are whole seconds,
  // so a same-second night 2 would otherwise read as already confirmed).
  t.sqlite
    .prepare(`UPDATE book_resource_syncs SET pushed_read_at = pushed_read_at - 100, master_confirmed_at = master_confirmed_at - 100 WHERE book = ?`)
    .run(BOOK);
  d.master = editNote(d.master, "bb22", "Door43 fix.");
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Translator edit.' WHERE id = 'aa11'`).run();
  await t.exportOne("export-night-2"); // keeps bb22, pushes aa11; PR not merged
  const syncs = t.sqlite.prepare(`SELECT pushed_read_at, master_confirmed_at FROM book_resource_syncs WHERE book = ?`).get(BOOK);
  ok(syncs.master_confirmed_at !== syncs.pushed_read_at, "(setup: night 2's push is not proven on master)");
  ok(noteOf(d.branch, "bb22") === "Door43 fix.", "night 2 kept bb22");
  // A lock & push before the PR merges: master still lacks aa11's edit.
  d.branch = null;
  await t.exportOne("export-lockpush");
  ok(noteOf(d.branch, "bb22") === "Door43 fix.", "the unproven push's kept row is carried forward");
  ok(noteOf(d.branch, "aa11") === "Translator edit.", "…and the translator's unshipped edit still ships");
}

// Remove one row from a rendered TSV (a person deleting a note on Door43).
const deleteRow = (tsv, id) => tsv.split("\n").filter((l) => l.split("\t")[1] !== id).join("\n");
const hasRow = (tsv, id) => (tsv ?? "").split("\n").some((l) => l.split("\t")[1] === id);

console.log("\n[9. only Door43 deleted a row (D1 still has it) → it does not come back (#1415)]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  await confirmedNight1(t, d);
  d.master = deleteRow(d.master, "bb22");
  const n2 = await t.exportOne("export-night-2");
  ok(d.writes.length === 0, `nothing was committed to the branch (writes: ${d.writes.length})`);
  ok(n2.dcsSkippedReason === "unchanged", `the render equals master, so the export is unchanged (got ${n2.dcsSkippedReason})`);
  const pushed = t.r2.get(`exports/export-night-2/${BOOK}/tn/${FILE}`).body;
  ok(!hasRow(pushed, "bb22"), "the R2 copy of the pushed render leaves bb22 out");
  const alert = t.live(`export_kept_master:${BOOK}:tn`);
  ok(alert.length === 1 && alert[0].message.includes("bb22 (1:2)") && alert[0].message.includes("deleted on Door43"), "an alert names bb22 as deleted on Door43");

  console.log("\n[9b. the next export still leaves it out (D1 still has the row)]");
  const n3 = await t.exportOne("export-night-3");
  ok(d.writes.length === 0 && n3.dcsSkippedReason === "unchanged", `night 3 still leaves bb22 out (got ${n3.dcsSkippedReason}, writes ${d.writes.length})`);

  console.log("\n[9c. once D1 deletes it too, the alert clears]");
  t.sqlite.prepare(`UPDATE tn_rows SET deleted_at = 1 WHERE id = 'bb22'`).run();
  await t.exportOne("export-night-4");
  ok(t.live(`export_kept_master:${BOOK}:tn`).length === 0, "alert cleared on a measured clean pass");
}

console.log("\n[9d. the same deletion, but the master read cannot be proven complete → ships as before]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  await confirmedNight1(t, d);
  d.master = deleteRow(d.master, "bb22");
  d.noSize = true;
  await t.exportOne("export-night-2");
  ok(hasRow(d.branch, "bb22"), "bb22 ships: a short read must not read as a Door43 deletion");
  ok(t.live(`export_kept_master:${BOOK}:tn`).length === 0, "no kept-rows alert");
}

console.log("\n[10. Door43 deleted two rows; a translator edited one of them and another row → the edits ship, the untouched deletion holds]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  await confirmedNight1(t, d);
  t.sqlite
    .prepare(`UPDATE book_resource_syncs SET pushed_read_at = pushed_read_at - 100, master_confirmed_at = master_confirmed_at - 100 WHERE book = ?`)
    .run(BOOK);
  d.master = deleteRow(deleteRow(d.master, "bb22"), "cc33");
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Translator kept this one.' WHERE id = 'cc33'`).run();
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Translator edit.' WHERE id = 'aa11'`).run();
  await t.exportOne("export-night-2");
  const syncs = t.sqlite.prepare(`SELECT pushed_read_at, master_confirmed_at FROM book_resource_syncs WHERE book = ?`).get(BOOK);
  ok(syncs.master_confirmed_at !== syncs.pushed_read_at, "(setup: night 2's push is not proven on master, so 10c runs in carry mode)");
  ok(!hasRow(d.branch, "bb22"), "bb22 (deleted on Door43, untouched here) stays off the branch");
  ok(noteOf(d.branch, "cc33") === "Translator kept this one.", "cc33 (edited after the base) ships");
  ok(noteOf(d.branch, "aa11") === "Translator edit.", "aa11's edit ships");
  const alert = t.live(`export_kept_master:${BOOK}:tn`);
  ok(alert.length === 1 && alert[0].message.includes("bb22") && !alert[0].message.includes("cc33"), "the alert names bb22 only");

  console.log("\n[10b. a step.do retry of that export leaves bb22 out again]");
  await t.exportOne("export-night-2");
  ok(!hasRow(d.branch, "bb22") && noteOf(d.branch, "cc33") === "Translator kept this one.", "the retry does not add bb22 back");

  console.log("\n[10c. a lock & push before that PR merges (carry mode) leaves bb22 out]");
  d.branch = null;
  await t.exportOne("export-lockpush");
  ok(!hasRow(d.branch, "bb22"), "the unproven push's dropped row stays dropped");
  ok(noteOf(d.branch, "cc33") === "Translator kept this one." && noteOf(d.branch, "aa11") === "Translator edit.", "…and the translator's edits still ship");
}

console.log("\n[11. too many rows deleted on Door43 → push refused + alert]");
{
  const id = (i) => `m${String(i).padStart(3, "0")}`;
  const many = Array.from({ length: 30 }, (_, i) => [id(i), i + 1, `Note ${i}.`]);

  for (const [label, del, edit, refuse] of [
    ["21 deleted", 21, 0, true],
    ["11 edited + 10 deleted", 10, 11, true],
    ["20 deleted (at the threshold)", 20, 0, false],
  ]) {
    const d = door43();
    const t = freshEnv(many);
    await confirmedNight1(t, d);
    for (let i = 0; i < del; i++) d.master = deleteRow(d.master, id(i));
    for (let i = del; i < del + edit; i++) d.master = editNote(d.master, id(i), `Fixed ${i}.`);
    const n2 = await t.exportOne("export-night-2");
    if (refuse) {
      ok(String(n2.dcsSkippedReason).startsWith("master_moved_guard:"), `${label}: refused (got ${n2.dcsSkippedReason})`);
      ok(d.writes.length === 0, `${label}: nothing committed`);
      const alert = t.live(`export_master_moved:${BOOK}:tn`);
      ok(
        alert.length === 1 && alert[0].message.includes("not pushed") && alert[0].message.includes(`${del + edit} rows is more than`),
        `${label}: a refusal alert gives the combined count (${alert[0]?.message})`,
      );
    } else {
      ok(n2.dcsSkippedReason === "unchanged", `${label}: ships (got ${n2.dcsSkippedReason})`);
      ok(t.live(`export_master_moved:${BOOK}:tn`).length === 0, `${label}: no refusal alert`);
    }
  }
}

// Add a row to a rendered TSV under a new id (a person adding a note on
// Door43 that D1 never received).
const addRow = (tsv, id, note) => {
  const lines = tsv.split("\n");
  const c = lines[1].split("\t");
  c[1] = id;
  c[6] = note;
  const last = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  lines.splice(last, 0, c.join("\t"));
  return lines.join("\n");
};

console.log("\n[12. dropped rows must not hide master rows the render lacks from the shrink guard (#1424)]");
{
  const id = (i) => `m${String(i).padStart(3, "0")}`;
  const many = Array.from({ length: 80 }, (_, i) => [id(i), (i % 20) + 1, `Note ${i}.`]);
  const d = door43();
  const t = freshEnv(many);
  await confirmedNight1(t, d);
  // Door43: 10 of our rows deleted, 30 new rows D1 never got. Master 100,
  // render 80 (a net loss of 20 passes the count), but the 10 deleted rows
  // are dropped from what ships, so the push would hold 70: 30 lost.
  for (let i = 0; i < 10; i++) d.master = deleteRow(d.master, id(i));
  for (let i = 0; i < 30; i++) d.master = addRow(d.master, `n${String(i).padStart(3, "0")}`, `Door43 note ${i}.`);
  const n2 = await t.exportOne("export-night-2");
  ok(String(n2.dcsSkippedReason).startsWith("shrink_guard:shrink_30_of_100"), `refused by the shrink guard (got ${n2.dcsSkippedReason})`);
  ok(d.writes.length === 0, `nothing committed (writes: ${d.writes.length})`);
  ok(t.live(`export_shrink:${BOOK}:tn`).length === 1, "a shrink alert is raised");
}

console.log("\n[13. a row dropped on a verified night stays off on an unverified night (#1424)]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  await confirmedNight1(t, d);
  d.master = deleteRow(d.master, "bb22");
  await t.exportOne("export-night-2"); // verified: bb22 dropped, render equals master
  ok(d.writes.length === 0, "(setup: night 2 dropped bb22 and committed nothing)");
  d.noSize = true; // the master read can no longer be proven complete
  const n3 = await t.exportOne("export-night-3");
  ok(d.writes.length === 0 && !hasRow(d.branch, "bb22"), `night 3 (unverified) does not add bb22 back (got ${n3.dcsSkippedReason}, writes ${d.writes.length})`);
  ok(!hasRow(t.r2.get(`exports/export-night-3/${BOOK}/tn/${FILE}`).body, "bb22"), "the R2 copy of night 3's render leaves bb22 out");

  console.log("\n[13b. a second unverified night still leaves it out]");
  const n4 = await t.exportOne("export-night-4");
  ok(d.writes.length === 0 && !hasRow(d.branch, "bb22"), `night 4 still leaves bb22 out (got ${n4.dcsSkippedReason}, writes ${d.writes.length})`);

  console.log("\n[13c. a translator edits bb22 in Bible Editor → it ships on an unverified night]");
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Translator restored it.' WHERE id = 'bb22'`).run();
  await t.exportOne("export-night-5");
  ok(noteOf(d.branch, "bb22") === "Translator restored it.", "the edited row is committed");
}

console.log("\n[14. carry mode: an unproven push's dropped row stays off on an unverified night (#1424)]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  await confirmedNight1(t, d);
  t.sqlite
    .prepare(`UPDATE book_resource_syncs SET pushed_read_at = pushed_read_at - 100, master_confirmed_at = master_confirmed_at - 100 WHERE book = ?`)
    .run(BOOK);
  d.master = deleteRow(d.master, "bb22");
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Translator edit.' WHERE id = 'aa11'`).run();
  await t.exportOne("export-night-2"); // verified: drops bb22, pushes aa11; PR not merged
  const syncs = t.sqlite.prepare(`SELECT pushed_read_at, master_confirmed_at FROM book_resource_syncs WHERE book = ?`).get(BOOK);
  ok(syncs.master_confirmed_at !== syncs.pushed_read_at, "(setup: night 2's push is not proven on master)");
  ok(!hasRow(d.branch, "bb22"), "(setup: night 2 left bb22 off the branch)");
  d.noSize = true;
  await t.exportOne("export-lockpush-1");
  ok(!hasRow(d.branch, "bb22"), "an unverified lock & push does not put bb22 back on the branch");
  ok(noteOf(d.branch, "aa11") === "Translator edit.", "…and the translator's edit still ships");

  console.log("\n[14b. a second unverified push still leaves it out]");
  await t.exportOne("export-lockpush-2");
  ok(!hasRow(d.branch, "bb22"), "bb22 stays off the branch");

  console.log("\n[14c. a translator edits bb22 → it ships]");
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Translator restored it.' WHERE id = 'bb22'`).run();
  await t.exportOne("export-lockpush-3");
  ok(noteOf(d.branch, "bb22") === "Translator restored it.", "the edited row is committed");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nkeepMasterJourney: all passed");
