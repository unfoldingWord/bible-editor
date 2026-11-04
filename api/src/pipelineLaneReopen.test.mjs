// An AI pipeline verse write reopens the verse's checkoffs, exactly as a human
// edit of the verse does (verses.ts → lanesToReopenOnVerseEdit): 'text'
// always, 'tw' too when a ULT `\w` word changed, and nothing when the write
// lost its version CAS. Before this, applyVerseUpdate never touched
// verse_lane_checks, so a regenerated verse kept a green Text check signing
// off on text nobody had reviewed.
//
// Drives the real importJobOutput → applyVerseUpdate against real SQLite with
// every real migration applied (same D1 shim as rowProvenanceStamps.test.mjs).
// Run from api/:
//   node --experimental-strip-types --no-warnings src/pipelineLaneReopen.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { importJobOutput } from "./pipelineImport.ts";
import { checkedVersesConfirmationRequired, countCheckedTextVerses } from "./pipelines.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// `beforeBatch` lets a case race a concurrent write in between applyVerseUpdate's
// SELECT and its guarded UPDATE batch.
function makeDb(sqlite, beforeBatch = () => {}) {
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
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      beforeBatch(stmts);
      const out = [];
      for (const s of stmts) out.push(s.run());
      return out;
    },
  };
}

const BOOK = "JER";
const JOB = "job-gen-1";

const w = (text) => ({ type: "word", tag: "w", text, occurrence: "1", occurrences: "1" });
const content = (...words) => {
  const verseObjects = [];
  words.forEach((x, i) => {
    if (i > 0) verseObjects.push({ type: "text", text: " " });
    verseObjects.push(w(x));
  });
  return JSON.stringify({ verseObjects });
};

function setup({ proposals, beforeBatch } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator9')`).run();
  // staged_at set: the proposals below are already staged, so the import goes
  // straight to the apply phase.
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs
         (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, staged_at)
       VALUES (?, 1, 'generate', ?, 2, 2, 'sess-1', 'running', unixepoch())`,
    )
    .run(JOB, BOOK);
  const insVerse = sqlite.prepare(
    `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version)
     VALUES (?, 2, ?, NULL, ?, ?, ?, 1)`,
  );
  for (const v of [1, 2]) {
    insVerse.run(BOOK, v, "ULT", content("the", "dog"), "the dog");
    insVerse.run(BOOK, v, "UST", content("a", "dog"), "a dog");
  }
  const check = sqlite.prepare(
    `INSERT INTO verse_lane_checks (book, chapter, verse, lane, checked_by, checked_at) VALUES (?, 2, ?, ?, ?, 100)`,
  );
  for (const v of [1, 2, 3]) {
    for (const lane of ["text", "tw", "tn"]) {
      check.run(BOOK, v, lane, 1);
      check.run(BOOK, v, lane, 7); // a second checker
    }
  }
  const insProp = sqlite.prepare(
    `INSERT INTO pending_imports (job_id, kind, book, chapter, verse, bible_version, payload_json)
     VALUES (?, 'verse', ?, 2, ?, ?, ?)`,
  );
  for (const p of proposals) {
    insProp.run(
      JOB,
      BOOK,
      p.verse,
      p.bibleVersion,
      JSON.stringify({
        book: BOOK,
        chapter: 2,
        verse: p.verse,
        bible_version: p.bibleVersion,
        content_json: p.contentJson,
        plain_text: p.plainText,
      }),
    );
  }
  const sent = [];
  const room = {
    idFromName: (n) => n,
    get: () => ({
      fetch: async (req) => {
        sent.push(JSON.parse(await req.text()));
        return new Response("ok");
      },
    }),
  };
  const env = { DB: makeDb(sqlite, beforeBatch ? (stmts) => beforeBatch(sqlite, stmts) : undefined), CHAPTER_ROOM: room };
  return { sqlite, env, sent };
}

const run = (env) =>
  importJobOutput(env, { jobId: JOB, pipelineType: "generate", book: BOOK, startChapter: 2, endChapter: 2 }, []);

const lanesLeft = (sqlite, verse) =>
  [
    ...new Set(
      sqlite
        .prepare(`SELECT lane FROM verse_lane_checks WHERE book = ? AND chapter = 2 AND verse = ? ORDER BY lane`)
        .all(BOOK, verse)
        .map((r) => r.lane),
    ),
  ];

console.log("\n[AI ULT write that changes a word reopens 'text' and 'tw'; UST write reopens only 'text']");
{
  const { sqlite, env, sent } = setup({
    proposals: [
      { verse: 1, bibleVersion: "ULT", contentJson: content("the", "cat"), plainText: "the cat" },
      { verse: 2, bibleVersion: "UST", contentJson: content("a", "cat"), plainText: "a cat" },
    ],
  });
  const result = await run(env);
  eq(result.applied?.verseUpdated, 2, "sanity: both AI verse writes landed");
  eq(lanesLeft(sqlite, 1), ["tn"], "ULT word change: Text and Words checks gone for every checker; Notes untouched");
  eq(lanesLeft(sqlite, 2), ["tn", "tw"], "UST write: only Text reopens; Words and Notes stay");
  eq(lanesLeft(sqlite, 3), ["text", "tn", "tw"], "a verse the run did not write keeps all its checks");
  const audit = sqlite
    .prepare(`SELECT row_key, payload_json FROM edit_log WHERE source = 'lane_reopen' ORDER BY id`)
    .all();
  eq(
    audit.map((r) => [r.row_key, JSON.parse(r.payload_json).lanes]),
    [
      [`${BOOK}/2/1`, ["text", "tw"]],
      [`${BOOK}/2/2`, ["text"]],
    ],
    "each reopen leaves one lane_reopen audit row",
  );
  eq(
    sent
      .filter((m) => m.type === "lane_check.updated")
      .map((m) => [m.check.verse, m.check.lane, m.check.checkers.length]),
    [
      [1, "text", 0],
      [1, "tw", 0],
      [2, "text", 0],
    ],
    "live tabs get one empty-checker lane_check.updated per reopened (verse, lane)",
  );
}

console.log("\n[AI ULT write that only changes punctuation keeps Words checked]");
{
  const punct = JSON.stringify({
    verseObjects: [w("the"), { type: "text", text: " " }, w("dog"), { type: "text", text: "." }],
  });
  const { sqlite, env } = setup({
    proposals: [{ verse: 1, bibleVersion: "ULT", contentJson: punct, plainText: "the dog." }],
  });
  await run(env);
  eq(lanesLeft(sqlite, 1), ["tn", "tw"], "no `\\w` word changed: only Text reopens");
}

console.log("\n[AI verse write that loses its CAS reopens nothing]");
{
  let raced = false;
  const { sqlite, env, sent } = setup({
    proposals: [{ verse: 1, bibleVersion: "ULT", contentJson: content("the", "cat"), plainText: "the cat" }],
    // A translator's save lands between the AI's SELECT and its guarded UPDATE.
    beforeBatch: (db, stmts) => {
      if (raced || !stmts.some((s) => /UPDATE verses\s+SET content_json/.test(s.sql))) return;
      raced = true;
      db.prepare(
        `UPDATE verses SET version = version + 1, last_change_source = 'user'
          WHERE book = ? AND chapter = 2 AND verse = 1 AND bible_version = 'ULT'`,
      ).run(BOOK);
    },
  });
  const result = await run(env);
  eq(result.applied?.verseSkippedConflict, 1, "sanity: the AI write lost the CAS");
  eq(lanesLeft(sqlite, 1), ["text", "tn", "tw"], "lost CAS: every check stays");
  eq(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE source = 'lane_reopen'`).all()[0].n,
    0,
    "lost CAS: no reopen audit row",
  );
  eq(sent.filter((m) => m.type === "lane_check.updated").length, 0, "lost CAS: no reopen broadcast");
}

console.log("\n[/start gate: a run that writes verse text over checked verses needs confirmCheckedVerses]");
{
  const { sqlite, env } = setup({ proposals: [] });
  // setup() checks off Text on 2:1-3 for two users each → 3 distinct verses.
  sqlite
    .prepare(`INSERT INTO verse_lane_checks (book, chapter, verse, lane, checked_by, checked_at) VALUES (?, 5, 1, 'tn', 1, 100)`)
    .run(BOOK);
  eq(await countCheckedTextVerses(env, BOOK, 2, 2), 3, "counts distinct Text-checked verses, not checker rows");
  eq(await countCheckedTextVerses(env, BOOK, 3, 9), 0, "a Notes check alone does not count");
  eq(
    await checkedVersesConfirmationRequired(env, BOOK, 2, 2, { pipelineType: "generate" }),
    { count: 3 },
    "generate over checked verses without the flag is refused with the count",
  );
  eq(
    await checkedVersesConfirmationRequired(env, BOOK, 2, 2, { pipelineType: "generate", confirmCheckedVerses: true }),
    null,
    "…and allowed once confirmed",
  );
  eq(
    await checkedVersesConfirmationRequired(env, BOOK, 2, 2, {
      pipelineType: "notes",
      followUpChain: [{ pipelineType: "tqs" }],
    }),
    null,
    "notes / questions runs never ask",
  );
  eq(
    await checkedVersesConfirmationRequired(env, BOOK, 2, 2, {
      pipelineType: "notes",
      followUpChain: [{ pipelineType: "generate" }],
    }),
    { count: 3 },
    "a chain with a generate step asks",
  );
  eq(
    await checkedVersesConfirmationRequired(env, BOOK, 3, 4, { pipelineType: "generate" }),
    null,
    "generate over a range with no Text checks starts without asking",
  );
}

if (failed > 0) {
  console.error(`\n${failed} pipelineLaneReopen assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll pipelineLaneReopen assertions passed.");
