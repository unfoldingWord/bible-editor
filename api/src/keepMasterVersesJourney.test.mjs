// #1412 journey: the verse half of keepMasterJourney.test.mjs. The REAL
// ExportWorkflow.exportOne for `ult`, on the REAL migration schema, with
// Door43 replaced by an in-memory stand-in and R2 by a Map. D1 is seeded from
// a real Door43 ULT file (docs/samples/31-OBA.usfm, 21 verses) through the
// production importer.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/keepMasterVersesJourney.test.mjs

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
const { extractVersesForRange } = await import("./importParsers.ts");
const EXPORT_ALERT_USERNAME = "deferredreward"; // module-private in exportWorkflow.ts

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else console.log(`  ok: ${msg}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const DCS_BASE_URL = "https://dcs.test";
const WATERMARK = "a".repeat(40);
const BOOK = "OBA";
const FILE = "31-OBA.usfm";
const DOOR43_OBA = readFileSync(join(here, "..", "..", "docs", "samples", FILE), "utf8");
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

// Door43 stand-in, same shape as keepMasterJourney.test.mjs's.
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
      // d.commitFails: Door43 rejects the write, so commitToDcs throws.
      if (d.commitFails) return new Response("boom", { status: 500 });
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

function freshEnv(door43File = DOOR43_OBA) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(here, "..", "migrations");
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
  const insert = sqlite.prepare(
    `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text)
     VALUES (?, ?, ?, ?, 'ULT', ?, ?)`,
  );
  for (const v of extractVersesForRange(door43File, 0, 999)) {
    insert.run(BOOK, v.chapter, v.verse, v.verseEnd, v.contentJson, v.plainText);
  }
  sqlite
    .prepare(`INSERT INTO book_resource_syncs (book, resource, source_sha, origin) VALUES (?, 'ult', ?, 'reimport')`)
    .run(BOOK, WATERMARK);
  const wf = new ExportWorkflow({}, env);
  const exportOne = (instanceId, dcsAllowed = true) =>
    wf.exportOne(BOOK, "ult", instanceId, dcsAllowed, false, new Set(), false);
  const live = (source) =>
    sqlite
      .prepare(`SELECT message FROM system_alerts WHERE username = ? AND source = ? AND dismissed_at IS NULL`)
      .all(EXPORT_ALERT_USERNAME, source);
  const reverts = () => sqlite.prepare(`SELECT ref, class FROM export_reverts WHERE book = ?`).all(BOOK);
  const render = async (tag) => {
    await exportOne(`dry-${tag}`, false);
    return r2.get(`exports/dry-${tag}/${BOOK}/ult/${FILE}`).body;
  };
  // A translator's edit in Bible Editor: one word of one verse.
  const editD1 = (verse, from, to) => {
    const row = sqlite.prepare(`SELECT content_json FROM verses WHERE book = ? AND chapter = 1 AND verse = ?`).get(BOOK, verse);
    const next = row.content_json.replace(`"text":"${from}"`, `"text":"${to}"`);
    if (next === row.content_json) throw new Error(`test setup: "${from}" not in 1:${verse}`);
    sqlite
      .prepare(`UPDATE verses SET content_json = ?, version = version + 1 WHERE book = ? AND chapter = 1 AND verse = ?`)
      .run(next, BOOK, verse);
  };
  // The export as the Workflow runs it: one retried step per (book, resource),
  // whose failure after the retries is caught and recorded (#1450).
  const exportStep = (step, instanceId, dcsAllowed = true) =>
    wf.runExportStep(step, BOOK, "ult", null, () => exportOne(instanceId, dcsAllowed));
  return { sqlite, env, r2, wf, exportOne, exportStep, live, reverts, render, editD1 };
}

// A WorkflowStep stand-in that honours `retries.limit` the way Cloudflare
// does (1 + limit attempts, then the last error is thrown), without sleeping
// the retry delay. `attempts` counts calls per step name.
function retryingStep() {
  const attempts = {};
  return {
    attempts,
    async do(name, optsOrFn, maybeFn) {
      const fn = typeof optsOrFn === "function" ? optsOrFn : maybeFn;
      const limit = typeof optsOrFn === "function" ? 0 : (optsOrFn?.retries?.limit ?? 0);
      let last;
      for (let i = 0; i <= limit; i++) {
        attempts[name] = (attempts[name] ?? 0) + 1;
        try {
          const out = await fn();
          return out === undefined ? out : JSON.parse(JSON.stringify(out));
        } catch (e) {
          last = e;
        }
      }
      throw last;
    },
  };
}

// The text of one verse in a USFM file: its `\v` marker to the next `\v`/`\c`.
function verseSpan(usfm, verse) {
  const start = usfm.search(new RegExp(`\\\\v ${verse}(?=\\s)`));
  if (start < 0) return null;
  const rest = usfm.slice(start + 3);
  const next = rest.search(/\\[vc]\s/);
  return { start, end: next < 0 ? usfm.length : start + 3 + next };
}
const verseText = (usfm, verse) => {
  const s = verseSpan(usfm ?? "", verse);
  return s ? usfm.slice(s.start, s.end) : null;
};
// A person editing one word of one verse on Door43.
function editMasterWord(usfm, verse, from, to) {
  const s = verseSpan(usfm, verse);
  const body = usfm.slice(s.start, s.end);
  const next = body.replace(`\\w ${from}|`, `\\w ${to}|`);
  if (next === body) throw new Error(`test setup: "${from}" not in master ${verse}`);
  return usfm.slice(0, s.start) + next + usfm.slice(s.end);
}

// Night 1: master already holds D1's render, so the export is `unchanged`
// and stamps master_confirmed_at = pushed_read_at (a proven base).
async function confirmedNight1(t, d) {
  d.master = await t.render("n1");
  return t.exportOne("export-night-1");
}

console.log("\n[1. only Door43 changed a verse → master's verse ships, nothing reverted]");
{
  const d = door43();
  const t = freshEnv();
  const n1 = await confirmedNight1(t, d);
  ok(n1.dcsSkippedReason === "unchanged", `night 1 is unchanged (got ${n1.dcsSkippedReason})`);
  d.master = editMasterWord(d.master, 3, "deceived", "fooled");
  const n2 = await t.exportOne("export-night-2");
  ok(d.writes.length === 0, `nothing was committed to the branch (writes: ${d.writes.length})`);
  ok(n2.dcsSkippedReason === "unchanged", `the render equals master, so the export is unchanged (got ${n2.dcsSkippedReason})`);
  ok(t.reverts().length === 0, `no export_reverts row recorded (got ${JSON.stringify(t.reverts())})`);
  ok(t.live(`export_revert:${BOOK}:ult`).length === 0, "no export_revert alert");
  const kept = t.live(`export_kept_master:${BOOK}:ult`);
  ok(kept.length === 1 && kept[0].message.includes("1:3"), `a kept-verses alert names 1:3 (${kept[0]?.message})`);
  const pushed = t.r2.get(`exports/export-night-2/${BOOK}/ult/${FILE}`).body;
  ok(verseText(pushed, 3).includes("\\w fooled|"), "the R2 copy of the pushed render holds master's verse");
  const sibling = t.r2.get(`exports/export-night-2/${BOOK}/ult/${FILE}.d1-render`);
  ok(sibling && verseText(sibling.body, 3).includes("\\w deceived|"), "D1's own render is stored beside it");

  console.log("\n[1b. the next export keeps it kept (D1 still has the old text)]");
  const n3 = await t.exportOne("export-night-3");
  ok(d.writes.length === 0 && n3.dcsSkippedReason === "unchanged", `night 3 still ships master's verse (got ${n3.dcsSkippedReason}, writes ${d.writes.length})`);
  ok(t.reverts().length === 0, "still no export_reverts row");

  console.log("\n[1c. a translator then edits that verse → their edit ships (both changed: today's behaviour)]");
  t.editD1(3, "pride", "arrogance");
  const n4 = await t.exportOne("export-night-4");
  ok(d.writes.length === 1, `the edit is committed (got ${n4.dcsSkippedReason})`);
  ok(verseText(d.branch, 3).includes("\\w arrogance|") && verseText(d.branch, 3).includes("\\w deceived|"), "the branch holds D1's verse");
  ok(t.live(`export_kept_master:${BOOK}:ult`).length === 0, "no kept-verses alert any more");
}

console.log("\n[2. round trip: unchanged D1 against unchanged master keeps nothing, night after night]");
{
  const d = door43();
  const t = freshEnv();
  // Master is the real Door43 file, which our render does not reproduce byte
  // for byte. Night 1 pushes our render; its PR merges.
  d.master = DOOR43_OBA;
  await t.exportOne("export-night-1");
  ok(d.writes.length === 1, "(setup: night 1 pushed our render)");
  d.master = d.branch;
  d.branch = null;
  const n2 = await t.exportOne("export-night-2");
  const n3 = await t.exportOne("export-night-3");
  ok(n2.dcsSkippedReason === "unchanged" && n3.dcsSkippedReason === "unchanged", `both later nights are unchanged (${n2.dcsSkippedReason}, ${n3.dcsSkippedReason})`);
  ok(d.writes.length === 1, "nothing more was committed");
  ok(t.live(`export_kept_master:${BOOK}:ult`).length === 0, "no kept-verses alert");
  ok(t.live(`export_master_moved:${BOOK}:ult`).length === 0, "no refusal alert");
  ok(!t.r2.has(`exports/export-night-3/${BOOK}/ult/${FILE}.d1-render`), "no d1-render sibling (nothing kept)");
}

console.log("\n[3. ours and master both changed the verse → ours ships, as today]");
{
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  d.master = editMasterWord(d.master, 3, "deceived", "fooled");
  t.editD1(3, "pride", "arrogance");
  await t.exportOne("export-night-2");
  ok(d.writes.length === 1 && verseText(d.branch, 3).includes("\\w deceived|"), "D1's verse is committed");
  ok(t.live(`export_kept_master:${BOOK}:ult`).length === 0, "no kept-verses alert");
  ok(t.reverts().some((r) => r.ref === "1:3" && r.class === "substantive"), "the revert report still records the overwrite");
}

console.log("\n[4. a translator edits one verse while Door43 fixed another → both ship]");
{
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  d.master = editMasterWord(d.master, 3, "deceived", "fooled");
  t.editD1(4, "eagle", "hawk");
  await t.exportOne("export-night-2");
  ok(d.writes.length === 1, "one commit");
  ok(verseText(d.branch, 3).includes("\\w fooled|"), "Door43's verse 3 is kept");
  ok(verseText(d.branch, 4).includes("\\w hawk|"), "the translator's verse 4 ships");
  ok(t.reverts().length === 0, `no export_reverts row (got ${JSON.stringify(t.reverts())})`);
}

console.log("\n[5. more verses than the threshold → push refused + alert; 20 ships]");
for (const [n, refuse] of [
  [21, true],
  [20, false],
]) {
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  for (let v = 1; v <= n; v++) {
    const word = verseText(d.master, v).match(/\\w ([^|\s]+)\|/)[1];
    d.master = editMasterWord(d.master, v, word, `${word}Q`);
  }
  const r = await t.exportOne("export-night-2");
  if (refuse) {
    ok(String(r.dcsSkippedReason).startsWith("master_moved_guard:21_kept"), `${n}: refused (got ${r.dcsSkippedReason})`);
    ok(d.writes.length === 0, `${n}: nothing committed`);
    const alert = t.live(`export_master_moved:${BOOK}:ult`);
    ok(alert.length === 1 && alert[0].message.includes("not pushed") && alert[0].message.includes("21 verses"), `${n}: refusal alert (${alert[0]?.message})`);
  } else {
    ok(r.dcsSkippedReason === "unchanged", `${n}: ships master's verses (got ${r.dcsSkippedReason})`);
    ok(t.live(`export_master_moved:${BOOK}:ult`).length === 0, `${n}: no refusal alert`);
  }
}

console.log("\n[6. Door43 bridged two verses we did not change → cannot place, push refused]");
{
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  // \v 2 ... \v 3 ... → \v 2-3 ... (verse 3's marker removed).
  const s3 = verseSpan(d.master, 3);
  d.master = d.master.slice(0, s3.start) + d.master.slice(s3.start).replace(/^\\v 3\s*/, "");
  d.master = d.master.replace(/\\v 2(?=\s)/, "\\v 2-3");
  const r = await t.exportOne("export-night-2");
  ok(String(r.dcsSkippedReason).startsWith("master_moved_guard:") && String(r.dcsSkippedReason).includes("cannot_place"), `refused (got ${r.dcsSkippedReason})`);
  ok(d.writes.length === 0, "nothing committed");
  const alert = t.live(`export_master_moved:${BOOK}:ult`);
  ok(alert.length === 1 && alert[0].message.includes("1:2") && alert[0].message.includes("1:3"), `the alert names 1:2 and 1:3 (${alert[0]?.message})`);
}

console.log("\n[7. last push never merged → not a base; a translator's unshipped edit still ships]");
{
  const d = door43();
  const t = freshEnv();
  d.master = await t.render("n0"); // master holds the old text
  t.editD1(3, "pride", "arrogance");
  await t.exportOne("export-night-1"); // pushed to the branch; its PR never merges
  ok(d.writes.length === 1, "night 1 pushed the edit to the branch");
  d.branch = null;
  await t.exportOne("export-night-2");
  ok(verseText(d.branch, 3).includes("\\w arrogance|"), "night 2 still ships the translator's edit, not master's old text");
  ok(t.live(`export_kept_master:${BOOK}:ult`).length === 0, "no kept-verses alert");
}

console.log("\n[8. a step.do retry, and a lock & push before the PR merges, keep the verse again]");
{
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  t.sqlite
    .prepare(`UPDATE book_resource_syncs SET pushed_read_at = pushed_read_at - 100, master_confirmed_at = master_confirmed_at - 100 WHERE book = ?`)
    .run(BOOK);
  d.master = editMasterWord(d.master, 3, "deceived", "fooled");
  t.editD1(4, "eagle", "hawk");
  await t.exportOne("export-night-2");
  ok(verseText(d.branch, 3).includes("\\w fooled|") && verseText(d.branch, 4).includes("\\w hawk|"), "attempt 1 ships the edit and keeps master's verse");
  await t.exportOne("export-night-2");
  ok(verseText(d.branch, 3).includes("\\w fooled|"), "the retry does not push D1's old verse over the kept one");
  d.branch = null;
  await t.exportOne("export-lockpush");
  ok(verseText(d.branch, 3).includes("\\w fooled|"), "the unproven push's kept verse is carried forward");
  ok(verseText(d.branch, 4).includes("\\w hawk|"), "…and the translator's unshipped edit still ships");
}

console.log("\n[9. Door43 aligned a verse D1 holds unaligned → kept, and the alignment backstop judges what ships]");
{
  // D1 holds 1:5's words with no alignment (never aligned in Bible Editor).
  const s5 = verseSpan(DOOR43_OBA, 5);
  const flat5 = DOOR43_OBA.slice(s5.start, s5.end).replace(/\\zaln-s \|[^\\]*\\\*/g, "").replace(/\\zaln-e\\\*/g, "");
  const flatFile = DOOR43_OBA.slice(0, s5.start) + flat5 + DOOR43_OBA.slice(s5.end);
  const d = door43();
  const t = freshEnv(flatFile);
  await confirmedNight1(t, d);
  ok(!verseText(d.master, 5).includes("\\zaln-s"), "(setup: master holds 1:5 unaligned too)");
  // Someone aligns 1:5 on Door43.
  const m5 = verseSpan(d.master, 5);
  d.master = d.master.slice(0, m5.start) + verseText(DOOR43_OBA, 5) + d.master.slice(m5.end);
  const n2 = await t.exportOne("export-night-2");
  ok(n2.dcsSkippedReason === "unchanged" && d.writes.length === 0, `master's aligned verse ships (got ${n2.dcsSkippedReason}, writes ${d.writes.length})`);
  ok(t.live(`export_align_shrink:${BOOK}:ult`).length === 0, "no lost-alignment alert");
  ok(t.live(`export_kept_master:${BOOK}:ult`).some((a) => a.message.includes("1:5")), "the kept-verses alert names 1:5");
}

console.log("\n[10. Door43's fixed verse ends in a line its USFM check rejects (1CH 1:45's shape) → refused, worded as such]");
{
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  d.master = editMasterWord(d.master, 3, "deceived", "fooled");
  const s4 = verseSpan(d.master, 4);
  d.master = d.master.slice(0, s4.start) + "\\ts*  " + d.master.slice(s4.start);
  const r = await t.exportOne("export-night-2");
  ok(String(r.dcsSkippedReason) === "master_moved_guard:0_kept_1_cannot_place", `refused (got ${r.dcsSkippedReason})`);
  ok(d.writes.length === 0, "nothing committed");
  const alert = t.live(`export_master_moved:${BOOK}:ult`);
  ok(
    alert.length === 1 && alert[0].message.includes("USFM check rejects") && !alert[0].message.includes("re-bridged"),
    `the alert names the layout cause, not a re-bridge (${alert[0]?.message})`,
  );
}

console.log("\n[11. a master read not proven whole, cut inside its last verse → nothing kept, ours ships (review A1)]");
{
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  const full21 = verseText(d.master, 21);
  const s21 = verseSpan(d.master, 21);
  d.master = d.master.slice(0, s21.start + Math.floor((s21.end - s21.start) / 2));
  d.noSize = true;
  await t.exportOne("export-night-2");
  ok(t.live(`export_kept_master:${BOOK}:ult`).length === 0, "no kept-verses alert");
  ok(t.live(`export_master_moved:${BOOK}:ult`).length === 0, "no refusal alert");
  ok(verseText(d.branch, 21) === full21, "the branch holds D1's whole 1:21, not the cut one");
}

console.log("\n[12. a refused push still records the alignment backstop's finding (review A4)]");
{
  // D1 holds 1:5 unaligned; Door43 aligns it AND bridges 1:2-3 (cannot place).
  const s5 = verseSpan(DOOR43_OBA, 5);
  const flat5 = DOOR43_OBA.slice(s5.start, s5.end).replace(/\\zaln-s \|[^\\]*\\\*/g, "").replace(/\\zaln-e\\\*/g, "");
  const d = door43();
  const t = freshEnv(DOOR43_OBA.slice(0, s5.start) + flat5 + DOOR43_OBA.slice(s5.end));
  await confirmedNight1(t, d);
  const m5 = verseSpan(d.master, 5);
  d.master = d.master.slice(0, m5.start) + verseText(DOOR43_OBA, 5) + d.master.slice(m5.end);
  const s3 = verseSpan(d.master, 3);
  d.master = (d.master.slice(0, s3.start) + d.master.slice(s3.start).replace(/^\\v 3\s*/, "")).replace(/\\v 2(?=\s)/, "\\v 2-3");
  const r = await t.exportOne("export-night-2");
  ok(String(r.dcsSkippedReason).startsWith("master_moved_guard:"), `refused (got ${r.dcsSkippedReason})`);
  ok(t.live(`export_align_shrink:${BOOK}:ult`).length === 1, "the lost-alignment alert for D1's render is still recorded");
}

console.log("\n[13. a refused night with translator-scale alignment loss does not say the book shipped (#1434)]");
{
  // D1 holds 1:5 with ONE word unaligned (translator-scale: alerts, would not
  // block on its own); Door43 aligns it AND bridges 1:2-3 (cannot place).
  const s5 = verseSpan(DOOR43_OBA, 5);
  const v5 = DOOR43_OBA.slice(s5.start, s5.end);
  const oneOff = v5.replace(/\\zaln-s \|[^\\]*\\\*/, "").replace(/\\zaln-e\\\*/, "");
  const d = door43();
  const t = freshEnv(DOOR43_OBA.slice(0, s5.start) + oneOff + DOOR43_OBA.slice(s5.end));
  await confirmedNight1(t, d);
  const m5 = verseSpan(d.master, 5);
  d.master = d.master.slice(0, m5.start) + v5 + d.master.slice(m5.end);
  const s3 = verseSpan(d.master, 3);
  d.master = (d.master.slice(0, s3.start) + d.master.slice(s3.start).replace(/^\\v 3\s*/, "")).replace(/\\v 2(?=\s)/, "\\v 2-3");
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => {
    logs.push(a.join(" "));
    origLog(...a);
  };
  let r;
  try {
    r = await t.exportOne("export-night-2");
  } finally {
    console.log = origLog;
  }
  ok(String(r.dcsSkippedReason).startsWith("master_moved_guard:"), `refused (got ${r.dcsSkippedReason})`);
  ok(d.writes.length === 0, "nothing committed");
  const align = t.live(`export_align_shrink:${BOOK}:ult`);
  ok(align.length === 1, `the lost-alignment alert is recorded (${align.length})`);
  ok(align[0] && !align[0].message.includes("BLOCKED"), `(setup: the loss is translator-scale, not blocking: ${align[0]?.message})`);
  ok(align[0] && !/shipped|is on Door43/.test(align[0].message), `the alert does not say the book shipped (${align[0]?.message})`);
  ok(align[0] && align[0].message.includes("not pushed"), `the alert says it was not pushed (${align[0]?.message})`);
  ok(!logs.some((l) => l.includes("shipping")), `no "shipping" log line (${logs.filter((l) => l.includes("shipping")).join(" | ")})`);

  console.log("\n[13b. the next export that measures alignment clean clears that banner (#1434 A2)]");
  d.master = await t.render("n3pre"); // Door43 takes Bible Editor's text: nothing lost, nothing moved
  await t.exportOne("export-night-3");
  ok(t.live(`export_align_shrink:${BOOK}:ult`).length === 0, "the lost-alignment banner is cleared");
}

console.log("\n[14. refused night N, guard not measured on night N+1 that ships → the refusal alert STAYS (#1434)]");
{
  // A not-measured night ships D1's unspliced render, which can carry the
  // very verses the refusal warned about: an absent measurement is not a
  // clean one, so the warning must outlive it.
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  const s3 = verseSpan(d.master, 3);
  d.master = (d.master.slice(0, s3.start) + d.master.slice(s3.start).replace(/^\\v 3\s*/, "")).replace(/\\v 2(?=\s)/, "\\v 2-3");
  const n2 = await t.exportOne("export-night-2");
  ok(String(n2.dcsSkippedReason).startsWith("master_moved_guard:"), `night N refused (got ${n2.dcsSkippedReason})`);
  ok(t.live(`export_master_moved:${BOOK}:ult`).length === 1, "night N records the refusal alert");
  // Night N+1: the base push's render is gone from R2, so the guard cannot
  // measure and the export ships as before.
  ok(t.r2.delete(`exports/export-night-1/${BOOK}/ult/${FILE}`), "(setup: base render removed)");
  t.editD1(4, "eagle", "hawk");
  const logs3 = [];
  const origLog3 = console.log;
  console.log = (...a) => {
    logs3.push(a.join(" "));
    origLog3(...a);
  };
  let n3;
  try {
    n3 = await t.exportOne("export-night-3");
  } finally {
    console.log = origLog3;
  }
  ok(logs3.some((l) => l.includes("keep-master guard not measured")), "(setup: night N+1's verse guard did not measure)");
  ok(d.writes.length === 1 && n3.dcsSkippedReason == null, `night N+1 ships (got ${n3.dcsSkippedReason}, writes ${d.writes.length})`);
  ok(t.live(`export_master_moved:${BOOK}:ult`).length === 1, "the refusal alert stays");
}

console.log("\n[14b. refused night N, guard measures and does not refuse on night N+1 → the refusal alert clears (#1434)]");
{
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  const confirmed = d.master;
  const s3 = verseSpan(d.master, 3);
  d.master = (d.master.slice(0, s3.start) + d.master.slice(s3.start).replace(/^\\v 3\s*/, "")).replace(/\\v 2(?=\s)/, "\\v 2-3");
  const n2 = await t.exportOne("export-night-2");
  ok(String(n2.dcsSkippedReason).startsWith("master_moved_guard:"), `night N refused (got ${n2.dcsSkippedReason})`);
  ok(t.live(`export_master_moved:${BOOK}:ult`).length === 1, "night N records the refusal alert");
  // Door43 undoes the bridge; the guard measures and finds nothing to refuse.
  d.master = confirmed;
  const n3 = await t.exportOne("export-night-3");
  ok(n3.dcsSkippedReason === "unchanged", `night N+1 ships (got ${n3.dcsSkippedReason})`);
  ok(t.live(`export_master_moved:${BOOK}:ult`).length === 0, "the refusal alert is cleared");
}

// D1 holds 1:5 with ONE word unaligned: translator-scale loss, which ships
// with a warning banner and does not block on its own. `badLayout` also puts
// a mixed \p/\m pair before 1:4, which the render does not self-heal, so the
// USFM validity gate holds the push. Master is Door43's real file with no
// proven base, so the keep-master verse guard does not measure.
function alignLossNight(badLayout) {
  const s5 = verseSpan(DOOR43_OBA, 5);
  const v5 = DOOR43_OBA.slice(s5.start, s5.end);
  const oneOff = v5.replace(/\\zaln-s \|[^\\]*\\\*/, "").replace(/\\zaln-e\\\*/, "");
  let file = DOOR43_OBA.slice(0, s5.start) + oneOff + DOOR43_OBA.slice(s5.end);
  if (badLayout) file = file.replace("\\q1 \\v 4 ", "\\p\n\\m\n\\q1 \\v 4 ");
  const d = door43();
  const t = freshEnv(file);
  d.master = DOOR43_OBA;
  return { d, t };
}

console.log("\n[15. translator-scale alignment loss, then held by the USFM validity gate → no \"shipped\" wording (#1448)]");
{
  const { d, t } = alignLossNight(true);
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => {
    logs.push(a.join(" "));
    origLog(...a);
  };
  let r;
  try {
    r = await t.exportOne("export-night-1");
  } finally {
    console.log = origLog;
  }
  ok(String(r.dcsSkippedReason).startsWith("usfm_invalid_guard:"), `held by the USFM gate (got ${r.dcsSkippedReason})`);
  ok(d.writes.length === 0, "nothing committed");
  const align = t.live(`export_align_shrink:${BOOK}:ult`);
  ok(align.length === 1, `the lost-alignment alert is recorded (${align.length})`);
  ok(align[0] && !align[0].message.includes("BLOCKED"), `(setup: the loss is translator-scale, not blocking: ${align[0]?.message})`);
  ok(align[0] && !/shipped|is on Door43/.test(align[0].message), `the alert does not say the book shipped (${align[0]?.message})`);
  ok(align[0] && align[0].message.includes("not pushed"), `the alert says it was not pushed (${align[0]?.message})`);
  ok(!logs.some((l) => l.includes("shipping")), `no "shipping" log line (${logs.filter((l) => l.includes("shipping")).join(" | ")})`);
}

console.log("\n[15b. the same loss on a night that ships → the \"shipped … but with alignment to fix\" banner, as before]");
{
  const { d, t } = alignLossNight(false);
  const r = await t.exportOne("export-night-1");
  ok(d.writes.length === 1 && r.dcsSkippedReason == null, `ships (got ${r.dcsSkippedReason}, writes ${d.writes.length})`);
  const align = t.live(`export_align_shrink:${BOOK}:ult`);
  ok(
    align.length === 1 && align[0].message.includes("shipped to Door43, but with alignment to fix"),
    `the alert says it shipped with alignment to fix (${align[0]?.message})`,
  );
}

console.log("\n[15c. the same loss when the Door43 commit fails → the step fails and no \"shipped\" wording (#1448)]");
{
  const { d, t } = alignLossNight(false);
  d.commitFails = true;
  let error = null;
  try {
    await t.exportOne("export-night-1");
  } catch (e) {
    error = e;
  }
  ok(error && String(error.message).startsWith("dcs_commit_failed"), `the commit throws (got ${error?.message})`);
  ok(d.writes.length === 0, "nothing committed");
  const align = t.live(`export_align_shrink:${BOOK}:ult`);
  ok(
    !align.some((a) => /shipped|is on Door43/.test(a.message)),
    `no alert says the book shipped (${align.map((a) => a.message).join(" | ")})`,
  );

  console.log("\n[15d. the step.do retry of that night, with Door43 back, ships and records the shipped banner]");
  d.commitFails = false;
  const r = await t.exportOne("export-night-1");
  ok(d.writes.length === 1 && r.dcsSkippedReason == null, `the retry ships (got ${r.dcsSkippedReason}, writes ${d.writes.length})`);
  const after = t.live(`export_align_shrink:${BOOK}:ult`);
  ok(
    after.length === 1 && after[0].message.includes("shipped to Door43, but with alignment to fix"),
    `the alert says it shipped with alignment to fix (${after[0]?.message})`,
  );
}

console.log("\n[16. Door43 rejects every write → after the retries an export_step_failed alert names the error (#1450)]");
{
  const d = door43();
  const t = freshEnv();
  d.master = DOOR43_OBA;
  d.commitFails = true;
  const failSource = `export_step_failed:${BOOK}:ult`;
  const step = retryingStep();
  const r = await t.exportStep(step, "export-night-1");
  ok(step.attempts[`export-${BOOK}-ult`] === 4, `the step ran 1 + 3 retries (got ${step.attempts[`export-${BOOK}-ult`]})`);
  ok(String(r.dcsSkippedReason).startsWith("error:dcs_commit_failed"), `the result is the recorded error (got ${r.dcsSkippedReason})`);
  ok(d.writes.length === 0, "nothing committed");
  const failed1 = t.live(failSource);
  ok(
    failed1.length === 1 && failed1[0].message.includes("dcs_commit_failed"),
    `one export_step_failed alert carries the error (${failed1.map((a) => a.message).join(" | ")})`,
  );

  console.log("\n[16b. a dry run the next night does not reach Door43 → the alert stays]");
  const dry = await t.exportStep(retryingStep(), "dry-night-2", false);
  ok(dry.dcsSkippedReason === "dry_run", `(setup: a dry run, got ${dry.dcsSkippedReason})`);
  ok(t.live(failSource).length === 1, "the alert is still up");

  console.log("\n[16c. the next night Door43 accepts the write → the alert clears]");
  d.commitFails = false;
  const r2 = await t.exportStep(retryingStep(), "export-night-3");
  ok(d.writes.length === 1 && r2.dcsSkippedReason == null, `the export ships (got ${r2.dcsSkippedReason}, writes ${d.writes.length})`);
  ok(t.live(failSource).length === 0, "the export_step_failed alert is gone");
}

console.log("\n[16e. after a failed night, Door43 already matching D1's render (`unchanged`) also clears the alert]");
{
  const d = door43();
  const t = freshEnv();
  d.master = DOOR43_OBA;
  d.commitFails = true;
  await t.exportStep(retryingStep(), "export-night-1");
  ok(t.live(`export_step_failed:${BOOK}:ult`).length === 1, "(setup: the failed night raised the alert)");
  d.commitFails = false;
  d.master = await t.render("n2");
  const r = await t.exportStep(retryingStep(), "export-night-2");
  ok(r.dcsSkippedReason === "unchanged", `(setup: unchanged, got ${r.dcsSkippedReason})`);
  ok(t.live(`export_step_failed:${BOOK}:ult`).length === 0, "the export_step_failed alert is gone");
}

console.log("\n[16f. a dismissed failure, a clean night, then the same failure again → a live alert]");
{
  const d = door43();
  const t = freshEnv();
  const failSource = `export_step_failed:${BOOK}:ult`;
  const dismiss = () =>
    t.sqlite.prepare(`UPDATE system_alerts SET dismissed_at = unixepoch() WHERE source = ? AND dismissed_at IS NULL`).run(failSource);
  d.master = DOOR43_OBA;
  d.commitFails = true;
  const dismissedReason = (await t.exportStep(retryingStep(), "export-night-1")).dcsSkippedReason;
  dismiss();
  ok(t.live(failSource).length === 0, "(setup: dismissed)");

  console.log("\n[16g. still failing with the same error → it stays dismissed (#458)]");
  await t.exportStep(retryingStep(), "export-night-2");
  ok(t.live(failSource).length === 0, "the dismissed alert does not come back");

  // A clean night that writes nothing (`unchanged`), so the next failure
  // makes the same create call and carries the identical message.
  d.commitFails = false;
  d.master = await t.render("n3");
  const clean = await t.exportStep(retryingStep(), "export-night-3");
  ok(clean.dcsSkippedReason === "unchanged", `(setup: a clean night, got ${clean.dcsSkippedReason})`);
  t.editD1(3, "pride", "arrogance");
  d.commitFails = true;
  const again = await t.exportStep(retryingStep(), "export-night-4");
  ok(again.dcsSkippedReason === dismissedReason, `(setup: the same error again, got ${again.dcsSkippedReason})`);
  ok(t.live(failSource).length === 1, `the new failure is a live alert (got ${t.live(failSource).length})`);
}

console.log("\n[16h. a locked book, and a branchName override run, do not clear the alert]");
{
  const d = door43();
  const t = freshEnv();
  const failSource = `export_step_failed:${BOOK}:ult`;
  d.master = DOOR43_OBA;
  d.commitFails = true;
  await t.exportStep(retryingStep(), "export-night-1");
  d.commitFails = false;
  const locked = await t.wf.runExportStep(retryingStep(), BOOK, "ult", null, () =>
    t.wf.exportOne(BOOK, "ult", "export-night-2", true, false, new Set([BOOK]), false),
  );
  ok(locked.dcsSkippedReason != null && d.writes.length === 0, `(setup: the lock skips, got ${locked.dcsSkippedReason})`);
  ok(t.live(failSource).length === 1, "the lock skip leaves the alert up");
  const override = await t.wf.runExportStep(retryingStep(), BOOK, "ult", "custom-branch", () =>
    t.exportOne("export-night-3"),
  );
  ok(override.dcsSkippedReason == null && d.writes.length === 1, `(setup: the override run ships, got ${override.dcsSkippedReason})`);
  ok(t.live(failSource).length === 1, "the branchName override run leaves the alert up");
}

console.log("\n[16d. Door43 fails once, then the step's own retry ships → no alert]");
{
  const d = door43();
  const t = freshEnv();
  d.master = DOOR43_OBA;
  const realFetch = globalThis.fetch;
  let failOnce = true;
  globalThis.fetch = async (input, init = {}) => {
    if ((init.method ?? "GET").toUpperCase() !== "GET" && String(input).includes(`/contents/${FILE}`) && failOnce) {
      failOnce = false;
      return new Response("boom", { status: 500 });
    }
    return realFetch(input, init);
  };
  const step = retryingStep();
  const r = await t.exportStep(step, "export-night-1");
  ok(step.attempts[`export-${BOOK}-ult`] === 2, `(setup: one retry, got ${step.attempts[`export-${BOOK}-ult`]})`);
  ok(d.writes.length === 1 && r.dcsSkippedReason == null, `the retry ships (got ${r.dcsSkippedReason})`);
  ok(t.live(`export_step_failed:${BOOK}:ult`).length === 0, "no export_step_failed alert");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nkeepMasterVersesJourney: all passed");
