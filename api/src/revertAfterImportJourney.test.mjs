// #1419 journey: the REAL ExportWorkflow.exportOne on the REAL migration
// schema, Door43 replaced by an in-memory stand-in (same harness as
// keepMasterJourney.test.mjs).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/revertAfterImportJourney.test.mjs
//
// The 2CH TN shape (alert 1458, 2026-11-18): a person commits to master, the
// nightly reimport adopts master's file (book_resource_syncs.source_sha = the
// file's head, origin 'reimport'), a translator then edits the row in Bible
// Editor, and the export ships. Master has not moved since the import, so
// every difference between the render and master was made in Bible Editor:
// the report records the rows as probably ours (quiet), not export_revert.
// A row the import did NOT take from master (kept D1's side) stays loud.

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

// Door43 stand-in: master's head commit is `d.head`, by default WATERMARK,
// which is also the D1 sync watermark (the import adopted master's current
// file). Case 5 moves it to model a commit after the import.
function door43() {
  const d = { master: null, branch: null, writes: [], head: WATERMARK };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(typeof input === "string" ? input : input.url));
    const method = (init.method ?? "GET").toUpperCase();
    if (url.origin !== DCS_BASE_URL) throw new Error(`test fetch escaped the stub: ${url}`);
    const p = url.pathname;
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (p.endsWith("/commits") && url.searchParams.get("sha") === "master") {
      return json([{ sha: d.head, commit: { message: `Update ${FILE}`, author: { email: "editor@example.test" } } }]);
    }
    if (p.endsWith(`/raw/${FILE}`)) {
      return d.master == null ? new Response("nf", { status: 404 }) : new Response(d.master);
    }
    if (p.endsWith(`/contents/${FILE}`)) {
      if (method === "GET") {
        const ref = url.searchParams.get("ref");
        const text = ref === "master" || ref === d.head ? d.master : d.branch;
        if (text == null) return new Response("nf", { status: 404 });
        return json({ sha: "blob-" + text.length, size: Buffer.byteLength(text), content: b64(text), encoding: "base64" });
      }
      const body = JSON.parse(init.body);
      d.branch = unb64(body.content);
      d.writes.push(d.branch);
      return json({ content: { sha: "newblob" }, commit: { sha: "c".repeat(40) } }, 201);
    }
    if (p.endsWith("/git/refs/heads/master")) return json({ object: { sha: d.head } });
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
  const reverts = () =>
    sqlite.prepare(`SELECT ref, class, probably_ours FROM export_reverts WHERE book = ? ORDER BY ref`).all(BOOK);
  const render = async (tag) => {
    await exportOne(`dry-${tag}`, false);
    return r2.get(`exports/dry-${tag}/${BOOK}/tn/${FILE}`).body;
  };
  return { sqlite, env, r2, exportOne, live, reverts, render };
}

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

// edit_log helpers. `payload` for a reimport write is the parsed master row
// (bookReimport.ts logs ParsedTsvRow), in D1 column names.
function parsedRow(id, verse, note) {
  return {
    id,
    refRaw: `1:${verse}`,
    chapter: 1,
    verse,
    occurrence: 1,
    tags: null,
    support_reference: "rc://*/ta/man/translate/figs-metaphor",
    quote: "q",
    note,
  };
}
function logEdit(t, { id, action = "update", source = null, payload, at }) {
  t.sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, created_at)
       VALUES ('tn', ?, ?, NULL, 1, 2, ?, ?, ?, ?)`,
    )
    .run(id, BOOK, action, JSON.stringify(payload), source, at);
}
const NOW = Math.floor(Date.now() / 1000);
const IMPORT_WRITE_AT = NOW - 500;
const SYNCED_AT = NOW - 400;
const APP_EDIT_AT = NOW - 300;

// Night 1: master already holds D1's render, so the export is `unchanged`
// and master is confirmed. Its stamps are moved back so the import and the
// in-app edit below come after it.
async function confirmedNight1(t, d) {
  d.master = await t.render("n1");
  const r = await t.exportOne("export-night-1");
  t.sqlite
    .prepare(
      `UPDATE book_resource_syncs SET pushed_read_at = pushed_read_at - 1000, master_confirmed_at = master_confirmed_at - 1000 WHERE book = ?`,
    )
    .run(BOOK);
  return r;
}

// The nightly reimport ran against master's current file (WATERMARK) and
// stamped the clean watermark at SYNCED_AT.
function stampImport(t) {
  t.sqlite
    .prepare(`UPDATE book_resource_syncs SET source_sha = ?, origin = 'reimport', synced_at = ? WHERE book = ? AND resource = 'tn'`)
    .run(WATERMARK, SYNCED_AT, BOOK);
}

// A translator edits a row in Bible Editor after the import.
function appEdit(t, id, note) {
  t.sqlite.prepare(`UPDATE tn_rows SET note = ?, version = version + 1 WHERE id = ?`).run(note, id);
  logEdit(t, { id, source: null, payload: { note }, at: APP_EDIT_AT });
}

console.log("\n[1. 2CH shape: person commits on master → reimport adopts it → in-app edit → export: quiet record only]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  const n1 = await confirmedNight1(t, d);
  ok(n1.dcsSkippedReason === "unchanged", `night 1 is unchanged (got ${n1.dcsSkippedReason})`);
  // A person edits bb22 on master; master also carries trailing literal \n
  // on cc33 that the renderer normalises away (the 2CH whitespace rows).
  d.master = editNote(d.master, "bb22", "Human fix on Door43.");
  d.master = editNote(d.master, "cc33", "Third note.\\n\\n\\n");
  // The reimport adopts master's file: bb22 takes the person's note; cc33's
  // stored note is master's, normalised (the full Pull from Door43 logged a
  // create for every row it wrote).
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Human fix on Door43.' WHERE id = 'bb22'`).run();
  logEdit(t, { id: "aa11", action: "create", source: "dcs_reimport", payload: parsedRow("aa11", 1, "First note."), at: IMPORT_WRITE_AT });
  logEdit(t, { id: "bb22", action: "create", source: "dcs_reimport", payload: parsedRow("bb22", 2, "Human fix on Door43."), at: IMPORT_WRITE_AT });
  logEdit(t, { id: "cc33", action: "create", source: "dcs_reimport", payload: parsedRow("cc33", 3, "Third note."), at: IMPORT_WRITE_AT });
  stampImport(t);
  // Then a translator edits bb22 in the app.
  appEdit(t, "bb22", "Translator edit after the import.");

  await t.exportOne("export-night-2");
  ok(noteOf(d.branch, "bb22") === "Translator edit after the import.", "the translator's edit ships");
  const rows = t.reverts();
  ok(rows.some((r) => r.ref === "1:2" && r.class === "substantive"), `the overwrite of 1:2 is still recorded (got ${JSON.stringify(rows)})`);
  ok(rows.some((r) => r.ref === "1:3" && r.class === "whitespace_only"), "the whitespace-only row 1:3 is still recorded");
  ok(rows.length > 0 && rows.every((r) => r.probably_ours === 1), `every recorded row is labelled probably ours (got ${JSON.stringify(rows)})`);
  ok(t.live(`export_revert:${BOOK}:tn`).length === 0, "no export_revert alert");
  ok(t.live(`mechanical_overwrite:${BOOK}:tn`).length === 0, "no mechanical_overwrite alert");
  const quiet = t.live(`revert_probably_ours:${BOOK}:tn`);
  ok(quiet.length === 1, "one quiet revert_probably_ours record");
  ok(/not a lost hand-edit: .*1:2.*\. The stored Door43 edit history /s.test(quiet[0]?.message ?? ""), "the record lists 1:2 in the watchdog's parseable shape");
  ok(/imported master's current file/.test(quiet[0]?.message ?? ""), "the record says why: D1 imported master's current file");
}

console.log("\n[2. the import kept D1's side of bb22 (preserved row, no reimport write) → export_revert stays loud]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  await confirmedNight1(t, d);
  d.master = editNote(d.master, "bb22", "Human fix on Door43.");
  // D1's last write before the import is an older reimport of the old note;
  // the import skipped bb22 (protected), so D1 never held the person's fix.
  logEdit(t, { id: "aa11", action: "create", source: "dcs_reimport", payload: parsedRow("aa11", 1, "First note."), at: IMPORT_WRITE_AT });
  logEdit(t, { id: "bb22", action: "create", source: "dcs_reimport", payload: parsedRow("bb22", 2, "Second note."), at: IMPORT_WRITE_AT - 100 });
  stampImport(t);
  appEdit(t, "bb22", "Translator edit after the import.");

  await t.exportOne("export-night-2");
  const rows = t.reverts();
  ok(rows.some((r) => r.ref === "1:2" && r.probably_ours === 0), `1:2 is recorded as needing attention (got ${JSON.stringify(rows)})`);
  const loud = t.live(`export_revert:${BOOK}:tn`);
  ok(loud.length === 1 && loud[0].message.includes("1:2"), "export_revert names 1:2");
}

console.log("\n[3. the import flagged bb22 as a conflict (partial review write) → export_revert stays loud]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  await confirmedNight1(t, d);
  d.master = editNote(d.master, "bb22", "Human fix on Door43.");
  logEdit(t, { id: "bb22", action: "create", source: "dcs_reimport", payload: parsedRow("bb22", 2, "Human fix on Door43."), at: IMPORT_WRITE_AT - 100 });
  // The latest import kept D1's side and wrote only the review flag.
  logEdit(t, { id: "bb22", action: "update", source: "dcs_reimport", payload: { review_kind: "merge_conflict" }, at: IMPORT_WRITE_AT });
  stampImport(t);
  appEdit(t, "bb22", "Translator edit after the import.");

  await t.exportOne("export-night-2");
  ok(t.reverts().some((r) => r.ref === "1:2" && r.probably_ours === 0), "1:2 needs attention");
  ok(t.live(`export_revert:${BOOK}:tn`).length === 1, "export_revert alert raised");
}

console.log("\n[4. the sync watermark is not a clean reimport (origin export) → export_revert stays loud]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  await confirmedNight1(t, d);
  d.master = editNote(d.master, "bb22", "Human fix on Door43.");
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Human fix on Door43.' WHERE id = 'bb22'`).run();
  logEdit(t, { id: "bb22", action: "create", source: "dcs_reimport", payload: parsedRow("bb22", 2, "Human fix on Door43."), at: IMPORT_WRITE_AT });
  stampImport(t);
  t.sqlite.prepare(`UPDATE book_resource_syncs SET origin = 'own_publish' WHERE book = ?`).run(BOOK);
  appEdit(t, "bb22", "Translator edit after the import.");

  await t.exportOne("export-night-2");
  ok(t.reverts().some((r) => r.ref === "1:2" && r.probably_ours === 0), "1:2 needs attention");
  ok(t.live(`export_revert:${BOOK}:tn`).length === 1, "export_revert alert raised");
}

console.log("\n[5. the 2CH shape, then a person commits to master again after the import → no quiet path]");
{
  const d = door43();
  const t = freshEnv(ROWS);
  await confirmedNight1(t, d);
  d.master = editNote(d.master, "bb22", "Human fix on Door43.");
  t.sqlite.prepare(`UPDATE tn_rows SET note = 'Human fix on Door43.' WHERE id = 'bb22'`).run();
  logEdit(t, { id: "bb22", action: "create", source: "dcs_reimport", payload: parsedRow("bb22", 2, "Human fix on Door43."), at: IMPORT_WRITE_AT });
  stampImport(t);
  appEdit(t, "bb22", "Translator edit after the import.");
  // A second person's commit after the import, not yet synced.
  d.master = editNote(d.master, "bb22", "Second human fix after the import.");
  d.head = "b".repeat(40);
  const n2 = await t.exportOne("export-night-2");
  console.log(`    (export result: dcsSkippedReason=${n2.dcsSkippedReason}, writes=${d.writes.length})`);
  ok(d.writes.length === 0, "nothing is pushed over the newer master commit");
  ok(t.live(`revert_probably_ours:${BOOK}:tn`).length === 0, "no quiet probably-ours record");
  ok(!t.reverts().some((r) => r.probably_ours === 1), "no row labelled probably ours");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nrevertAfterImportJourney: all passed");
