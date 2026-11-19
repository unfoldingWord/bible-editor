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
        return json({ sha: "blob-" + text.length, size: Buffer.byteLength(text), content: b64(text), encoding: "base64" });
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
  return { sqlite, env, r2, exportOne, live, reverts, render, editD1 };
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

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nkeepMasterVersesJourney: all passed");
