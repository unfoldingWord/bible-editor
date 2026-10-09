// Issue #1160: rerun the notes pipeline on a verse range of one chapter.
// Covers the whole path the range travels:
//   /start schema (StartBody)  ->  options_json.verseRange
//   dispatchNext               ->  top-level verseStart/verseEnd for the bot,
//                                  options without verseRange, kept list intact
//   resume                     ->  verseRange stripped (bot schema is strict)
//   pollPipelineJob -> import  ->  ImportContext.verseRange, so nothing outside
//                                  the range is staged or swept (#1151 guard)
// The last part is BEHAVIOURAL: the real pollPipelineJob drives the real
// importJobOutput against a migrated node:sqlite database.
// Run from api/: node --experimental-sqlite --experimental-strip-types --no-warnings src/pipelineVerseRange.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  StartBody,
  dispatchNext,
  pollPipelineJob,
  resumeOptionsFromJson,
  verseRangeFromOptionsJson,
} from "./pipelines.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; } else console.log(`  ok: ${msg}`);
}

console.log("\n[StartBody]");
{
  const base = { pipelineType: "notes", book: "JER", startChapter: 36, sessionKey: "s" };
  const ok = (b) => StartBody.safeParse(b).success;
  assert(ok({ ...base, verseStart: 10, verseEnd: 15 }), "notes, one chapter, 10-15 → accepted");
  assert(ok({ ...base, endChapter: 36, verseStart: 10, verseEnd: 10 }), "explicit endChapter = startChapter, one verse → accepted");
  assert(ok(base), "no verse range → accepted (whole chapter, unchanged)");
  assert(!ok({ ...base, endChapter: 37, verseStart: 10, verseEnd: 15 }), "two chapters with a verse range → rejected");
  assert(!ok({ ...base, pipelineType: "tqs", verseStart: 10, verseEnd: 15 }), "tqs with a verse range → rejected");
  assert(!ok({ ...base, pipelineType: "generate", verseStart: 10, verseEnd: 15 }), "generate with a verse range → rejected");
  assert(!ok({ ...base, verseStart: 10 }), "verseStart without verseEnd → rejected");
  assert(!ok({ ...base, verseEnd: 15 }), "verseEnd without verseStart → rejected");
  assert(!ok({ ...base, verseStart: 15, verseEnd: 10 }), "end before start → rejected");
  assert(!ok({ ...base, verseStart: 0, verseEnd: 3 }), "verse 0 → rejected");
  assert(!ok({ ...base, verseStart: 10, verseEnd: 15, followUpChain: [{ pipelineType: "tqs" }] }), "verse range with a follow-up chain → rejected");
}

console.log("\n[verseRangeFromOptionsJson]");
assert(JSON.stringify(verseRangeFromOptionsJson(JSON.stringify({ verseRange: { start: 10, end: 15 } }))) === '{"start":10,"end":15}', "reads the stored range");
assert(verseRangeFromOptionsJson(null) === null, "no options → whole chapter");
assert(verseRangeFromOptionsJson(JSON.stringify({ noIntro: true })) === null, "options without a range → whole chapter");
assert(verseRangeFromOptionsJson("{not json") === null, "unparseable → null");

console.log("\n[resume]");
{
  const r = resumeOptionsFromJson(JSON.stringify({ noIntro: true, verseRange: { start: 10, end: 15 } }), "j");
  assert(r && r.verseRange === undefined && r.noIntro === true, "resumeOptionsFromJson strips verseRange, keeps the rest");
}

// ── dispatchNext: fake D1, same shape as keptDispatch.test.mjs ──
const KEPT_IN_RANGE = { id: "kin1", book: "JER", chapter: 36, verse: 12, ref_raw: "36:12", quote: "q", note: "n", support_reference: "rc://*/ta/man/translate/figs-metaphor", preserve: 1 };
const KEPT_OUTSIDE = { ...KEPT_IN_RANGE, id: "kout", verse: 3, ref_raw: "36:3" };
function fakeDispatchEnv({ optionsJson, flag = "true" }) {
  const job = { job_id: "job-r", user_id: 1, pipeline_type: "notes", book: "JER", start_chapter: 36, end_chapter: 36, session_key: "s", options_json: optionsJson };
  return {
    BT_API_TOKEN: "tok",
    KEPT_NOTES_ENABLED: flag,
    DB: {
      prepare(sql) {
        if (/SELECT dcs_username FROM users/.test(sql)) return { bind: () => ({ first: async () => ({ dcs_username: "translator" }) }) };
        if (/SELECT DISTINCT book FROM pipeline_jobs WHERE state = 'queued'/.test(sql)) return { all: async () => ({ results: [] }) };
        if (/SET state = 'dispatching', updated_at = unixepoch\(\)/.test(sql)) return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
        if (/SELECT job_id, user_id, pipeline_type, book, start_chapter, end_chapter,[\s\S]*session_key, options_json/.test(sql)) {
          return { first: async () => job, bind: () => ({ first: async () => job }) };
        }
        if (/FROM tn_rows/.test(sql)) return { bind: () => ({ all: async () => ({ results: [KEPT_OUTSIDE, KEPT_IN_RANGE] }) }) };
        if (/FROM edit_log/.test(sql)) return { bind: () => ({ all: async () => ({ results: [] }) }) };
        return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }), first: async () => null, all: async () => ({ results: [] }) }) };
      },
    },
  };
}
const originalFetch = globalThis.fetch;
async function dispatch(cfg) {
  let body = null;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ jobId: "bot-1" }), { status: 200 }); };
  try { await dispatchNext(fakeDispatchEnv(cfg)); } finally { globalThis.fetch = originalFetch; }
  return body;
}

console.log("\n[dispatchNext]");
{
  const body = await dispatch({ optionsJson: JSON.stringify({ noIntro: true, verseRange: { start: 10, end: 15 } }) });
  assert(body.verseStart === 10 && body.verseEnd === 15, "range run sends top-level verseStart/verseEnd");
  assert(body.startChapter === 36 && body.endChapter === 36, "…for one chapter");
  assert(body.options && body.options.verseRange === undefined, "…and verseRange is not left inside options (the bot's schema is strict)");
  assert(body.options.noIntro === true, "…other stored options still go");
  const keptIds = (body.options.kept ?? []).map((k) => k.rowId).sort();
  assert(JSON.stringify(keptIds) === JSON.stringify(["kin1", "kout"]), "…the kept list still covers the chapter, so the range's kept/preserved notes reach the bot (#1152)");
}
{
  const body = await dispatch({ optionsJson: JSON.stringify({ verseRange: { start: 10, end: 15 } }), flag: "false" });
  assert(body.verseStart === 10 && body.verseEnd === 15 && body.options === undefined, "range-only options_json → no options key at all");
}
{
  const body = await dispatch({ optionsJson: JSON.stringify({ noIntro: true }), flag: "false" });
  assert(body.verseStart === undefined && body.verseEnd === undefined, "whole-chapter run sends no verse fields (unchanged)");
}

// ── BEHAVIOURAL: pollPipelineJob -> importJobOutput on real SQLite ──
const migDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const migrations = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => readFileSync(join(migDir, f), "utf8"));

const AI = { quote: "q", note: "Old AI note.", support_reference: "rc://*/ta/man/translate/figs-metaphor" };
function freshDb(optionsJson) {
  const sqlite = new DatabaseSync(":memory:");
  for (const m of migrations) sqlite.exec(m);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async first() { return sqlite.prepare(sql).all(...args)[0] ?? null; },
    async run() {
      if (/\bRETURNING\b/i.test(sql)) {
        const rows = sqlite.prepare(sql).all(...args);
        return { results: rows, meta: { changes: rows.length } };
      }
      return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } };
    },
  });
  const DB = {
    prepare: (sql) => stmt(sql),
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 700, 'translator7')`).run();
  sqlite.prepare(
    `INSERT INTO pipeline_jobs (job_id, upstream_job_id, user_id, pipeline_type, book, start_chapter,
       end_chapter, session_key, state, options_json, updated_at)
     VALUES ('job-jer36', 'bot-jer36', 7, 'notes', 'JER', 36, 36, 's', 'running', ?, unixepoch())`,
  ).run(optionsJson);
  let seq = 0;
  const addTn = (verse, { preserve = 0 } = {}) => {
    const id = `o${String(++seq).padStart(3, "0")}`;
    sqlite.prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, quote, note, support_reference, preserve, hint, updated_by, version)
       VALUES (?, 'JER', 36, ?, ?, ?, ?, ?, ?, 0, 7, 1)`,
    ).run(id, verse, `36:${verse}`, AI.quote, AI.note, AI.support_reference, preserve);
    sqlite.prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, action, source, payload_json, created_at)
       VALUES ('tn', ?, 'JER', 7, 'create', 'ai_pipeline', ?, ?)`,
    ).run(id, JSON.stringify(AI), 1000 + seq);
    return id;
  };
  const live = (id) => sqlite.prepare(`SELECT deleted_at FROM tn_rows WHERE id = ?`).get(id).deleted_at == null;
  const liveAt = (verse) => sqlite.prepare(
    `SELECT id, note FROM tn_rows WHERE book = 'JER' AND chapter = 36 AND verse = ? AND deleted_at IS NULL ORDER BY id`,
  ).all(verse);
  // Inert ChapterRoom so the post-apply broadcast doesn't log a failure.
  const CHAPTER_ROOM = { idFromName: () => "id", get: () => ({ fetch: async () => new Response("ok") }) };
  return { env: { DB, BT_API_TOKEN: "tok", CHAPTER_ROOM }, addTn, live, liveAt };
}

// The bot's en_tn output is the whole book file: master's notes for verses
// 1-9 come back alongside the new notes for 10-15.
const TSV =
  "ID\tReference\tTags\tSupportReference\tQuote\tOccurrence\tNote\n" +
  "m003\t36:3\t\t\t\t\tMaster's copy of a verse-3 note.\n" +
  "n012\t36:12\t\t\t\t\tNew AI note for verse 12.\n" +
  "m020\t36:20\t\t\t\t\tMaster's copy of a verse-20 note.\n";

async function poll(optionsJson) {
  const t = freshDb(optionsJson);
  const ids = {
    v3Ai: t.addTn(3),
    v5Ai: t.addTn(5),
    v12Ai: t.addTn(12),
    v12Preserve: t.addTn(12, { preserve: 1 }),
    v14Ai: t.addTn(14),
    v20Ai: t.addTn(20),
  };
  const job = {
    job_id: "job-jer36", upstream_job_id: "bot-jer36", user_id: 7, pipeline_type: "notes",
    book: "JER", start_chapter: 36, end_chapter: 36, session_key: "s",
    follow_up_options: null, follow_up_chain: null, follow_up_job_id: null,
    no_output_yet: 1, error_kind: null, updated_at: Math.floor(Date.now() / 1000),
    resume_attempt_count: 0, last_resume_at: null, resume_accepted_at: null,
    options_json: optionsJson,
  };
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/pipeline/bot-jer36")) {
      return new Response(JSON.stringify({
        state: "done",
        output: [{ type: "tsv", repo: "unfoldingWord/en_tn", rawUrl: "https://raw.example/en_tn_JER.tsv" }],
      }), { status: 200 });
    }
    if (String(url).includes("raw.example")) return new Response(TSV, { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  let result;
  try { result = await pollPipelineJob(t.env, job); } finally { globalThis.fetch = originalFetch; }
  return { t, ids, result };
}

console.log("\n[pollPipelineJob → import, verse-range job 10-15]");
{
  const { t, ids, result } = await poll(JSON.stringify({ verseRange: { start: 10, end: 15 } }));
  assert(result.kind === "ok" && result.state === "done", `poll finished done (got ${result.kind}/${result.state})`);
  assert(t.live(ids.v3Ai), "verse 3 (outside, master sent a note for it) — old AI note untouched");
  assert(!t.liveAt(3).some((r) => r.id === "m003"), "…and master's verse-3 row was NOT imported");
  assert(t.live(ids.v5Ai), "verse 5 (outside, no output) — untouched");
  assert(t.live(ids.v20Ai), "verse 20 (outside, after the range) — untouched");
  assert(!t.liveAt(20).some((r) => r.id === "m020"), "…and master's verse-20 row was NOT imported");
  assert(!t.live(ids.v12Ai), "verse 12 (inside, new note) — old AI note retired");
  assert(t.live(ids.v12Preserve), "verse 12 — preserved note stays");
  assert(t.liveAt(12).some((r) => r.id === "n012"), "verse 12 — the new AI note landed");
  assert(t.live(ids.v14Ai), "verse 14 (inside, no new note) — kept: the bot's range push replaces only verses it wrote");
}

console.log("\n[control: the same output on a whole-chapter job]");
{
  const { t, ids } = await poll(null);
  assert(!t.live(ids.v3Ai) && !t.live(ids.v5Ai), "whole-chapter job DOES retire verses 3 and 5 — so the range test above is discriminating");
}

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log("pipelineVerseRange tests passed");
