// #1439 journey: the USFM (ULT) half of revertAfterImportJourney.test.mjs.
// The REAL ExportWorkflow.exportOne and the REAL verse reimport
// (applyVerseRows) on the REAL migration schema, with Door43 replaced by an
// in-memory stand-in and R2 by a Map (keepMasterVersesJourney.test.mjs's
// harness). D1 is seeded from a real Door43 ULT file (docs/samples/31-OBA.usfm).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/revertAfterImportVersesJourney.test.mjs
//
// The shape: a person commits a verse on master, the nightly reimport adopts
// it (book_resource_syncs origin 'reimport', source_sha = the file's head), a
// translator then edits that verse in Bible Editor, and the export ships.
// Master has not moved since the import, so the difference at that verse was
// made in Bible Editor: the report records it as probably ours (quiet), not
// export_revert. A verse the import did NOT take from master (kept D1's side,
// or only reconciled master's source attributes onto D1's wording) stays loud.

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
const { applyVerseRowsForTest } = await import("./bookReimport.ts");
const { extractVersesForRange } = await import("./importParsers.ts");
const { splitRevertRefs } = await import("../../scripts/watchdog/exportRevertCheck.mjs");
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

// Door43 stand-in: master's head commit is `d.head`, by default WATERMARK,
// the commit the reimport read. Case 4 moves it to model a later commit.
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

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(here, "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  const stmt = (sql, args = []) => ({
    sql,
    args,
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
      // Like D1, a SELECT inside a batch returns its rows (the reimport's CAS
      // batch reads verse_merge_conflicts, #1132).
      batch: async (stmts) => {
        sqlite.exec("BEGIN");
        try {
          const out = stmts.map((s) =>
            /^\s*SELECT/i.test(s.sql)
              ? { results: sqlite.prepare(s.sql).all(...s.args), meta: { changes: 0 } }
              : { meta: { changes: Number(sqlite.prepare(s.sql).run(...s.args).changes) } },
          );
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
  // An explicit unlock, so the reimport runs the ordinary (unlocked) merge.
  sqlite.prepare(`INSERT INTO book_locks (book, locked, set_at, set_by) VALUES (?, 0, 1, NULL)`).run(BOOK);
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator')`).run();
  const insert = sqlite.prepare(
    `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text)
     VALUES (?, ?, ?, ?, 'ULT', ?, ?)`,
  );
  for (const v of extractVersesForRange(DOOR43_OBA, 0, 999)) {
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
  const reverts = () =>
    sqlite.prepare(`SELECT ref, class, probably_ours FROM export_reverts WHERE book = ? ORDER BY ref`).all(BOOK);
  const render = async (tag) => {
    await exportOne(`dry-${tag}`, false);
    return r2.get(`exports/dry-${tag}/${BOOK}/ult/${FILE}`).body;
  };
  const contentOf = (verse) =>
    sqlite.prepare(`SELECT content_json FROM verses WHERE book = ? AND chapter = 1 AND verse = ? AND bible_version = 'ULT'`).get(BOOK, verse)
      .content_json;
  // A translator's edit in Bible Editor: one word of one verse, with its
  // edit_log row (an app PATCH logs { content } with source NULL).
  const editD1 = (verse, from, to, at) => {
    const cur = contentOf(verse);
    const next = cur.replace(`"text":"${from}"`, `"text":"${to}"`);
    if (next === cur) throw new Error(`test setup: "${from}" not in 1:${verse}`);
    sqlite
      .prepare(`UPDATE verses SET content_json = ?, version = version + 1, updated_by = 1 WHERE book = ? AND chapter = 1 AND verse = ? AND bible_version = 'ULT'`)
      .run(next, BOOK, verse);
    const r = sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, created_at)
         VALUES ('verse', ?, ?, 1, 1, 2, 'update', ?, NULL, ?)`,
      )
      .run(`${BOOK}/1/${verse}/ULT`, BOOK, JSON.stringify({ content: JSON.parse(next) }), at);
    return Number(r.lastInsertRowid);
  };
  return { sqlite, env, r2, exportOne, live, reverts, render, editD1, contentOf };
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
// A person editing one verse on Door43 (a word, or a milestone attribute).
function editMaster(usfm, verse, from, to) {
  const s = verseSpan(usfm, verse);
  const body = usfm.slice(s.start, s.end);
  const next = body.replace(from, to);
  if (next === body) throw new Error(`test setup: "${from}" not in master ${verse}`);
  return usfm.slice(0, s.start) + next + usfm.slice(s.end);
}
const lemmaIn = (usfm, verse) => verseText(usfm, verse).match(/x-lemma="([^"]+)"/)[1];

const NOW = Math.floor(Date.now() / 1000);
const AI_ONLY = { mayHoldHumanEdit: false, hasHumanCommit: false, incomplete: false, incompleteReason: "", counts: { ours: 1, ai: 1, human: 0 }, humanShas: [] };

// Night 1: master already holds D1's render, so the export is `unchanged`
// and master is confirmed.
async function confirmedNight1(t, d) {
  d.master = await t.render("n1");
  return t.exportOne("export-night-1");
}

// The nightly reimport of master's current file through the real
// applyVerseRows, then the clean watermark it stamps (source_sha = the file's
// head, origin 'reimport'). Returns synced_at.
async function reimport(t, d, cutoff = null) {
  const verses = extractVersesForRange(d.master, 1, 1);
  const counts = await applyVerseRowsForTest(t.env, BOOK, "ULT", verses, null, cutoff, false);
  if (counts.errors.length > 0) throw new Error(`reimport errors: ${counts.errors.join("; ")}`);
  const syncedAt = Number(t.sqlite.prepare(`SELECT MAX(created_at) AS m FROM edit_log`).get().m ?? NOW);
  t.sqlite
    .prepare(`UPDATE book_resource_syncs SET source_sha = ?, origin = 'reimport', synced_at = ? WHERE book = ? AND resource = 'ult'`)
    .run(WATERMARK, syncedAt, BOOK);
  return { counts, syncedAt };
}

console.log("\n[1. person commits a verse on master → reimport adopts it → in-app edit → export: quiet record only]");
{
  const d = door43();
  const t = freshEnv();
  const n1 = await confirmedNight1(t, d);
  ok(n1.dcsSkippedReason === "unchanged", `night 1 is unchanged (got ${n1.dcsSkippedReason})`);
  d.master = editMaster(d.master, 2, "\\w small|", "\\w tiny|");
  const { counts, syncedAt } = await reimport(t, d);
  ok(counts.updated >= 1, `(setup: the reimport wrote master's verses as a pristine update: updated ${counts.updated}; the rest are render round-trip churn)`);
  ok(t.contentOf(2).includes(`"text":"tiny"`), "(setup: D1 holds the person's word after the import)");
  t.editD1(2, "tiny", "very small", syncedAt + 100);

  await t.exportOne("export-night-2");
  ok(d.writes.length === 1 && verseText(d.branch, 2).includes("very small"), "the translator's edit ships");
  const rows = t.reverts();
  ok(rows.some((r) => r.ref === "1:2" && r.class === "substantive"), `the overwrite of 1:2 is still recorded (got ${JSON.stringify(rows)})`);
  ok(rows.length > 0 && rows.every((r) => r.probably_ours === 1), `every recorded verse is labelled probably ours (got ${JSON.stringify(rows)})`);
  ok(t.live(`export_revert:${BOOK}:ult`).length === 0, "no export_revert alert");
  ok(t.live(`mechanical_overwrite:${BOOK}:ult`).length === 0, "no mechanical_overwrite alert");
  const quiet = t.live(`revert_probably_ours:${BOOK}:ult`);
  ok(quiet.length === 1, "one quiet revert_probably_ours record");
  const msg = quiet[0]?.message ?? "";
  ok(/on 1 verse\(s\) that .*not a lost hand-edit: 1:2\. The stored Door43 edit history /s.test(msg), `the record lists 1:2 in the watchdog's parseable shape (${msg})`);
  ok(/imported master's current file/.test(msg) && !/row/.test(msg), "the record says why, in verse wording");
  const split = splitRevertRefs(rows.map((r) => r.ref), { book: BOOK, resource: "ult", exportRevert: null, probablyOurs: { id: 1, message: msg } });
  ok(split.split === "exact" && split.probablyOursRefs.includes("1:2"), `the watchdog parses the record (${JSON.stringify(split)})`);
}

console.log("\n[2. the import kept D1's side (keep_ai_master), once with a source-attribute reconcile → export_revert stays loud there]");
{
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  // The ancestor for verses 3 and 5: what night 1 published, logged before the boundary.
  const anc = t.sqlite.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, created_at)
     VALUES ('verse', ?, ?, NULL, 0, 1, 'update', ?, 'dcs_reimport', ?)`,
  );
  let boundary = 0;
  for (const v of [3, 5]) boundary = Number(anc.run(`${BOOK}/1/${v}/ULT`, BOOK, JSON.stringify({ content: t.contentOf(v) }), NOW - 5000).lastInsertRowid);
  // Translators edit 3 and 5 in the app before the import.
  t.editD1(3, "pride", "arrogance", NOW - 4000);
  t.editD1(5, "thieves", "robbers", NOW - 4000);
  // A person commits to all three verses on master; verse 3 also takes a
  // source-attribute fix (x-lemma) the reimport carries onto D1's wording.
  d.master = editMaster(d.master, 2, "\\w small|", "\\w tiny|");
  d.master = editMaster(d.master, 3, "\\w deceived|", "\\w fooled|");
  const lemma3 = lemmaIn(d.master, 3);
  d.master = editMaster(d.master, 3, `x-lemma="${lemma3}"`, `x-lemma="${lemma3}X"`);
  d.master = editMaster(d.master, 5, "\\w night|", "\\w nighttime|");
  const { counts, syncedAt } = await reimport(t, d, { confirmedAt: NOW - 4500, editId: boundary, lineage: AI_ONLY });
  ok(counts.merge_kept_ai === 2 && counts.source_attr_reconciled === 1 && counts.updated >= 1, `(setup: 2 kept, 1 reconciled, verse 2 taken: ${JSON.stringify({ kept: counts.merge_kept_ai, rec: counts.source_attr_reconciled, upd: counts.updated })})`);
  ok(t.contentOf(3).includes(`${lemma3}X`) && t.contentOf(3).includes(`"text":"arrogance"`), "(setup: verse 3 holds the translator's wording with master's lemma)");
  t.editD1(2, "tiny", "very small", syncedAt + 100);

  await t.exportOne("export-night-2");
  const rows = t.reverts();
  const label = (ref) => rows.find((r) => r.ref === ref)?.probably_ours;
  ok(label("1:2") === 1, `1:2 (taken from master by the import) is probably ours (got ${JSON.stringify(rows)})`);
  ok(label("1:3") === 0, "1:3 (source-attribute reconcile only) needs attention");
  ok(label("1:5") === 0, "1:5 (kept D1's side) needs attention");
  const loud = t.live(`export_revert:${BOOK}:ult`);
  ok(loud.length === 1 && loud[0].message.includes("1:3") && loud[0].message.includes("1:5") && !/\b1:2\b/.test(loud[0].message), `export_revert names 1:3 and 1:5, not 1:2 (${loud[0]?.message})`);
  ok(t.live(`revert_probably_ours:${BOOK}:ult`).length === 1, "and a quiet record for 1:2");
}

console.log("\n[3. the sync watermark is not a clean reimport (own_publish stamp) → export_revert stays loud]");
{
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  d.master = editMaster(d.master, 2, "\\w small|", "\\w tiny|");
  const { syncedAt } = await reimport(t, d);
  t.sqlite.prepare(`UPDATE book_resource_syncs SET origin = 'own_publish' WHERE book = ?`).run(BOOK);
  t.editD1(2, "tiny", "very small", syncedAt + 100);
  await t.exportOne("export-night-2");
  ok(t.reverts().some((r) => r.ref === "1:2" && r.probably_ours === 0), "1:2 needs attention");
  ok(t.live(`export_revert:${BOOK}:ult`).length === 1, "export_revert alert raised");
}

console.log("\n[4. a person commits to master again after the import → no quiet path]");
{
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  d.master = editMaster(d.master, 2, "\\w small|", "\\w tiny|");
  const { syncedAt } = await reimport(t, d);
  t.editD1(2, "tiny", "very small", syncedAt + 100);
  d.master = editMaster(d.master, 2, "\\w tiny|", "\\w little|");
  d.head = "b".repeat(40);
  const n2 = await t.exportOne("export-night-2");
  console.log(`    (export result: dcsSkippedReason=${n2.dcsSkippedReason}, writes=${d.writes.length})`);
  ok(t.live(`revert_probably_ours:${BOOK}:ult`).length === 0, "no quiet probably-ours record");
  ok(!t.reverts().some((r) => r.probably_ours === 1), "no verse labelled probably ours");
}

console.log("\n[5. the in-app edit landed before the import read master (D1's newest pre-import write is the translator's) → loud]");
{
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  d.master = editMaster(d.master, 2, "\\w small|", "\\w tiny|");
  const { syncedAt } = await reimport(t, d);
  // The app edit is stamped at or before synced_at: D1 did not hold master's
  // verse as the import left it.
  t.editD1(2, "tiny", "very small", syncedAt);
  await t.exportOne("export-night-2");
  ok(t.reverts().some((r) => r.ref === "1:2" && r.probably_ours === 0), "1:2 needs attention");
  ok(t.live(`export_revert:${BOOK}:ult`).length === 1, "export_revert alert raised");
}

// An edited verse (translator-owned) whose ancestor row sits below `editId`.
function seedEditedVerse(t, verse, at) {
  t.sqlite.prepare(`UPDATE verses SET updated_by = 1 WHERE book = ? AND chapter = 1 AND verse = ? AND bible_version = 'ULT'`).run(BOOK, verse);
  return Number(
    t.sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, created_at)
         VALUES ('verse', ?, ?, 1, 0, 1, 'update', ?, NULL, ?)`,
      )
      .run(`${BOOK}/1/${verse}/ULT`, BOOK, JSON.stringify({ content: t.contentOf(verse) }), at).lastInsertRowid,
  );
}
const HUMAN = { mayHoldHumanEdit: true, hasHumanCommit: true, incomplete: false, incompleteReason: "", counts: { ours: 1, ai: 0, human: 1 }, humanShas: ["abc123"] };

console.log("\n[6. review A1: a person fixes an x-lemma on Door43, D1's UHB is stale, the adoption's canonize folds it back → loud]");
{
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  // UHB rows with the same word bytes as the ULT's milestones and the lemma
  // D1 already had: the stale source the canonize step reads.
  for (const r of t.sqlite.prepare(`SELECT chapter, verse, content_json FROM verses WHERE book = ? AND bible_version = 'ULT'`).all(BOOK)) {
    const words = [];
    const walk = (nodes) => {
      for (const o of nodes ?? []) {
        if (o?.tag === "zaln" && typeof o.content === "string") {
          words.push({ tag: "w", type: "word", text: o.content, strong: o.strong ?? "", lemma: o.lemma ?? "", morph: o.morph ?? "" });
        }
        if (Array.isArray(o?.children)) walk(o.children);
      }
    };
    walk(JSON.parse(r.content_json).verseObjects);
    t.sqlite
      .prepare(`INSERT INTO verses (book, chapter, verse, bible_version, content_json, plain_text) VALUES (?, ?, ?, 'UHB', ?, '')`)
      .run(BOOK, r.chapter, r.verse, JSON.stringify({ verseObjects: words }));
  }
  const boundary = seedEditedVerse(t, 4, NOW - 5000);
  const lemma4 = lemmaIn(d.master, 4);
  d.master = editMaster(d.master, 4, `x-lemma="${lemma4}"`, `x-lemma="${lemma4}FIX"`);
  d.master = editMaster(d.master, 4, "\\w eagle|", "\\w vulture|");
  const { counts, syncedAt } = await reimport(t, d, { confirmedAt: NOW - 4500, editId: boundary, lineage: HUMAN });
  ok(counts.merge_adopted === 1 && t.contentOf(4).includes(`"text":"vulture"`), `(setup: verse 4 adopted master's verse: merge_adopted ${counts.merge_adopted})`);
  ok(!t.contentOf(4).includes(`${lemma4}FIX`), "(setup: canonize folded the person's lemma fix back to D1's stale UHB lemma)");
  // Resolve the merge row so only the payload evidence (A1) is under test.
  t.sqlite.prepare(`UPDATE verse_merge_conflicts SET resolved_at = unixepoch() WHERE book = ?`).run(BOOK);
  t.editD1(4, "vulture", "hawk", syncedAt + 100);
  await t.exportOne("export-night-2");
  ok(verseText(d.branch, 4).includes(`x-lemma="${lemma4}"`), "(the export does render the stale lemma over master's fix)");
  ok(t.reverts().some((r) => r.ref === "1:4" && r.probably_ours === 0), `1:4 needs attention (got ${JSON.stringify(t.reverts())})`);
  ok(t.live(`export_revert:${BOOK}:ult`).length === 1, "export_revert alert raised");
}

console.log("\n[7. review A2: adopt_conflict took the person's verse over a translator's edit, the translator re-types their text → loud]");
{
  const d = door43();
  const t = freshEnv();
  await confirmedNight1(t, d);
  const boundary = seedEditedVerse(t, 3, NOW - 5000);
  t.editD1(3, "pride", "arrogance", NOW - 4000);
  d.master = editMaster(d.master, 3, "\\w deceived|", "\\w fooled|");
  const { counts, syncedAt } = await reimport(t, d, { confirmedAt: NOW - 4500, editId: boundary, lineage: HUMAN });
  const conflict = t.sqlite.prepare(`SELECT action, resolved_at FROM verse_merge_conflicts WHERE book = ? AND verse = 3`).get(BOOK);
  ok(counts.merge_adopted === 1 && conflict?.action === "adopt_conflict" && conflict.resolved_at == null, `(setup: an unresolved adopt_conflict on 1:3: ${JSON.stringify(conflict)})`);
  ok(t.contentOf(3).includes(`"text":"fooled"`) && t.contentOf(3).includes(`"text":"pride"`), "(setup: D1 holds master's verse, as extracted: no UHB rows, so no canonize)");
  t.editD1(3, "pride", "arrogance", syncedAt + 100);
  await t.exportOne("export-night-2");
  ok(t.reverts().some((r) => r.ref === "1:3" && r.probably_ours === 0), `1:3 needs attention (got ${JSON.stringify(t.reverts())})`);
  ok(t.live(`export_revert:${BOOK}:ult`).length === 1, "export_revert alert raised");
  ok(t.live(`revert_probably_ours:${BOOK}:ult`).length === 0, "no quiet record");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nrevertAfterImportVersesJourney: all passed");
