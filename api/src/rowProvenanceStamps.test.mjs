// Issue #686 — the row-level provenance columns (`last_change_action`,
// `last_change_source`, `last_change_actor`, migration 0060) are stamped at
// ~45 write sites, all reusing the small vocabulary and bind-order helpers in
// rowProvenance.ts (see rowProvenance.test.mjs, which pins the pure attribution
// rule — `door43Actor` never naming a person the run's lineage did not
// measure — and the bind-order helpers). This file is the OTHER half: proof
// that the stamps actually land when the real write paths run, against the
// real migrated schema.
//
// Two kinds of assertion, and every one below is labelled so the strength of
// the evidence is legible at a glance:
//
//   BEHAVIOURAL — drives the real exported function against a real, migrated
//   node:sqlite database and reads the stamped columns back. Possible for
//   every write site that does not transitively `import { Hono } from "hono"`
//   (rows.ts, verses.ts and bookImport.ts all do, and api/src/*.test.mjs runs
//   under plain `node --experimental-strip-types`, which cannot resolve hono
//   from node_modules — STATE.md, "A module that imports hono cannot be
//   unit-tested"). Drivable here: bookReimport.ts (applyTsvRows,
//   softDeleteRemovedTsvRowsForTest), pipelineImport.ts (importJobOutput),
//   twlSortOrderApply.ts (applyTwlSortOrderUpdates), and
//   verseMergeConflictSql.ts's exported SQL constant (verses.ts's PATCH route
//   itself is not drivable, but the exact statement it runs is a shared
//   constant already proven against real SQLite the same way
//   verseMergeConflicts.test.mjs does).
//
//   [source] — rows.ts / bookImport.ts / index.ts cannot be driven at all
//   (the hono import), so these assert against the SOURCE TEXT of the
//   statement: the provenance columns are referenced, and (for the reorder
//   fast path) `version = version + 1` is absent. This proves the code is
//   wired to write the columns; it does NOT prove the write lands correctly
//   at runtime — that gap is real and stated here rather than dressed up as
//   behavioural coverage.
//
// Run from api/ (needs the sqlite + strip-types flags, and the resolve hook
// for extensionless .ts imports):
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/rowProvenanceStamps.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { applyTsvRows, softDeleteRemovedTsvRowsForTest } from "./bookReimport.ts";
import { VERSE_PATCH_UPDATE_SQL } from "./verseMergeConflictSql.ts";
import { applyTwlSortOrderUpdates } from "./twlSortOrderApply.ts";
import { importJobOutput } from "./pipelineImport.ts";
import { door43Actor, DOOR43_ACTOR_AI_PUSH, DOOR43_ACTOR_UNMEASURED } from "./rowProvenance.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── Minimal D1 shim over node:sqlite, mirrors reimportJourney.test.mjs /
// applyVerseRows.test.mjs's pattern exactly (prepare().bind().all()/.first()/
// .run(), and batch()). ─────────────────────────────────────────────────────
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
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
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

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  const db = makeDb(sqlite);
  return { sqlite, db, env: { DB: db } };
}

const BOOK = "JER";

// ═════════════════════════════════════════════════════════════════════════
// BEHAVIOURAL
// ═════════════════════════════════════════════════════════════════════════

console.log("\n[BEHAVIOURAL 1: verses.ts's PATCH route — VERSE_PATCH_UPDATE_SQL stamps user + username]");
{
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (5, 500, 'benjamin')`).run();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version)
       VALUES (?, 1, 1, NULL, 'ULT', ?, 'In the beginning', 1)`,
    )
    .run(BOOK, JSON.stringify({ verseObjects: [{ type: "text", text: "In the beginning" }] }));

  // Bind order (verseMergeConflictSql.ts's own doc comment): contentJson,
  // plainText, updatedAt, updatedBy, lastChangeAction, lastChangeSource,
  // lastChangeActor, book, chapter, verse, bibleVersion, expectedVersion.
  await env.DB.prepare(VERSE_PATCH_UPDATE_SQL)
    .bind(
      JSON.stringify({ verseObjects: [{ type: "text", text: "In the beginning, God" }] }),
      "In the beginning, God",
      2000,
      5,
      "update",
      "user",
      "benjamin",
      BOOK,
      1,
      1,
      "ULT",
      1,
    )
    .run();

  const row = sqlite
    .prepare(
      `SELECT version, last_change_action, last_change_source, last_change_actor
         FROM verses WHERE book = ? AND chapter = 1 AND verse = 1 AND bible_version = 'ULT'`,
    )
    .all(BOOK)[0];
  eq(row.last_change_action, "update", "user PATCH stamps last_change_action='update'");
  eq(row.last_change_source, "user", "…and last_change_source='user'");
  eq(row.last_change_actor, "benjamin", "…and last_change_actor is the saving username");
  eq(row.version, 2, "…and the version bump is unaffected by the added columns");
}

console.log("\n[BEHAVIOURAL 2: AI pipeline apply (importJobOutput -> applyTnInsert) stamps the pipeline, and updated_by stays the STARTER's id]");
{
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator9')`).run();
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs
         (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state)
       VALUES ('job-tn-1', 1, 'notes', ?, 1, 1, 'sess-1', 'running')`,
    )
    .run(BOOK);

  const tsvText =
    "ID\tReference\tTags\tSupportReference\tQuote\tOccurrence\tNote\n" +
    "aaaa\t1:1\t\t\t\t\tThis is the AI's proposed note.\n";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => tsvText });
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tn-1", pipelineType: "notes", book: BOOK, startChapter: 1, endChapter: 1 },
      [{ repo: "unfoldingWord/en_tn", rawUrl: "https://example.invalid/en_tn.tsv" }],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  eq(result.applied?.tnCreated, 1, "sanity: the AI note actually landed as a new tn_rows insert");

  const row = sqlite
    .prepare(
      `SELECT updated_by, last_change_action, last_change_source, last_change_actor
         FROM tn_rows WHERE book = ? AND id = 'aaaa'`,
    )
    .all(BOOK)[0];
  eq(row.last_change_action, "ai_apply", "AI insert stamps last_change_action='ai_apply'");
  eq(row.last_change_source, "ai_pipeline", "…and last_change_source='ai_pipeline'");
  eq(
    row.last_change_actor,
    "AI pipeline (run by translator9)",
    "…and last_change_actor names the pipeline AND the human who started it",
  );
  eq(
    row.updated_by,
    1,
    "…while updated_by STILL holds the starter's numeric id — the row no longer lies about who WROTE it, " +
      "but who STARTED it stays exactly where it always was",
  );
}

console.log("\n[BEHAVIOURAL 3: reimport adopt with a MEASURED human lineage stamps the Door43 author]");
{
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 700, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, updated_by, version)
       VALUES ('aaaa', ?, 3, 5, '3:5', 'old question', 'old response', 10, 7, 3)`,
    )
    .run(BOOK);
  // Ancestor: the row D1 published last, logged before the merge boundary.
  const anc = sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at)
       VALUES ('tq', 'aaaa', ?, 'create', ?, 100)`,
    )
    .run(BOOK, JSON.stringify({ chapter: 3, verse: 5, ref_raw: "3:5", question: "old question", response: "old response" }));

  const HUMAN_LINEAGE = {
    mayHoldHumanEdit: true,
    hasHumanCommit: true,
    incomplete: false,
    incompleteReason: "",
    counts: { ours: 0, ai: 0, human: 1 },
    humanShas: ["deadbeef"],
    humanCommits: [{ sha: "deadbeef", author: "Stephen Wunrow", date: "2026-08-14T09:12:00-05:00" }],
  };
  const masterRow = {
    id: "aaaa", idCoerced: false, refRaw: "3:5", chapter: 3, verse: 5,
    occurrence: null, tags: null, quote: null,
    question: "old question", response: "master's corrected response",
  };
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow], null, {
    confirmedAt: 200,
    editId: Number(anc.lastInsertRowid),
    lineage: HUMAN_LINEAGE,
  });
  eq(counts.merge_adopted, 1, "sanity: master's real content change is adopted");

  const row = sqlite
    .prepare(`SELECT last_change_action, last_change_source, last_change_actor FROM tq_rows WHERE book = ? AND id = 'aaaa'`)
    .all(BOOK)[0];
  const EXPECTED_ACTOR = `Door43: ⁨Stephen Wunrow⁩`; // built from the same isolate chars door43Actor uses, not pasted invisibly
  eq(row.last_change_actor, EXPECTED_ACTOR, "adoption with a measured human commit stamps 'Door43: <name>' (bidi-isolated)");
  eq(row.last_change_action, "sync_merge", "…action is sync_merge");
  eq(row.last_change_source, "dcs_sync", "…source is dcs_sync");
}

console.log("\n[BEHAVIOURAL 4: reimport adopt with an AI-ONLY lineage stamps the bot-push wording]");
{
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 700, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, updated_by, version)
       VALUES ('bbbb', ?, 4, 2, '4:2', 'old question', 'old response', 10, 7, 3)`,
    )
    .run(BOOK);
  const anc = sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at)
       VALUES ('tq', 'bbbb', ?, 'create', ?, 100)`,
    )
    .run(BOOK, JSON.stringify({ chapter: 4, verse: 2, ref_raw: "4:2", question: "old question", response: "old response" }));

  const AI_ONLY_LINEAGE = {
    mayHoldHumanEdit: false,
    hasHumanCommit: false,
    incomplete: false,
    incompleteReason: "",
    counts: { ours: 1, ai: 2, human: 0 },
    humanShas: [],
  };
  const masterRow = {
    id: "bbbb", idCoerced: false, refRaw: "4:2", chapter: 4, verse: 2,
    occurrence: null, tags: null, quote: null,
    question: "old question", response: "the pipeline's run's response",
  };
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow], null, {
    confirmedAt: 200,
    editId: Number(anc.lastInsertRowid),
    lineage: AI_ONLY_LINEAGE,
  });
  eq(counts.merge_adopted, 1, "sanity: master's content change is adopted (no human touched D1)");

  const row = sqlite
    .prepare(`SELECT last_change_actor FROM tq_rows WHERE book = ? AND id = 'bbbb'`)
    .all(BOOK)[0];
  eq(row.last_change_actor, door43Actor(AI_ONLY_LINEAGE), "sanity: matches the pure door43Actor computation");
  eq(row.last_change_actor, DOOR43_ACTOR_AI_PUSH, "a COMPLETE walk with no human commit stamps 'Door43 (AI/bot push)'");
}

console.log("\n[BEHAVIOURAL 4b: an INCOMPLETE lineage names nobody, even END-TO-END, even holding a name]");
{
  // WHY THIS CASE EXISTS. Cases 3 and 4 prove the stamp carries whatever
  // door43Actor computed; rowProvenance.test.mjs proves door43Actor refuses to
  // name an unmeasured author. Neither proved the two together: when the
  // measurement guard was ablated (2026-09-01, both ways — dropping the
  // `incomplete !== false` check, and inventing a name from `humanShas` on a
  // pre-#684 summary) the whole of this file still passed, because no case here
  // fed the write path a lineage that COULD tempt it. That is the shape of an
  // integration suite that certifies a guard it never exercises.
  //
  // So: an incomplete walk that DID capture a named human commit. The name is
  // right there in the object the write path is handed, and the row must still
  // come out "Door43 sync" — an unfinished walk has not established that this
  // commit is the one that last moved the file, and the repo rule is that a
  // label states only measured causes.
  const { sqlite, env } = freshEnv();
  // A PRISTINE row (updated_by NULL — master owns it), so the sync overwrites
  // it outright rather than going through the three-way merge. That keeps this
  // case about attribution and nothing else.
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, updated_by, version)
       VALUES ('cccc', ?, 5, 9, '5:9', 'old question', 'old response', 10, NULL, 3)`,
    )
    .run(BOOK);

  const INCOMPLETE_BUT_NAMED_LINEAGE = {
    mayHoldHumanEdit: true,
    // The fail-safe pairing this asserts against: an incomplete walk reports
    // hasHumanCommit true AND carries an identity, and is still not quotable.
    hasHumanCommit: true,
    incomplete: true,
    incompleteReason: "paging cap reached before source_sha",
    counts: { ours: 0, ai: 0, human: 1 },
    humanShas: ["deadbeef"],
    humanCommits: [{ sha: "deadbeef", author: "Stephen Wunrow", date: "2026-08-14T09:12:00-05:00" }],
  };
  const masterRow = {
    id: "cccc", idCoerced: false, refRaw: "5:9", chapter: 5, verse: 9,
    occurrence: null, tags: null, quote: null,
    question: "old question", response: "master's newer response",
  };
  await applyTsvRows(env, BOOK, "tq", [masterRow], null, {
    confirmedAt: 200,
    editId: null,
    lineage: INCOMPLETE_BUT_NAMED_LINEAGE,
  });

  const row = sqlite
    .prepare(`SELECT response, last_change_action, last_change_source, last_change_actor FROM tq_rows WHERE book = ? AND id = 'cccc'`)
    .all(BOOK)[0];
  eq(row.response, "master's newer response", "sanity: the pristine row DID take master's value (so a stamp was written)");
  eq(row.last_change_source, "dcs_sync", "…source is dcs_sync");
  eq(
    row.last_change_actor,
    DOOR43_ACTOR_UNMEASURED,
    "an INCOMPLETE walk stamps 'Door43 sync' even though it was handed a named human commit",
  );
  eq(
    row.last_change_actor.includes("Stephen Wunrow"),
    false,
    "…and the name it was handed appears NOWHERE in the stamp",
  );
}

console.log("\n[BEHAVIOURAL 4c: a pre-#684 lineage snapshot names nobody END-TO-END]");
{
  // The second half of 4b's lesson. `book_resource_syncs.master_lineage_json`
  // is last-run-wins and every summary persisted before #684 carries
  // `humanShas` with NO identity: something moved master, and this record
  // cannot say who. A reader that reaches for the shas would be inventing an
  // author out of a field that was never populated — so the walk being
  // COMPLETE and the human commit being REAL still buys no name here.
  const { sqlite, env } = freshEnv();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, updated_by, version)
       VALUES ('dddd', ?, 6, 1, '6:1', 'old question', 'old response', 10, NULL, 3)`,
    )
    .run(BOOK);

  const PRE_684_LINEAGE = {
    mayHoldHumanEdit: true,
    hasHumanCommit: true,
    incomplete: false,
    incompleteReason: "",
    counts: { ours: 0, ai: 0, human: 2 },
    humanShas: ["deadbeef", "cafef00d"],
    // humanCommits deliberately ABSENT — this is the pre-#684 shape.
  };
  const masterRow = {
    id: "dddd", idCoerced: false, refRaw: "6:1", chapter: 6, verse: 1,
    occurrence: null, tags: null, quote: null,
    question: "old question", response: "master's newer response",
  };
  await applyTsvRows(env, BOOK, "tq", [masterRow], null, {
    confirmedAt: 200,
    editId: null,
    lineage: PRE_684_LINEAGE,
  });

  const row = sqlite
    .prepare(`SELECT response, last_change_source, last_change_actor FROM tq_rows WHERE book = ? AND id = 'dddd'`)
    .all(BOOK)[0];
  eq(row.response, "master's newer response", "sanity: the pristine row DID take master's value (so a stamp was written)");
  eq(row.last_change_source, "dcs_sync", "…source is dcs_sync");
  eq(
    row.last_change_actor,
    DOOR43_ACTOR_UNMEASURED,
    "a pre-#684 snapshot (shas, no identities) stamps 'Door43 sync' and names no author",
  );
}

console.log("\n[BEHAVIOURAL 5: softDeleteRemovedTsvRows (prune) stamps sync_prune / dcs_sync / 'Door43 sync']");
{
  const { sqlite, env } = freshEnv();
  // A pristine tn row master's file no longer carries — the prune candidate.
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order)
       VALUES ('cccc', ?, 6, 1, '6:1', NULL, NULL, NULL, NULL, 'a note master deleted', 1)`,
    )
    .run(BOOK);
  // Master's file still needs at least one row for the prune's "empty file"
  // guard not to trip, and it must be a DIFFERENT id so 'cccc' reads as removed.
  const raw = "ID\tReference\tTags\tSupportReference\tQuote\tOccurrence\tNote\ndddd\t6:2\t\t\t\t\tstill on master\n";

  const result = await softDeleteRemovedTsvRowsForTest(env, BOOK, "tn", raw, [6], false);
  eq(result.deleted, 1, "sanity: the removed row was actually pruned");

  const row = sqlite
    .prepare(`SELECT last_change_action, last_change_source, last_change_actor FROM tn_rows WHERE book = ? AND id = 'cccc'`)
    .all(BOOK)[0];
  eq(row.last_change_action, "sync_prune", "prune stamps last_change_action='sync_prune'");
  eq(row.last_change_source, "dcs_sync", "…source is dcs_sync");
  eq(row.last_change_actor, "Door43 sync", "…actor is the plain 'Door43 sync' — no lineage is in scope here by design");
}

console.log("\n[BEHAVIOURAL 6: a row nobody has touched since migration 0060 shipped keeps all three columns NULL]");
{
  const { sqlite } = freshEnv();
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order)
       VALUES ('eeee', ?, 1, 1, '1:1', NULL, NULL, NULL, NULL, 'an untouched note', 1)`,
    )
    .run(BOOK);
  const row = sqlite
    .prepare(`SELECT last_change_action, last_change_source, last_change_actor FROM tn_rows WHERE book = ? AND id = 'eeee'`)
    .all(BOOK)[0];
  eq(row.last_change_action, null, "an untouched row's last_change_action is NULL");
  eq(row.last_change_source, null, "…last_change_source is NULL");
  eq(row.last_change_actor, null, "…last_change_actor is NULL — 'no change since 0060 shipped'");
}

console.log("\n[BEHAVIOURAL 7: applyTwlSortOrderUpdates stamps its CALLER's provenance, not a hardcoded one, and still bumps version]");
{
  const { sqlite, env } = freshEnv();
  sqlite
    .prepare(
      `INSERT INTO twl_rows (id, book, chapter, verse, ref_raw, orig_words, occurrence, tw_link, sort_order, version)
       VALUES ('ffff', ?, 2, 1, '2:1', NULL, 1, 'rc://*/tw/dict/bible/kt/god', 999, 3)`,
    )
    .run(BOOK);
  // 7a. Default provenance (no explicit `provenance` arg) — the nightly export /
  // reimport canonical post-pass caller.
  await applyTwlSortOrderUpdates(env.DB, BOOK, [{ id: "ffff", sort_order: 100 }]);
  {
    const row = sqlite
      .prepare(
        `SELECT sort_order, version, last_change_action, last_change_source, last_change_actor
           FROM twl_rows WHERE book = ? AND id = 'ffff'`,
      )
      .all(BOOK)[0];
    eq(row.sort_order, 100, "sort_order actually landed");
    eq(row.version, 4, "…and version bumped exactly once (unchanged existing behavior — issue #687's separate question)");
    eq(row.last_change_action, "sync_reorder", "default provenance: action='sync_reorder'");
    eq(row.last_change_source, "dcs_sync", "…source='dcs_sync'");
    eq(row.last_change_actor, "Door43 sync", "…actor='Door43 sync'");
  }

  // 7b. Explicit user provenance — chapters.ts's interactive order-lock dismiss.
  await applyTwlSortOrderUpdates(env.DB, BOOK, [{ id: "ffff", sort_order: 200 }], {
    action: "reorder",
    source: "user",
    actor: "benjamin",
  });
  {
    const row = sqlite
      .prepare(
        `SELECT sort_order, version, last_change_action, last_change_source, last_change_actor
           FROM twl_rows WHERE book = ? AND id = 'ffff'`,
      )
      .all(BOOK)[0];
    eq(row.sort_order, 200, "…second update also landed");
    eq(row.version, 5, "…and bumped again");
    eq(row.last_change_action, "reorder", "an explicitly-passed caller provenance overrides the default: action='reorder'");
    eq(row.last_change_source, "user", "…source='user'");
    eq(row.last_change_actor, "benjamin", "…actor is the caller's own username, not the hardcoded 'Door43 sync'");
  }
}

// ═════════════════════════════════════════════════════════════════════════
// [source] — NOT independently drivable (hono import chain). Asserts the
// SOURCE TEXT of the statement, not runtime behaviour. See the file header.
// ═════════════════════════════════════════════════════════════════════════

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)));
const rowsTs = readFileSync(join(SRC_DIR, "rows.ts"), "utf8");
const bookImportTs = readFileSync(join(SRC_DIR, "bookImport.ts"), "utf8");
const indexTs = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
const bookReimportTs = readFileSync(join(SRC_DIR, "bookReimport.ts"), "utf8");

console.log("\n[source] rows.ts sort_order-only reorder fast path");
{
  // Isolate the fast-path UPDATE (`SET sort_order = ?1, updated_at = ?2,
  // ${provenanceSet(3)} ... WHERE id = ?6 AND version = ?7`) by its distinctive
  // shape: a SET clause naming ONLY sort_order/updated_at/provenance, no other
  // content column and no version bump in the SET list.
  const idx = rowsTs.indexOf("SET sort_order = ?1, updated_at = ?2, ${provenanceSet(3)}");
  eq(idx >= 0, true, "[source] the sort_order-only reorder fast path's UPDATE text was found verbatim");
  const stmtEnd = rowsTs.indexOf("`", idx);
  const stmt = rowsTs.slice(Math.max(0, idx - 20), stmtEnd);
  eq(stmt.includes("provenanceSet(3)"), true, "[source] reorder fast path references provenanceSet(...)");
  eq(stmt.includes("version = version + 1"), false, "[source] reorder fast path does NOT bump version");
}

console.log("\n[source] rows.ts create/PATCH/delete/dismiss-review/trash paths all reference the provenance columns");
{
  const sites = [
    ['create (INSERT_COLS + PROVENANCE_COLUMNS + provenanceValues({ action: "create" ...))', /PROVENANCE_COLUMNS\]/, /action:\s*"create"/],
    ["PATCH content update", /provenanceSet\(baseParams \+ 4\)/, /action:\s*"update"/],
    ["delete (soft delete)", /provenanceSet\(6\)/, /action:\s*"delete"/],
    ["dismiss-review", /provenanceSet\(nextParam\)/, /action:\s*"dismiss_review"/],
    ["trash / untrash", /provenanceSet\(3\)/, /action:\s*"trash"/],
  ];
  for (const [label, colRe, actionRe] of sites) {
    eq(colRe.test(rowsTs), true, `[source] rows.ts ${label}: provenance columns referenced`);
    eq(actionRe.test(rowsTs), true, `[source] rows.ts ${label}: its action string is present`);
  }
}

console.log("\n[source] bookImport.ts's four whole-book INSERTs (verses, tn, tq, twl) reference the provenance columns");
{
  const inserts = [
    ["INSERT INTO verses", /INSERT INTO verses[\s\S]{0,300}PROVENANCE_COLUMNS\.join/],
    ["INSERT INTO tn_rows", /INSERT INTO tn_rows[\s\S]{0,300}PROVENANCE_COLUMNS\.join/],
    ["INSERT INTO tq_rows", /INSERT INTO tq_rows[\s\S]{0,300}PROVENANCE_COLUMNS\.join/],
    ["INSERT INTO twl_rows", /INSERT INTO twl_rows[\s\S]{0,300}PROVENANCE_COLUMNS\.join/],
  ];
  for (const [label, re] of inserts) {
    eq(re.test(bookImportTs), true, `[source] bookImport.ts ${label} references PROVENANCE_COLUMNS`);
  }
  eq(
    /provenanceValues\(\{ action: "import", source: "import", actor \}\)/.test(bookImportTs),
    true,
    "[source] bookImport.ts's bootstrap import stamps action='import' / source='import'",
  );
}

console.log("\n[source] index.ts's nightly trash finalize stamps finalize_trash / system / 'nightly trash finalize'");
{
  eq(
    /last_change_action = 'finalize_trash'/.test(indexTs),
    true,
    "[source] index.ts finalize-trash UPDATE sets last_change_action='finalize_trash'",
  );
  eq(
    /last_change_source = 'system'/.test(indexTs),
    true,
    "[source] …last_change_source='system'",
  );
  eq(
    /last_change_actor = 'nightly trash finalize'/.test(indexTs),
    true,
    "[source] …last_change_actor='nightly trash finalize'",
  );
}

console.log("\n[source] no updated_by write was changed by #686 (tripwire, not a spec)");
{
  // bookReimport.ts's pristine-update guards must still read `updated_by IS
  // NULL` — #686 added provenance columns to these same statements but must
  // not have touched who is allowed to write over what.
  eq(
    /updated_by IS NULL/.test(bookReimportTs),
    true,
    "[source] bookReimport.ts still contains its 'updated_by IS NULL' pristine guard(s)",
  );
  const rowsUpdatedByCount = (rowsTs.match(/updated_by/g) ?? []).length;
  const reimportUpdatedByCount = (bookReimportTs.match(/updated_by/g) ?? []).length;
  eq(rowsUpdatedByCount > 0, true, "[source] rows.ts still references updated_by somewhere (tripwire, not a spec)");
  eq(reimportUpdatedByCount > 0, true, "[source] bookReimport.ts still references updated_by somewhere (tripwire, not a spec)");
}

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nall rowProvenanceStamps assertions passed");
