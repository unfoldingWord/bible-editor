// #1439: what the REAL verse reimport (applyVerseRows) writes to edit_log, per
// outcome, measured on a real Door43 ULT file (docs/samples/31-OBA.usfm) with
// real \zaln milestones and a UHB source row per verse, on the real migration
// schema. The USFM half of the revert report's imported-head partition reads
// these payloads; this file pins what they hold:
//   - pristine update / create: master's verse exactly as extractVersesForRange
//     produced it from master's file;
//   - adoption over an edited verse (clean adopt, adopt_conflict): the same,
//     after canonizeAlignmentSource rewrote the \zaln source words to the UHB's
//     bytes (step 6);
//   - source-attribute reconcile on a kept verse: the translator's words with
//     master's source attributes, so NOT master's verse;
//   - kept verse with nothing to reconcile: no edit_log row at all.
// Then the real loader + matcher (revertImportVerses.ts) must say "D1 held
// master's verse" only for the pristine write and the create: an adoption's
// canonized bytes are not reproduced (review A1), and every adoption leaves an
// unresolved verse_merge_conflicts row, which keeps the verse loud (review A2).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/revertImportVersePayloadShape.test.mjs
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// bookReimport.ts imports siblings without an extension; resolve them the way
// revertImportPayloadShape.test.mjs does, so this file needs no run-tests.mjs entry.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-zA-Z0-9]+$/.test(specifier) && context.parentURL) {
      const target = fileURLToPath(new URL(specifier, context.parentURL));
      for (const ext of [".ts", ".mjs", ".js"]) {
        if (existsSync(target + ext)) return { url: pathToFileURL(target + ext).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { applyVerseRowsForTest } = await import("./bookReimport.ts");
const { extractVersesForRange } = await import("./importParsers.ts");
const { verseTextByRef } = await import("./export.ts");
const { EDIT_LOG_RETENTION_SECONDS } = await import("./editLogSweep.ts");
const { loadPreImportVerses, loadVerseConflictRefs, masterVersesAsImported, partitionUsfmRevertEntriesByImport, preImportVerseMatchesMaster } =
  await import("./revertImportVerses.ts");

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else console.log(`  ok: ${msg}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const BOOK = "OBA";
const DOOR43_OBA = readFileSync(join(here, "..", "..", "docs", "samples", "31-OBA.usfm"), "utf8");

// D1 shim: like applyVerseRows.test.mjs's, a SELECT inside batch() returns its
// rows (applyVerseRows reads verse_merge_conflicts inside its CAS batch, #1132).
function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(here, "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(dir, f), "utf8"));
  const mk = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => mk(sql, a),
    all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  });
  const env = {
    DB: {
      prepare: (sql) => mk(sql),
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
  };
  // An explicit unlock, so the ordinary (unlocked) merge runs.
  sqlite.prepare(`INSERT INTO book_locks (book, locked, set_at, set_by) VALUES (?, 0, 1, NULL)`).run(BOOK);
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator')`).run();
  return { sqlite, env };
}

// The two Hebrew combining-mark orders (UHB's dagesh-before-vowel and NFC's
// vowel-first) are the same word in different bytes. This sample's x-content
// is in UHB order, so a UHB row in the OTHER order makes the adoption's
// canonize step rewrite master's bytes, as it does in production whenever the
// two disagree.
const otherOrder = (s) => (s.normalize("NFC") !== s ? s.normalize("NFC") : s.replace(/([ְ-ׇֻ])ּ/g, "ּ$1"));
function uhbRowFor(contentJson) {
  const words = [];
  const walk = (nodes) => {
    for (const o of nodes ?? []) {
      if (o?.tag === "zaln" && typeof o.content === "string") {
        words.push({ tag: "w", type: "word", text: otherOrder(o.content), strong: o.strong ?? "", lemma: o.lemma ?? "", morph: o.morph ?? "" });
        words.push({ type: "text", text: " " });
      }
      if (Array.isArray(o?.children)) walk(o.children);
    }
  };
  walk(JSON.parse(contentJson).verseObjects);
  return JSON.stringify({ verseObjects: words });
}

// One word of one verse in master's USFM.
function editMasterWord(usfm, verse, from, to) {
  const start = usfm.search(new RegExp(`\\\\v ${verse}(?=\\s)`));
  const rest = usfm.slice(start + 3);
  const end = start + 3 + rest.search(/\\[vc]\s/);
  const body = usfm.slice(start, end);
  const next = body.replace(`\\w ${from}|`, `\\w ${to}|`);
  if (next === body) throw new Error(`test setup: "${from}" not in master ${verse}`);
  return usfm.slice(0, start) + next + usfm.slice(end);
}
// One milestone attribute of one verse in master's USFM.
function editMasterAttr(usfm, verse, from, to) {
  const start = usfm.search(new RegExp(`\\\\v ${verse}(?=\\s)`));
  const rest = usfm.slice(start + 3);
  const end = start + 3 + rest.search(/\\[vc]\s/);
  const body = usfm.slice(start, end);
  const next = body.replace(from, to);
  if (next === body) throw new Error(`test setup: "${from}" not in master ${verse}`);
  return usfm.slice(0, start) + next + usfm.slice(end);
}
const wordOf = (usfm, verse, n = 0) => {
  const start = usfm.search(new RegExp(`\\\\v ${verse}(?=\\s)`));
  const rest = usfm.slice(start + 3);
  const body = rest.slice(0, rest.search(/\\[vc]\s/));
  return [...body.matchAll(/\\w ([^|\s]+)\|/g)][n][1];
};

const seed = extractVersesForRange(DOOR43_OBA, 0, 999);
const seedOf = (v) => seed.find((x) => x.chapter === 1 && x.verse === v);

// Master after a person's commits: verses 1-6 each move one word; verse 4 also
// takes a source-attribute fix (x-lemma) the reconcile can carry.
let master = DOOR43_OBA;
for (const v of [1, 2, 3, 4, 5, 6]) master = editMasterWord(master, v, wordOf(master, v), `${wordOf(master, v)}Q`);
const lemma4 = DOOR43_OBA.slice(DOOR43_OBA.search(/\\v 4(?=\s)/)).match(/x-lemma="([^"]+)"/)[1];
master = editMasterAttr(master, 4, `x-lemma="${lemma4}"`, `x-lemma="${lemma4}X"`);
const masterVerses = extractVersesForRange(master, 0, 999);
const masterOf = (v) => masterVerses.find((x) => x.chapter === 1 && x.verse === v);

console.log("\n[0. extractVersesForRange parses the whole file, so a chapter range and the whole book give the same verse]");
{
  const ch1 = extractVersesForRange(master, 1, 1);
  ok(ch1.length > 0 && ch1.every((v) => masterVerses.some((w) => w.chapter === v.chapter && w.verse === v.verse && w.contentJson === v.contentJson)), "per-chapter and whole-book extracts agree byte for byte");
}

const { sqlite, env } = freshEnv();
const insertVerse = sqlite.prepare(
  `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
for (const v of seed) {
  if (v.chapter === 1 && v.verse === 6) continue; // verse 6 is new in master: the reimport creates it
  const edited = v.chapter === 1 && v.verse >= 2 && v.verse <= 5;
  insertVerse.run(BOOK, v.chapter, v.verse, v.verseEnd, "ULT", v.contentJson, v.plainText, edited ? 3 : 1, edited ? 1 : null);
  insertVerse.run(BOOK, v.chapter, v.verse, v.verseEnd, "UHB", uhbRowFor(v.contentJson), "", 1, null);
}
const logRow = sqlite.prepare(
  `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, created_at)
   VALUES ('verse', ?, ?, ?, ?, ?, 'update', ?, ?, ?)`,
);
const key = (v) => `${BOOK}/1/${v}/ULT`;
// The ancestor (what we last published) for the edited verses 2-5.
let boundary = 0;
for (const v of [2, 3, 4, 5]) {
  boundary = Number(logRow.run(key(v), BOOK, 1, 1, 2, JSON.stringify({ plain_text: seedOf(v).plainText, content: seedOf(v).contentJson }), null, 100).lastInsertRowid);
}
// Translator edits after that publish on verses 3, 4 and 5 (verse 2 stays as published).
for (const v of [3, 4, 5]) {
  const w = wordOf(DOOR43_OBA, v, 1);
  const json = seedOf(v).contentJson.replace(`"text":"${w}"`, `"text":"${w}T"`);
  if (json === seedOf(v).contentJson) throw new Error(`test setup: "${w}" not in D1 ${v}`);
  sqlite.prepare(`UPDATE verses SET content_json = ? WHERE book = ? AND chapter = 1 AND verse = ? AND bible_version = 'ULT'`).run(json, BOOK, v);
  logRow.run(key(v), BOOK, 1, 2, 3, JSON.stringify({ content: JSON.parse(json) }), null, 300);
}
const HUMAN = { mayHoldHumanEdit: true, hasHumanCommit: true, incomplete: false, incompleteReason: "", counts: { ours: 1, ai: 0, human: 1 }, humanShas: ["abc123"] };
const AI_ONLY = { mayHoldHumanEdit: false, hasHumanCommit: false, incomplete: false, incompleteReason: "", counts: { ours: 1, ai: 1, human: 0 }, humanShas: [] };
// Copies: applyVerseRows canonizes an adoption's contentJson in place.
const pick = (verses) => masterVerses.filter((x) => x.chapter === 1 && verses.includes(x.verse)).map((x) => ({ ...x }));
const ca = await applyVerseRowsForTest(env, BOOK, "ULT", pick([1, 2, 3, 6]), null, { confirmedAt: 200, editId: boundary, lineage: HUMAN }, false);
const cb = await applyVerseRowsForTest(env, BOOK, "ULT", pick([4, 5]), null, { confirmedAt: 200, editId: boundary, lineage: AI_ONLY }, false);

console.log("\n[1. the reimport took the paths this test means to measure]");
ok(ca.errors.length === 0 && cb.errors.length === 0, `no reimport errors (${JSON.stringify([...ca.errors, ...cb.errors])})`);
ok(ca.updated >= 1 && ca.inserted === 1, `pristine update and create (updated ${ca.updated}, inserted ${ca.inserted})`);
ok(ca.merge_adopted === 2, `clean adopt + adopt_conflict landed (merge_adopted ${ca.merge_adopted})`);
ok(cb.merge_kept_ai === 2 && cb.source_attr_reconciled === 1, `kept: 2 keep_ai_master, 1 source-attr reconcile (kept ${cb.merge_kept_ai}, reconciled ${cb.source_attr_reconciled})`);
const conflicts = sqlite.prepare(`SELECT verse, action FROM verse_merge_conflicts WHERE book = ? ORDER BY verse`).all(BOOK);
console.log(`    verse_merge_conflicts: ${JSON.stringify(conflicts)}`);

console.log("\n[2. measured payloads: the newest edit_log row per verse]");
const latest = (v) =>
  sqlite
    .prepare(`SELECT action, source, payload_json FROM edit_log WHERE kind = 'verse' AND row_key = ? ORDER BY id DESC LIMIT 1`)
    .get(key(v));
const voJson = (contentJson) => JSON.stringify(JSON.parse(contentJson).verseObjects);
const canonized = new Map(); // verse -> extract content after the adoption's canonize step, filled from D1 below
const masterRaw = verseTextByRef(master);
const measured = {};
for (const v of [1, 2, 3, 4, 5, 6]) {
  const r = latest(v);
  const p = JSON.parse(r.payload_json);
  const content = typeof p.content === "string" ? voJson(p.content) : JSON.stringify(p.content?.verseObjects);
  const d1 = sqlite.prepare(`SELECT content_json FROM verses WHERE book = ? AND chapter = 1 AND verse = ? AND bible_version = 'ULT'`).get(BOOK, v).content_json;
  canonized.set(v, voJson(d1));
  measured[v] = {
    action: r.action,
    source: r.source,
    keys: Object.keys(p).sort().join(","),
    contentType: typeof p.content,
    equalsExtract: content === voJson(masterOf(v).contentJson),
    equalsVerseTextByRef: content === masterRaw.get(`1:${v}`),
    equalsD1Now: content === voJson(d1),
  };
  console.log(`    1:${v} ${JSON.stringify(measured[v])}`);
}
ok(measured[1].action === "update" && measured[1].source === "dcs_reimport" && measured[1].keys === "content,plain_text" && measured[1].contentType === "string", "pristine update: 'update', dcs_reimport, { plain_text, content: <string> }");
ok(measured[1].equalsExtract, "pristine update: content is master's verse as extracted");
ok(measured[6].action === "create" && measured[6].equalsExtract, "create: 'create', content is master's verse as extracted");
ok(measured[2].action === "update" && measured[2].source === "dcs_reimport" && measured[2].equalsD1Now, "clean adopt: 'update', dcs_reimport, content is what D1 now holds");
ok(!measured[2].equalsExtract, "clean adopt: content is NOT the raw extract when canonize rewrote the source words");
ok(measured[3].action === "update" && measured[3].equalsD1Now && !measured[3].equalsExtract, "adopt_conflict: same shape as a clean adopt");
ok(measured[4].action === "update" && measured[4].source === "dcs_reimport" && !measured[4].equalsExtract, "source-attr reconcile: 'update', dcs_reimport, same payload keys, but NOT master's verse");
ok(measured[4].keys === "content,plain_text", "source-attr reconcile: payload keys are the adoption's — source and shape cannot tell them apart, only content can");
ok(measured[5].source === null && !measured[5].equalsExtract, "kept (keep_ai_master, nothing to reconcile): no reimport row; the newest is the translator's own");

console.log("\n[3. the real loader + matcher read those payloads: D1 held master's verse for exactly the taken verses]");
{
  const syncedAt = Number(sqlite.prepare(`SELECT MAX(created_at) AS m FROM edit_log`).get().m);
  const refs = [1, 2, 3, 4, 5, 6].map((v) => `1:${v}`);
  const pre = await loadPreImportVerses(env.DB, BOOK, "ULT", refs, syncedAt);
  const asImported = masterVersesAsImported(master);
  const verdict = Object.fromEntries(refs.map((r) => [r, preImportVerseMatchesMaster(pre.get(r), asImported.get(r))]));
  console.log(`    ${JSON.stringify(verdict)}`);
  ok(verdict["1:1"] && verdict["1:6"], "pristine update and create match the raw extract");
  ok(!verdict["1:2"] && !verdict["1:3"], "adoptions whose canonize step changed bytes do not match (review A1: canonize is not reproduced)");
  ok(!verdict["1:4"], "source-attr reconcile does not match (translator's wording)");
  ok(!verdict["1:5"], "kept verse does not match (translator's own row)");
  const open = await loadVerseConflictRefs(env.DB, BOOK, "ult", refs, syncedAt - 86400);
  ok(JSON.stringify([...open].sort()) === JSON.stringify(["1:2", "1:3"]), `the adoptions left unresolved verse_merge_conflicts rows (got ${JSON.stringify([...open])})`);
  const parts = partitionUsfmRevertEntriesByImport(refs.map((ref) => ({ ref, class: "substantive" })), asImported, pre, open);
  ok(JSON.stringify([parts.attention.map((e) => e.ref), parts.probablyOurs.map((e) => e.ref)]) === JSON.stringify([["1:2", "1:3", "1:4", "1:5"], ["1:1", "1:6"]]), "partition: only the pristine write and the create are probably ours");
  // Review A2 on its own: a matching payload with an open conflict row stays loud.
  const forced = new Map(pre);
  forced.set("1:3", asImported.get("1:3"));
  const p2 = partitionUsfmRevertEntriesByImport([{ ref: "1:3", class: "substantive" }], asImported, forced, open);
  ok(p2.probablyOurs.length === 0, "an exact payload match with an unresolved conflict row still needs attention");
  const p3 = partitionUsfmRevertEntriesByImport([{ ref: "1:3", class: "substantive" }], asImported, forced, new Set());
  ok(p3.probablyOurs.length === 1, "(control: the same verse with no conflict row is probably ours)");
  // Review B1: an app save resolves the row; a row this import recorded still counts.
  sqlite.prepare(`UPDATE verse_merge_conflicts SET resolved_at = ?, resolved_by = 1 WHERE book = ?`).run(syncedAt + 100, BOOK);
  const afterSave = await loadVerseConflictRefs(env.DB, BOOK, "ult", refs, syncedAt - 86400);
  ok(JSON.stringify([...afterSave].sort()) === JSON.stringify(["1:2", "1:3"]), "resolved rows recorded at or after the bound still count");
  // Review C1: 1:3's adopt_conflict was recorded by an EARLIER import (before
  // the bound), stayed unresolved across our confirmed push and this import,
  // and the translator's save after this import resolved it: still counts.
  // 1:2's row was recorded AND resolved before the bound (an earlier import's
  // settled flag): does not count.
  const DAY = 86400;
  const setRow = sqlite.prepare(`UPDATE verse_merge_conflicts SET detected_at = ?, last_recorded_at = ?, resolved_at = ? WHERE book = ? AND verse = ?`);
  setRow.run(syncedAt - 5 * DAY, syncedAt - 5 * DAY, syncedAt + 100, BOOK, 3);
  setRow.run(syncedAt - 5 * DAY, syncedAt - 5 * DAY, syncedAt - 4 * DAY, BOOK, 2);
  const c1 = await loadVerseConflictRefs(env.DB, BOOK, "ult", refs, syncedAt - DAY);
  ok(JSON.stringify([...c1]) === JSON.stringify(["1:3"]), `recorded before the bound but resolved after it counts; recorded and resolved before it does not (got ${JSON.stringify([...c1])})`);
  const pc1 = partitionUsfmRevertEntriesByImport([{ ref: "1:3", class: "substantive" }], asImported, forced, c1);
  ok(pc1.probablyOurs.length === 0, "C1: the matching 1:3 with an earlier import's conflict, resolved after the bound, still needs attention");
  // The sweep floor: the same rows, read as if the import were ~179 days old.
  const late = await loadPreImportVerses(env.DB, BOOK, "ULT", refs, syncedAt, syncedAt + EDIT_LOG_RETENTION_SECONDS - 86400 + 1);
  ok(refs.every((r) => late.get(r) === null), "a picked row within a day of the retention cutoff is no evidence");
}

if (failed > 0) {
  console.error(`\n${failed} revertImportVersePayloadShape check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll revertImportVersePayloadShape checks passed.");
