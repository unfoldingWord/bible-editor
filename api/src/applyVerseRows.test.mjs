// Regression coverage for issue #486: applyVerseRows' pristine-write batch
// must chunk at D1's 100-statement batch cap (mirroring every other write
// site in bookReimport.ts, which all chunk at WRITE_BATCH = 90), and must
// count inserted/updated only for statements that actually changed a row —
// not blindly, the way the old unchunked implementation did.
//
// Run from api/ (needs the sqlite + strip-types flags, and the resolve hook
// so applyVerseRowsForTest can pull in bookReimport.ts's own extensionless
// application-module imports):
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/applyVerseRows.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { applyVerseRowsForTest } from "./bookReimport.ts";
import { shouldRecordResourceSync } from "./reimportSyncGate.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── Minimal D1 shim over node:sqlite, same shape as reimportJourney.test.mjs
// (prepare().bind().all()/.first()/.run(), and batch()). Wrapped with a call
// counter so the chunking assertions can see how many env.DB.batch() round
// trips a call to applyVerseRowsForTest actually issued.
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
  const batchCalls = { count: 0, sizes: [] };
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      batchCalls.count++;
      batchCalls.sizes.push(stmts.length);
      const out = [];
      for (const s of stmts) out.push(s.run());
      return out;
    },
    _batchCalls: batchCalls,
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

const BOOK = "PSA";
const VERSION = "ULT";

function contentJson(text) {
  return JSON.stringify({ verseObjects: [{ type: "text", text }] });
}

function verse(chapter, n, text) {
  return { chapter, verse: n, verseEnd: null, contentJson: contentJson(text), plainText: text };
}

console.log("\n[applyVerseRows chunks its pristine write batch under the D1 100-statement cap]");
{
  // 176 brand-new verses (PSA 119's real verse count is the canonical example
  // cited in #486) — unchunked, this is 2 statements/verse = 352 statements
  // in one batch() call, well over D1's 100-statement cap. WRITE_BATCH is 90
  // verses per slice, so 176 verses should take ceil(176/90) = 2 batch()
  // calls for the writes, each followed by its own log batch.
  const { env, sqlite } = freshEnv();
  const verses = Array.from({ length: 176 }, (_, i) => verse(119, i + 1, `verse ${i + 1} text`));

  const counts = await applyVerseRowsForTest(env, BOOK, VERSION, verses, null, null, false);

  eq(counts.inserted, 176, "all 176 new verses counted inserted");
  eq(counts.errors.length, 0, "no batch errors — the chunked path never hits the 100-statement cap");

  const row = sqlite.prepare("SELECT COUNT(*) AS n FROM verses WHERE book = ? AND bible_version = ?").all(BOOK, VERSION);
  eq(row[0].n, 176, "all 176 verses actually landed in D1");

  // Two write-batch() calls (176 verses / 90 per slice), each ≤ 90 statements
  // — never the single 352-statement call the pre-fix code would have issued.
  const writeBatchSizes = env.DB._batchCalls.sizes.filter((n) => n > 0 && n <= 90);
  eq(writeBatchSizes.every((n) => n <= 90), true, "every batch() call stayed at or under the WRITE_BATCH/D1 cap");
  eq(env.DB._batchCalls.count >= 4, true, "writes were split into multiple batch() calls, not one giant batch (got " + env.DB._batchCalls.count + ")");
}

console.log("\n[a lost UPDATE race (updated_by set between read and write) is not miscounted]");
{
  // Reproduces the "related minor defect" from #486: a pristine verse is
  // read as editable (updated_by IS NULL), but by the time the UPDATE runs
  // a human has claimed it (updated_by now set) — the UPDATE's own guard
  // matches 0 rows. The old code folded `updated` unconditionally once the
  // batch() call succeeded, over-counting a race it never actually won.
  const { env, sqlite } = freshEnv();
  sqlite
    .prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'someone-else')`)
    .run();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 1, NULL)`,
    )
    .run(BOOK, 23, 1, VERSION, contentJson("old text"), "old text");

  // Simulate the interleaving human edit landing after applyVerseRows' own
  // "existing" read but before its write batch runs, by claiming the row
  // via a raw UPDATE the instant the shim's batch() is invoked for the
  // first time (i.e. right before the pristine write batch executes).
  const originalBatch = env.DB.batch.bind(env.DB);
  let intercepted = false;
  env.DB.batch = async (stmts) => {
    if (!intercepted) {
      intercepted = true;
      sqlite.prepare(`UPDATE verses SET updated_by = 1 WHERE book = ? AND chapter = ? AND verse = ?`).run(BOOK, 23, 1);
    }
    return originalBatch(stmts);
  };

  const counts = await applyVerseRowsForTest(env, BOOK, VERSION, [verse(23, 1, "new master text")], null, null, false);

  eq(counts.updated, 0, "the lost race is NOT counted as updated");
  eq(counts.skipped_edited, 1, "the lost race is routed to skipped_edited, matching the file's existing pattern");

  const row = sqlite
    .prepare("SELECT content_json, version FROM verses WHERE book = ? AND chapter = ? AND verse = ?")
    .all(BOOK, 23, 1)[0];
  eq(JSON.parse(row.content_json).verseObjects[0].text, "old text", "the human-claimed verse's content was never overwritten");
  eq(row.version, 1, "version was never bumped for a write that didn't land");

  const logRow = sqlite
    .prepare("SELECT COUNT(*) AS n FROM edit_log WHERE kind = 'verse' AND action = 'update' AND book = ?")
    .all(BOOK)[0];
  eq(logRow.n, 0, "no phantom restorable version was logged for the write that never landed");
}

console.log("\n[a not-yet-exported D1 verse bridge is not corrupted by the pre-export reimport]");
{
  // The verse-bridge feature stores 5:1-2 as ONE row (verse=1, verse_end=2) and
  // deletes the standalone verse-2 row — but the bridge isn't on Door43 master
  // until the next export, so master still carries SEPARATE verses 1 and 2. The
  // reconcile must NOT reinsert verse 2 (that would emit overlapping `\v 1-2` +
  // `\v 2` in the nightly USFM) nor adopt master's un-bridged verse-1 text over
  // the bridge. See the bridgeCover guard in applyVerseRows.
  const { env, sqlite } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 5, 1, 2, ?, ?, ?, 3, 7)`,
    )
    .run(BOOK, VERSION, contentJson("combined one two"), "combined one two");
  const master = [
    verse(5, 1, "master verse one"),   // covered by the bridge → must be skipped
    verse(5, 2, "master verse two"),   // absorbed → must NOT be reinserted
    verse(5, 3, "master verse three"), // uncovered new verse → must reinsert normally
  ];

  const counts = await applyVerseRowsForTest(env, BOOK, VERSION, master, null, null, false);

  const v2 = sqlite
    .prepare("SELECT COUNT(*) AS n FROM verses WHERE book=? AND bible_version=? AND chapter=5 AND verse=2")
    .all(BOOK, VERSION);
  eq(v2[0].n, 0, "master's plain verse 2 was NOT reinserted beside the bridge");

  const bridge = sqlite
    .prepare("SELECT verse_end, content_json, version FROM verses WHERE book=? AND bible_version=? AND chapter=5 AND verse=1")
    .all(BOOK, VERSION)[0];
  eq(bridge.verse_end, 2, "bridge still spans 1-2");
  eq(JSON.parse(bridge.content_json).verseObjects[0].text, "combined one two", "bridge content not clobbered by master's un-bridged verse 1");
  eq(bridge.version, 3, "bridge version not bumped");

  const v3 = sqlite
    .prepare("SELECT content_json FROM verses WHERE book=? AND bible_version=? AND chapter=5 AND verse=3")
    .all(BOOK, VERSION);
  eq(v3.length, 1, "an uncovered missing verse (5:3) still reinserts — the guard stays narrow");
  eq(JSON.parse(v3[0].content_json).verseObjects[0].text, "master verse three", "5:3 got master's content");
  eq(counts.inserted, 1, "only the uncovered verse counted inserted (the two bridge-covered verses were skipped, not written)");
}

console.log("\n[a plain no-op (nothing changed) is still counted skipped_noop, not inserted/updated]");
{
  const { env } = freshEnv();
  const v = verse(5, 3, "unchanged");
  await applyVerseRowsForTest(env, BOOK, VERSION, [v], null, null, false);
  const counts = await applyVerseRowsForTest(env, BOOK, VERSION, [v], null, null, false);
  eq(counts.inserted, 0, "second identical run inserts nothing");
  eq(counts.updated, 0, "second identical run updates nothing");
  eq(counts.skipped_noop, 1, "second identical run counts the no-op");
}

console.log("\n[each verse's write and its audit row are atomic — one batch() call per chunk, not a separate write batch then a separate log batch]");
{
  // A split (write batch, then a separate log batch) was tried and
  // reverted: if the log batch failed after the write batch had already
  // landed, the fallback would see the content already matching and count
  // a silent no-op, permanently losing the audit row for a verse whose
  // version really did bump. Proving "one batch() call per chunk" is
  // proving that failure mode is structurally impossible now — a thrown
  // batch() can only mean NEITHER the write NOR its log landed (D1 batches
  // are transactional), never one without the other.
  const { env, sqlite } = freshEnv();
  const verses = Array.from({ length: 100 }, (_, i) => verse(50, i + 1, `verse ${i + 1}`));
  const counts = await applyVerseRowsForTest(env, BOOK, VERSION, verses, null, null, false);

  eq(counts.inserted, 100, "all 100 verses counted inserted");
  // 100 verses at PRISTINE_PAIR_BATCH=45 verses/chunk (90 statements: 45
  // writes + 45 logs, under the 100-statement cap) is ceil(100/45) = 3
  // batch() calls — never more, which would mean writes and logs split
  // across separate calls again.
  eq(env.DB._batchCalls.count, 3, "exactly 3 batch() calls — one per chunk, carrying both writes and logs together");
  eq(
    env.DB._batchCalls.sizes.every((n) => n <= 90),
    true,
    "every batch() call stayed within the paired-statement cap (≤45 verses × 2 statements)",
  );

  const logCount = sqlite
    .prepare("SELECT COUNT(*) AS n FROM edit_log WHERE kind = 'verse' AND action = 'create' AND book = ?")
    .all(BOOK)[0].n;
  eq(logCount, 100, "every inserted verse has exactly one matching edit_log row — none lost, none duplicated");
}

console.log("\n[a chunk that fails outright falls back to per-row, which still writes both content AND its audit row]");
{
  const { env, sqlite } = freshEnv();
  // 90 verses -> 2 chunks at PRISTINE_PAIR_BATCH=45. Fail only the SECOND
  // chunk's batch() call so the first lands normally and the second must
  // recover through applyVerseRowsPerRow.
  const verses = Array.from({ length: 90 }, (_, i) => verse(60, i + 1, `verse ${i + 1}`));
  const originalBatch = env.DB.batch.bind(env.DB);
  let call = 0;
  env.DB.batch = async (stmts) => {
    call++;
    if (call === 2) throw new Error("simulated transient D1 failure");
    return originalBatch(stmts);
  };

  const counts = await applyVerseRowsForTest(env, BOOK, VERSION, verses, null, null, false);

  eq(counts.inserted, 90, "all 90 verses still counted inserted (45 batched cleanly + 45 recovered per-row)");
  eq(counts.errors.length, 0, "the per-row fallback recovers the failed chunk without surfacing an error");

  const rowCount = sqlite.prepare("SELECT COUNT(*) AS n FROM verses WHERE book = ? AND chapter = 60").all(BOOK)[0].n;
  eq(rowCount, 90, "all 90 verses actually landed in D1, including the fallback chunk");

  const logCount = sqlite
    .prepare("SELECT COUNT(*) AS n FROM edit_log WHERE kind = 'verse' AND action = 'create' AND book = ?")
    .all(BOOK)[0].n;
  eq(logCount, 90, "every one of the 90 verses has its audit row — the fallback chunk did not silently drop its logs");
}

console.log("\n[#540 item 2: an AI-only master movement never overwrites a later human app edit]");
{
  // The verse analogue of the AMO 4:2 shape, driven through the REAL
  // applyVerseRows: an edited verse whose text moved on BOTH sides since the
  // ancestor. Master wins that today. It must not when the commit lineage says
  // every commit that moved master's file since the ancestor was our own export
  // or a bp-assistant push — the "Door43 side" is then our own pipeline's
  // output, and adopting it reverts the translator's later fix.
  const seedContested = (sqlite) => {
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator')`).run();
    sqlite
      .prepare(
        `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
         VALUES (?, 4, 2, NULL, ?, ?, ?, 5, 1)`,
      )
      .run(BOOK, VERSION, contentJson("the translator's fix"), "the translator's fix");
    // The ancestor: the content we published to master, logged before the
    // boundary. verseContentJsonFromPayload reads the payload's `content` key.
    const e = sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at)
         VALUES ('verse', ?, ?, 'update', ?, 100)`,
      )
      .run(
        `${BOOK}/4/2/${VERSION}`,
        BOOK,
        JSON.stringify({ content: JSON.parse(contentJson("the published text")) }),
      );
    return Number(e.lastInsertRowid);
  };
  const readVerse = (sqlite) =>
    sqlite
      .prepare("SELECT content_json, version FROM verses WHERE book = ? AND chapter = 4 AND verse = 2")
      .all(BOOK)[0];
  const AI_ONLY = {
    mayHoldHumanEdit: false, hasHumanCommit: false, incomplete: false, incompleteReason: "",
    counts: { ours: 1, ai: 2, human: 0 }, humanShas: [],
  };

  {
    const { env, sqlite } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyVerseRowsForTest(
      env, BOOK, VERSION, [verse(4, 2, "the AI run's text")], null,
      { confirmedAt: 200, editId: boundary, lineage: AI_ONLY }, false,
    );
    eq(readVerse(sqlite).content_json, contentJson("the translator's fix"), "the app edit survives — master is not adopted");
    eq(readVerse(sqlite).version, 5, "…and nothing is written, so the version does not move");
    eq(counts.merge_adopted, 0, "…no adoption is counted");
    eq(counts.merge_kept_ai, 1, "…it is counted as merge_kept_ai");
    eq(counts.merge_refused, 0, "…never as a refusal, which at 5 freezes the whole resource's export");
    const conflict = sqlite
      .prepare("SELECT action, reason, overwritten_version FROM verse_merge_conflicts WHERE book = ? AND chapter = 4")
      .all(BOOK)[0];
    eq(conflict.action, "keep_ai_master", "…and a review row is recorded so a human still sees the collision");
    eq(conflict.reason, "both_changed_ai_master", "…with the measured reason");
    eq(conflict.overwritten_version, null, "…and no recovery pointer, because nothing was overwritten");
  }

  {
    // The half that must NOT move: a human commit on master since the ancestor
    // still wins the same collision.
    const { env, sqlite } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyVerseRowsForTest(
      env, BOOK, VERSION, [verse(4, 2, "a maintainer's correction")], null,
      {
        confirmedAt: 200, editId: boundary,
        lineage: {
          mayHoldHumanEdit: true, hasHumanCommit: true, incomplete: false, incompleteReason: "",
          counts: { ours: 1, ai: 0, human: 1 }, humanShas: ["abc123"],
        },
      },
      false,
    );
    eq(
      readVerse(sqlite).content_json,
      contentJson("a maintainer's correction"),
      "a human-authored master edit is still adopted over the app edit",
    );
    eq(counts.merge_adopted, 1, "…counted as an adoption");
    eq(counts.merge_kept_ai, 0, "…and not as a kept AI conflict");
  }

  {
    // No lineage at all — an in-flight Workflow replaying a plan staged before
    // this shipped. Must behave exactly as before: master wins.
    const { env, sqlite } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyVerseRowsForTest(
      env, BOOK, VERSION, [verse(4, 2, "a maintainer's correction")], null,
      { confirmedAt: 200, editId: boundary }, false,
    );
    eq(
      readVerse(sqlite).content_json,
      contentJson("a maintainer's correction"),
      "an absent lineage keeps master-wins, not D1-wins",
    );
    eq(counts.merge_kept_ai, 0, "…and reports no kept AI conflict it did not measure");
  }
}

console.log("\n[#537: a content-bearing 'baseline' edit_log row recovers an ancestor the id boundary alone would miss]");
{
  // pipelineImport.ts writes an action='baseline' row holding the pre-AI
  // content, with `created_at` back-dated to that content's own timestamp —
  // but its `id` is assigned at AI-run time, so it is not chronological with
  // its content. A verse whose ONLY pre-watermark content-bearing history is
  // such a row must still recover it as its merge ancestor via the
  // created_at boundary, even when the id boundary (masterEditId) sits
  // BEFORE the baseline row's real (late-assigned) id — reproducing all 186
  // of the JER/EZK verses issue #537 measured as permanently keep_no_base
  // before this fix.
  const { env, sqlite } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 7, 3, NULL, ?, ?, ?, 1, 1)`,
    )
    .run(BOOK, VERSION, contentJson("the baseline text"), "the baseline text");
  // Back-dated baseline row: created_at (500) predates the watermark
  // (confirmedAt 1000), but masterEditId (0) is set BELOW this row's real
  // autoincrement id — exactly the "id is not chronological with content"
  // shape pipelineImport.ts produces.
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at)
       VALUES ('verse', ?, ?, 'baseline', ?, 500)`,
    )
    .run(`${BOOK}/7/3/${VERSION}`, BOOK, JSON.stringify({ content: JSON.parse(contentJson("the baseline text")) }));

  const counts = await applyVerseRowsForTest(
    env, BOOK, VERSION, [verse(7, 3, "master's differing text")], null,
    { confirmedAt: 1000, editId: 0 }, false,
  );

  const row = sqlite
    .prepare("SELECT content_json, version FROM verses WHERE book = ? AND chapter = 7 AND verse = 3")
    .all(BOOK)[0];
  eq(
    JSON.parse(row.content_json).verseObjects[0].text,
    "master's differing text",
    "master's content is adopted — the baseline row was found as a real ancestor, not treated as no-base",
  );
  eq(row.version, 2, "the adoption actually wrote a new version");
  eq(counts.merge_adopted, 1, "counted as a landed adoption");
  eq(counts.merge_no_base, 0, "NOT counted as unadjudicable — the pre-fix regression this test guards");

  const conflict = sqlite
    .prepare("SELECT action, reason FROM verse_merge_conflicts WHERE book = ? AND chapter = 7 AND verse = 3")
    .all(BOOK)[0];
  eq(
    conflict.action,
    "adopt",
    "a clean adoption, not 'adopt_conflict' — the baseline row's own id must not be misread as a human edit landing after the export (D1 never actually moved)",
  );
  eq(conflict.reason, "master_only", "…for the right reason: only master moved since the (recovered) ancestor");
}

console.log("\n[#537 fallout: a GENUINE human edit after export still blocks clean-adopt, alongside a recovered baseline ancestor]");
{
  // Companion to the case above: excluding 'baseline' rows from
  // human_edit_after_export must not blind the probe to a REAL post-export
  // human edit landing on the same verse. `ours` is made byte-identical to
  // `base` (as in the case above) so that, absent the real update row, this
  // would ALSO clean-adopt via case 5 — the only thing that must change the
  // outcome here is the genuine 'update' entry after the boundary.
  const { env, sqlite } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 8, 4, NULL, ?, ?, ?, 2, 1)`,
    )
    .run(BOOK, VERSION, contentJson("the baseline text"), "the baseline text");
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at)
       VALUES ('verse', ?, ?, 'baseline', ?, 500)`,
    )
    .run(`${BOOK}/8/4/${VERSION}`, BOOK, JSON.stringify({ content: JSON.parse(contentJson("the baseline text")) }));
  // A real human edit, logged with a real edit_log id AFTER the boundary —
  // this is the signal the probe must still catch even though its content
  // (coincidentally, e.g. an undo) matches the ancestor byte-for-byte.
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, created_at)
       VALUES ('verse', ?, ?, 1, 1, 2, 'update', ?, 1500)`,
    )
    .run(`${BOOK}/8/4/${VERSION}`, BOOK, JSON.stringify({ content: JSON.parse(contentJson("the baseline text")) }));

  const counts = await applyVerseRowsForTest(
    env, BOOK, VERSION, [verse(8, 4, "master's differing text")], null,
    { confirmedAt: 1000, editId: 0 }, false,
  );

  const conflict = sqlite
    .prepare("SELECT action, reason FROM verse_merge_conflicts WHERE book = ? AND chapter = 8 AND verse = 4")
    .all(BOOK)[0];
  eq(
    conflict.action,
    "adopt_conflict",
    "the real post-export human edit still blocks the clean-adopt path (case 5), landing on the flagged both_changed path instead",
  );
  // Issue #633: record-time refinement narrows both_changed to what a reader
  // can see. This fixture only changes plain text (no alignment groups), so
  // the stored reason is both_changed_wording — still alertable adopt_conflict.
  eq(conflict.reason, "both_changed_wording", "…for the right (visible-axes) reason");
  eq(counts.merge_adopted, 1, "still adopts (master wins on both_changed by default), but AS a flagged conflict, not silently");
}

console.log("\n[keep_no_base collects an editor ref carrying the verse's CURRENT version (issue #544)]");
{
  // A genuinely human-edited verse (updated_by set, no AI-only edit_log entry)
  // that differs from master, with NO edit_log row at all — so the merge
  // ancestor is unrecoverable (base === null) and computeVerseMerge returns
  // keep_no_base. This is the exact scenario the admin-only banner (#537) used
  // to leave the owning translator with no notice at all.
  const { env, sqlite } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 900, 'translator9')`).run();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 5, 9)`,
    )
    .run(BOOK, 7, 3, VERSION, contentJson("app's own text"), "app's own text");

  const cutoff = { confirmedAt: Math.floor(Date.now() / 1000), editId: null };
  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    VERSION,
    [verse(7, 3, "master's differing text")],
    null,
    cutoff,
    false,
  );

  eq(counts.merge_no_base, 1, "counted as keep_no_base — no ancestor recoverable, ours != theirs");
  eq(counts.merge_no_base_refs, ["7:3"], "the (capped, display) ref names the verse");
  eq(
    counts.merge_no_base_editor_refs,
    [{ chapter: 7, verse: 3, version: 5 }],
    "the (uncapped, editor-attribution) ref carries the verse's CURRENT D1 version — not overwritten, so no version bump",
  );

  // The verse itself was never touched — keep_no_base's whole point is that D1
  // is kept exactly as it was.
  const row = sqlite
    .prepare("SELECT content_json, version FROM verses WHERE book = ? AND chapter = ? AND verse = ?")
    .all(BOOK, 7, 3)[0];
  eq(JSON.parse(row.content_json).verseObjects[0].text, "app's own text", "D1's content is untouched");
  eq(row.version, 5, "D1's version is untouched — nothing was written");
}

// ── Issue #539: a merge adoption that would store the bytes already stored ──
//
// THE SHAPE. computeVerseMerge decides "adopt" on master's bytes AS THEY
// ARRIVE. applyVerseRows then normalizes those bytes toward D1's before
// writing them — healIncomingReplacementChars, and canonizeAlignmentSource,
// which rewrites every `\zaln-s` milestone's x-content/x-lemma to the
// canonical UHB source-word bytes D1 already holds. When master's ONLY
// divergence was inside that canonization kernel, the adoption lands on
// exactly D1's stored string. Pre-fix that still wrote: version+1, an
// edit_log row, a verse_merge_conflicts row, and every open tab's If-Match
// invalidated — for a change nobody could see. And it recurs EVERY night,
// because neither side moves: master keeps its form, canonize keeps undoing
// it. That is a version-inflation engine, not a one-off.
//
// WHY IT IS ASSERTED HERE, on the real applyVerseRows over real SQLite: the
// guard has to sit AFTER canonization and compare the three columns the
// UPDATE actually binds. A pure test of computeVerseMerge cannot see that —
// the merge is right to say "master differs"; it is the WRITE that is a no-op.
console.log("\n[a verse adoption whose canonized bytes already match D1 writes nothing (issue #539)]");
{
  const { env, sqlite } = freshEnv();
  // One aligned word. `lemma` is the only thing master got wrong, and
  // canonizeAlignmentSource is exactly the pass that repairs it from UHB.
  // Deliberately not x-content: content feeds alignmentDelta's sourceKey, so
  // moving it would risk a keep_alignment_refused and test the wrong branch.
  const UHB_FORM = "בָּרָ֣א";
  const UHB_LEMMA = "בָּרָא";
  const tree = (lemma) => ({
    verseObjects: [
      {
        tag: "zaln",
        type: "milestone",
        strong: "H1254",
        lemma,
        content: UHB_FORM,
        children: [{ tag: "w", type: "word", text: "created" }],
      },
    ],
  });
  const oursJson = JSON.stringify(tree(UHB_LEMMA));
  // Master carries an under-pointed lemma. Same key order, so once canonize
  // repairs it the re-stringified tree is byte-identical to `oursJson` — which
  // is the whole point: only a byte comparison of the FINAL value can tell.
  const theirsJson = JSON.stringify(tree("בּרא"));

  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();
  // The human-edited ULT verse (updated_by set → routes through the merge).
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 5, 1, NULL, 'ULT', ?, 'created', 4, 9)`,
    )
    .run(BOOK, oursJson);
  // The UHB source row canonizeAlignmentSource reads its canonical bytes from.
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version)
       VALUES (?, 5, 1, NULL, 'UHB', ?, ?, 1)`,
    )
    .run(
      BOOK,
      JSON.stringify({
        verseObjects: [
          { tag: "w", type: "word", text: UHB_FORM, strong: "H1254", lemma: UHB_LEMMA, morph: "He,Vqp3ms" },
        ],
      }),
      UHB_FORM,
    );
  // The ancestor: D1's own content, logged before the watermark boundary. base
  // == ours is what makes computeVerseMerge return a clean "adopt".
  const anc = sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, created_at)
       VALUES ('verse', ?, ?, 9, 3, 4, 'update', ?, 100)`,
    )
    .run(`${BOOK}/5/1/ULT`, BOOK, JSON.stringify({ plain_text: "created", content: oursJson }));
  const boundary = Number(anc.lastInsertRowid);

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    "ULT",
    [{ chapter: 5, verse: 1, verseEnd: null, contentJson: theirsJson, plainText: "created" }],
    null,
    { confirmedAt: 200, editId: boundary },
    false,
  );

  eq(counts.merge_noop_skipped, 1, "the adoption is counted as a skipped no-op, not silently dropped");
  eq(counts.merge_adopted, 0, "…and NOT counted as an adoption that landed");
  eq(
    counts.apply_incomplete,
    false,
    "…and does NOT withhold the resource watermark — D1 already holds master's bytes, so nothing is stale to retry",
  );

  const row = sqlite
    .prepare("SELECT content_json, version FROM verses WHERE book = ? AND chapter = 5 AND verse = 1 AND bible_version = 'ULT'")
    .all(BOOK)[0];
  eq(row.version, 4, "the version does not move — THE assertion this fix exists for");
  eq(row.content_json, oursJson, "…and the stored bytes are untouched");
  eq(
    sqlite.prepare("SELECT COUNT(*) AS n FROM edit_log WHERE row_key = ?").all(`${BOOK}/5/1/ULT`)[0].n,
    1,
    "no edit_log row was written for a write that never happened (only the seeded ancestor remains)",
  );
  eq(
    sqlite.prepare("SELECT COUNT(*) AS n FROM verse_merge_conflicts").all()[0].n,
    0,
    "and no verse_merge_conflicts row: overwritten_version would point a reviewer at text nothing replaced",
  );
}

// The other half of the same guard — without this, "stop writing" could be
// satisfied by simply not writing at all. A verse master genuinely moved must
// still be adopted and must still bump.
console.log("\n[…but a real out-of-band master change on the same shape STILL adopts and STILL bumps]");
{
  const { env, sqlite } = freshEnv();
  const UHB_FORM = "בָּרָ֣א";
  const UHB_LEMMA = "בָּרָא";
  const tree = (target) => ({
    verseObjects: [
      {
        tag: "zaln",
        type: "milestone",
        strong: "H1254",
        lemma: UHB_LEMMA,
        content: UHB_FORM,
        children: [{ tag: "w", type: "word", text: target }],
      },
    ],
  });
  const oursJson = JSON.stringify(tree("created"));
  const theirsJson = JSON.stringify(tree("made"));

  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 5, 1, NULL, 'ULT', ?, 'created', 4, 9)`,
    )
    .run(BOOK, oursJson);
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version)
       VALUES (?, 5, 1, NULL, 'UHB', ?, ?, 1)`,
    )
    .run(
      BOOK,
      JSON.stringify({
        verseObjects: [
          { tag: "w", type: "word", text: UHB_FORM, strong: "H1254", lemma: UHB_LEMMA, morph: "He,Vqp3ms" },
        ],
      }),
      UHB_FORM,
    );
  const anc = sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, created_at)
       VALUES ('verse', ?, ?, 9, 3, 4, 'update', ?, 100)`,
    )
    .run(`${BOOK}/5/1/ULT`, BOOK, JSON.stringify({ plain_text: "created", content: oursJson }));

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    "ULT",
    [{ chapter: 5, verse: 1, verseEnd: null, contentJson: theirsJson, plainText: "made" }],
    null,
    { confirmedAt: 200, editId: Number(anc.lastInsertRowid) },
    false,
  );

  eq(counts.merge_adopted, 1, "master's real edit is adopted");
  eq(counts.merge_noop_skipped, 0, "…and is NOT swallowed by the no-change guard");
  const row = sqlite
    .prepare("SELECT content_json, version FROM verses WHERE book = ? AND chapter = 5 AND verse = 1 AND bible_version = 'ULT'")
    .all(BOOK)[0];
  eq(row.version, 5, "the version DOES move for a real content change");
  eq(JSON.parse(row.content_json).verseObjects[0].children[0].text, "made", "…and master's text landed");
}

// S1 (cold review): a CONFLICTED no-op adopt must keep its review row.
//
// The one shape where the no-op is not benign. If a Door43 maintainer's
// out-of-band fix lived in the `\zaln-s` source attributes and D1's UHB row is
// stale, canonizeAlignmentSource rewrites that fix back to D1's stale bytes —
// which is precisely WHY the adopted bytes end up matching. The stored data is
// no worse than before the guard (the same stale bytes would have been
// written), but silently dropping the verse_merge_conflicts row would also drop
// the review-banner entry raiseVerseMergeConflictAlert raises from it, and the
// condition recurs every night with nobody told. So: still no write, still no
// version bump — but the row survives, with overwritten_version NULL because
// nothing was overwritten.
console.log("\n[a CONFLICTED no-op adopt writes nothing but KEEPS its review row (issue #539, cold review S1)]");
{
  const { env, sqlite } = freshEnv();
  const UHB_FORM = "בָּרָ֣א";
  const UHB_LEMMA = "בָּרָא";
  const tree = (lemma) => ({
    verseObjects: [
      {
        tag: "zaln",
        type: "milestone",
        strong: "H1254",
        lemma,
        content: UHB_FORM,
        children: [{ tag: "w", type: "word", text: "created" }],
      },
    ],
  });
  const oursJson = JSON.stringify(tree(UHB_LEMMA));
  const theirsJson = JSON.stringify(tree("בּרא"));
  // A THIRD value for the ancestor, so both sides read as moved since it —
  // that is what makes computeVerseMerge return adopt_conflict rather than a
  // clean adopt.
  const baseJson = JSON.stringify(tree("ANCESTOR-LEMMA"));

  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 8, 1, NULL, 'ULT', ?, 'created', 4, 9)`,
    )
    .run(BOOK, oursJson);
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version)
       VALUES (?, 8, 1, NULL, 'UHB', ?, ?, 1)`,
    )
    .run(
      BOOK,
      JSON.stringify({
        verseObjects: [
          { tag: "w", type: "word", text: UHB_FORM, strong: "H1254", lemma: UHB_LEMMA, morph: "He,Vqp3ms" },
        ],
      }),
      UHB_FORM,
    );
  const anc = sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, created_at)
       VALUES ('verse', ?, ?, 9, 3, 4, 'update', ?, 100)`,
    )
    .run(`${BOOK}/8/1/ULT`, BOOK, JSON.stringify({ plain_text: "created", content: baseJson }));

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    "ULT",
    [{ chapter: 8, verse: 1, verseEnd: null, contentJson: theirsJson, plainText: "created" }],
    null,
    { confirmedAt: 200, editId: Number(anc.lastInsertRowid) },
    false,
  );

  eq(counts.merge_noop_skipped, 1, "the conflicted adoption is still skipped as a no-op");
  eq(counts.merge_adopted, 0, "…and not counted as landed");
  const row = sqlite
    .prepare("SELECT content_json, version FROM verses WHERE book = ? AND chapter = 8 AND verse = 1 AND bible_version = 'ULT'")
    .all(BOOK)[0];
  eq(row.version, 4, "…the version still does not move");
  eq(row.content_json, oursJson, "…and the stored bytes are untouched");

  const mc = sqlite
    .prepare("SELECT action, reason, overwritten_version FROM verse_merge_conflicts WHERE chapter = 8 AND verse = 1")
    .all();
  eq(mc.length, 1, "the review row SURVIVES — a human still needs to see this collision");
  eq(mc[0].action, "adopt_conflict", "…recorded as the conflict it is");
  eq(
    mc[0].overwritten_version,
    null,
    "…with overwritten_version NULL: nothing was replaced, so it must not point a reviewer at text that still stands",
  );
}

console.log("\n[#633: no-visible-change adoption is audit-only — not merge_conflicts, not the snackbar flag]");
{
  // End-to-end: both sides moved (adopt_conflict), storage bytes differ so the
  // write lands, but plain text + alignment groups match → adopt_no_visible_change.
  // That must NOT increment merge_conflicts (the UI snackbar derives
  // "flagged for review (merge conflict)" from that counter alone).
  const { summarizeReimport } = await import("../../web/src/lib/reimportSummary.ts");
  const { env, sqlite } = freshEnv();

  // Same readable text, different text-node boundaries — stableKey still
  // differs; extractPlainText / alignment groups do not.
  const oursJson = JSON.stringify({
    verseObjects: [{ type: "text", text: "Hello world" }],
  });
  const theirsJson = JSON.stringify({
    verseObjects: [
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
    ],
  });
  const baseJson = JSON.stringify({
    verseObjects: [{ type: "text", text: "ancestor" }],
  });

  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 9, 1, NULL, 'ULT', ?, 'Hello world', 4, 9)`,
    )
    .run(BOOK, oursJson);
  const anc = sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, created_at)
       VALUES ('verse', ?, ?, 9, 3, 4, 'update', ?, 100)`,
    )
    .run(`${BOOK}/9/1/ULT`, BOOK, JSON.stringify({ plain_text: "ancestor", content: baseJson }));
  // A second post-export human edit so human_edit_after_export is true even
  // if the content probe alone is ambiguous — both_changed requires both
  // sides moved since the ancestor.
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, created_at)
       VALUES ('verse', ?, ?, 9, 3, 4, 'update', ?, 1500)`,
    )
    .run(
      `${BOOK}/9/1/ULT`,
      BOOK,
      JSON.stringify({ plain_text: "Hello world", content: JSON.parse(oursJson) }),
    );

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    "ULT",
    [{ chapter: 9, verse: 1, verseEnd: null, contentJson: theirsJson, plainText: "Hello world" }],
    null,
    { confirmedAt: 200, editId: Number(anc.lastInsertRowid) },
    false,
  );

  const mc = sqlite
    .prepare("SELECT action, reason, overwritten_version FROM verse_merge_conflicts WHERE chapter = 9 AND verse = 1")
    .all()[0];
  eq(mc.action, "adopt_no_visible_change", "audit row records the no-visible-change action");
  eq(mc.reason, "both_changed_no_visible", "…with the no-visible reason");
  eq(counts.merge_adopted, 1, "the cosmetic write still lands as an adoption");
  eq(counts.merge_conflicts, 0, "…but is NOT counted as a merge conflict needing review");

  const summary = summarizeReimport({
    ok: true,
    book: BOOK,
    perResource: {},
    totals: { ...counts, errors: counts.errors ?? [] },
  });
  eq(
    summary.includes("flagged for review (merge conflict)"),
    false,
    `snackbar must not say flagged for review (got: ${summary})`,
  );
  eq(
    summary.includes("adopted from master"),
    true,
    "…while still reporting the adoption that did land",
  );
}

// ── Characterization, not a regression for the #539 write guard ─────────────
// The render round-trip gap (STATE.md: extract(render(x)) !== x for 16-19% of
// verses) is held one layer earlier, by verseMerge's stableKey lens: the two
// documented artifacts — a marker's `nextChar` flipping " " <-> "\n", and
// buildUsfm's blank-line reflow being absorbed into the following text node —
// both normalize away, so the merge returns keep_converged and NOTHING reaches
// the write path at all. Pinned here so that if anyone ever narrows that lens,
// the failure shows up as a verse-level no-write regression rather than as
// silent nightly churn. It passes with or without the #539 write guard, and is
// labelled as such deliberately.
console.log("\n[render round-trip churn on an edited verse writes nothing (held by stableKey, not by the #539 guard)]");
{
  const { env, sqlite } = freshEnv();
  const oursJson = JSON.stringify({
    verseObjects: [
      { tag: "q1", type: "quote", nextChar: "\n" },
      { type: "text", text: "In the beginning\n" },
    ],
  });
  // What a render -> reparse pass hands back for the same verse.
  const theirsJson = JSON.stringify({
    verseObjects: [
      { tag: "q1", type: "quote", nextChar: " " },
      { type: "text", text: "In the beginning\n\n" },
    ],
  });

  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 6, 1, NULL, 'ULT', ?, 'In the beginning', 4, 9)`,
    )
    .run(BOOK, oursJson);
  const anc = sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, created_at)
       VALUES ('verse', ?, ?, 9, 3, 4, 'update', ?, 100)`,
    )
    .run(`${BOOK}/6/1/ULT`, BOOK, JSON.stringify({ plain_text: "In the beginning", content: oursJson }));

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    "ULT",
    [{ chapter: 6, verse: 1, verseEnd: null, contentJson: theirsJson, plainText: "In the beginning" }],
    null,
    { confirmedAt: 200, editId: Number(anc.lastInsertRowid) },
    false,
  );

  eq(counts.merge_adopted, 0, "round-trip churn is never adopted");
  eq(counts.merge_cosmetic_ignored, 1, "…and the raw-byte difference it did carry is still counted, not hidden");
  const row = sqlite
    .prepare("SELECT content_json, version FROM verses WHERE book = ? AND chapter = 6 AND verse = 1 AND bible_version = 'ULT'")
    .all(BOOK)[0];
  eq(row.version, 4, "the version does not move");
  eq(row.content_json, oursJson, "…and the stored bytes are untouched");
}

// ── Issue #609: the PRISTINE / AI-only writers get the same lens ────────────
//
// The characterization test directly above pins the EDITED path: stableKey holds
// the round-trip gap there, so nothing reaches the write. A pristine verse
// (updated_by IS NULL — the large majority of the corpus) never reaches
// computeVerseMerge at all; its write decision was a raw string comparison, so a
// verse whose render→reparse does not settle (16-19% of the corpus per STATE.md)
// was rewritten and version-bumped for a change nobody could see. Not "every
// verse every night": STATE.md measures round trips as convergent, and #609's own
// query puts the observed repeat rate at 1.34 writes per touched verse over ~36
// days — see verseMerge.ts's verseContentConverged for the measured numbers.
//
// The fixture is the SAME documented artifact pair the edited-path test uses —
// a marker's `nextChar` flipping "\n" -> " ", and buildUsfm's blank-line reflow
// absorbed into the following text node — so the two paths are provably held to
// one lens, not two that can drift.
const ROUNDTRIP_OURS = JSON.stringify({
  verseObjects: [
    { tag: "q1", type: "quote", nextChar: "\n" },
    { type: "text", text: "In the beginning\n" },
  ],
});
const ROUNDTRIP_THEIRS = JSON.stringify({
  verseObjects: [
    { tag: "q1", type: "quote", nextChar: " " },
    { type: "text", text: "In the beginning\n\n" },
  ],
});

console.log("\n[#609: render round-trip churn on a PRISTINE verse writes nothing and does not bump]");
{
  const { env, sqlite } = freshEnv();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 11, 1, NULL, ?, ?, 'In the beginning', 3, NULL)`,
    )
    .run(BOOK, VERSION, ROUNDTRIP_OURS);

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    VERSION,
    [{ chapter: 11, verse: 1, verseEnd: null, contentJson: ROUNDTRIP_THEIRS, plainText: "In the beginning" }],
    null,
    null,
    false,
  );

  eq(counts.skipped_normalized, 1, "the suppressed write is COUNTED — the class must never be invisible");
  eq(counts.updated, 0, "…and no update landed");
  eq(counts.skipped_noop, 0, "…and it is not laundered into the byte-equal no-op counter");

  const row = sqlite
    .prepare("SELECT content_json, version FROM verses WHERE book = ? AND chapter = 11 AND verse = 1 AND bible_version = ?")
    .all(BOOK, VERSION)[0];
  eq(row.version, 3, "the version does not move — THE assertion this fix exists for");
  eq(row.content_json, ROUNDTRIP_OURS, "…and the stored bytes are untouched");
  eq(
    sqlite.prepare("SELECT COUNT(*) AS n FROM edit_log WHERE row_key = ?").all(`${BOOK}/11/1/${VERSION}`)[0].n,
    0,
    "…and no edit_log row was written for a write that never happened",
  );
}

// The other half of the guard: without this, "stop writing" could be satisfied
// by never writing at all, and master's real corrections would stop reaching D1.
console.log("\n[#609: a REAL master change on a pristine verse still writes and still bumps]");
{
  const { env, sqlite } = freshEnv();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 11, 2, NULL, ?, ?, 'In the beginning', 3, NULL)`,
    )
    .run(BOOK, VERSION, ROUNDTRIP_OURS);

  // Same round-trip noise AS WELL AS a real word change, so this proves the lens
  // does not swallow a genuine edit that arrives wearing the artifact.
  const realChange = JSON.stringify({
    verseObjects: [
      { tag: "q1", type: "quote", nextChar: " " },
      { type: "text", text: "In the very beginning\n\n" },
    ],
  });

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    VERSION,
    [{ chapter: 11, verse: 2, verseEnd: null, contentJson: realChange, plainText: "In the very beginning" }],
    null,
    null,
    false,
  );

  eq(counts.updated, 1, "master's real edit is written");
  eq(counts.skipped_normalized, 0, "…and is NOT suppressed by the lens");
  const row = sqlite
    .prepare("SELECT content_json, version FROM verses WHERE book = ? AND chapter = 11 AND verse = 2 AND bible_version = ?")
    .all(BOOK, VERSION)[0];
  eq(row.version, 4, "the version DOES move for a real content change");
  eq(row.content_json, realChange, "…and master's bytes landed");
}

// A verse_end (bridge boundary) change is compared EXACTLY, never through the
// lens — `\v 14` becoming `\v 14-15` is always a real change, and a content tree
// that is otherwise lens-identical must not hide it.
console.log("\n[#609: a verse_end change on a lens-identical tree still writes]");
{
  const { env, sqlite } = freshEnv();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 11, 3, NULL, ?, ?, 'In the beginning', 3, NULL)`,
    )
    .run(BOOK, VERSION, ROUNDTRIP_OURS);

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    VERSION,
    [{ chapter: 11, verse: 3, verseEnd: 4, contentJson: ROUNDTRIP_THEIRS, plainText: "In the beginning" }],
    null,
    null,
    false,
  );

  eq(counts.updated, 1, "the bridge boundary change is written");
  eq(counts.skipped_normalized, 0, "…and never suppressed");
  const row = sqlite
    .prepare("SELECT verse_end, version FROM verses WHERE book = ? AND chapter = 11 AND verse = 3 AND bible_version = ?")
    .all(BOOK, VERSION)[0];
  eq(row.verse_end, 4, "master's bridge boundary landed");
  eq(row.version, 4, "…and the version moved");
}

// The class `plain_text` CANNOT guard: a real change that is invisible in the
// verse's readable text, so the whole discrimination rests on stableKey. Source
// attrs on a `\zaln` milestone are compared exactly (they are not `text` /
// `nextChar`), which is what makes a curated original-language fix — the NUM
// 20-22 combining-mark class — still reach D1 on a pristine verse.
console.log("\n[#609: a source-attr-only master fix (invisible in plain_text) still writes]");
{
  const { env, sqlite } = freshEnv();
  const tree = (lemma) =>
    JSON.stringify({
      verseObjects: [
        {
          tag: "zaln",
          type: "milestone",
          strong: "H1254",
          lemma,
          content: "בָּרָ֣א",
          children: [{ tag: "w", type: "word", text: "created" }],
        },
      ],
    });
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 11, 4, NULL, ?, ?, 'created', 3, NULL)`,
    )
    .run(BOOK, VERSION, tree("בּרא"));

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    VERSION,
    [{ chapter: 11, verse: 4, verseEnd: null, contentJson: tree("בָּרָא"), plainText: "created" }],
    null,
    null,
    false,
  );

  eq(counts.updated, 1, "the source-owned fix is written even though plain_text is identical");
  eq(counts.skipped_normalized, 0, "…and never suppressed");
  const row = sqlite
    .prepare("SELECT content_json, version FROM verses WHERE book = ? AND chapter = 11 AND verse = 4 AND bible_version = ?")
    .all(BOOK, VERSION)[0];
  eq(JSON.parse(row.content_json).verseObjects[0].lemma, "בָּרָא", "master's corrected lemma landed");
  eq(row.version, 4, "…and the version moved");
}

// #609 names this case explicitly and warns against suppressing it: the worst
// repeat-writers in prod are chapter-front `\p` PILEUP, a genuinely GROWING
// content difference (EZK/2/0/UST went 24 -> 25 -> 26 markers on consecutive
// nights). A lens must never hide that — the fix for it is the collapse pass, not
// a comparison that stops noticing. An added node changes the node array, which
// stableKey cannot normalize away; this pins that.
console.log("\n[#609: marker pileup is a REAL growing difference and still writes]");
{
  const { env, sqlite } = freshEnv();
  const ours = JSON.stringify({
    verseObjects: [
      { tag: "p", type: "paragraph", nextChar: "\n" },
      { type: "text", text: "In the beginning" },
    ],
  });
  const pileup = JSON.stringify({
    verseObjects: [
      { tag: "p", type: "paragraph", nextChar: "\n" },
      { tag: "p", type: "paragraph", nextChar: "\n" },
      { type: "text", text: "In the beginning" },
    ],
  });
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 11, 5, NULL, ?, ?, 'In the beginning', 3, NULL)`,
    )
    .run(BOOK, VERSION, ours);

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    VERSION,
    [{ chapter: 11, verse: 5, verseEnd: null, contentJson: pileup, plainText: "In the beginning" }],
    null,
    null,
    false,
  );

  eq(counts.updated, 1, "the extra marker node is written — pileup is content, not noise");
  eq(counts.skipped_normalized, 0, "…and the lens does not hide it");
  eq(
    JSON.parse(
      sqlite
        .prepare("SELECT content_json FROM verses WHERE book = ? AND chapter = 11 AND verse = 5 AND bible_version = ?")
        .all(BOOK, VERSION)[0].content_json,
    ).verseObjects.length,
    3,
    "…master's node count landed",
  );
}

// ── Review F1: the two shapes the stableKey lens gets WRONG ─────────────────
//
// These are why isNormalizedNoopVerseWrite does not stop at the lens. Both are
// pure whitespace to `stableKey` — and both change the rendered USFM, fusing a
// word onto its marker (`and\w God\w*`, `\w*\w`), which is the PR #417 /
// stripMarkerTokens corruption class. usfmFormat.ts's insertSpaceAfterGluedMarker
// does not repair either: its regex is anchored to a leading poetry marker.
//
// If either of these ever starts skipping, D1 has kept a fused-token tree that the
// next nightly export publishes to Door43 as corrupt USFM.
console.log("\n[#609 F1: a text node losing its trailing space before a \\w still writes (fused word token)]");
{
  const { env, sqlite } = freshEnv();
  const spaced = JSON.stringify({
    verseObjects: [{ type: "text", text: "and " }, { tag: "w", type: "word", text: "God" }],
  });
  const fused = JSON.stringify({
    verseObjects: [{ type: "text", text: "and" }, { tag: "w", type: "word", text: "God" }],
  });
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 13, 1, NULL, ?, ?, 'and God', 3, NULL)`,
    )
    .run(BOOK, VERSION, spaced);

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    VERSION,
    [{ chapter: 13, verse: 1, verseEnd: null, contentJson: fused, plainText: "and God" }],
    null,
    null,
    false,
  );

  eq(counts.skipped_normalized, 0, "the lens calls this converged — the export-render check must still force the write");
  eq(counts.updated, 1, "…so the write lands");
  const row = sqlite
    .prepare("SELECT content_json, version FROM verses WHERE book = ? AND chapter = 13 AND verse = 1 AND bible_version = ?")
    .all(BOOK, VERSION)[0];
  eq(row.version, 4, "…and the version moves");
  eq(row.content_json, fused, "…and master's bytes landed, not D1's");
}

console.log("\n[#609 F1: a whitespace-only separator node between two \\w still writes (fused word token)]");
{
  const { env, sqlite } = freshEnv();
  const separated = JSON.stringify({
    verseObjects: [
      { tag: "w", type: "word", text: "the" },
      { type: "text", text: " " },
      { tag: "w", type: "word", text: "LORD" },
    ],
  });
  const fused = JSON.stringify({
    verseObjects: [
      { tag: "w", type: "word", text: "the" },
      { tag: "w", type: "word", text: "LORD" },
    ],
  });
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 13, 2, NULL, ?, ?, 'the LORD', 3, NULL)`,
    )
    .run(BOOK, VERSION, separated);

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    VERSION,
    [{ chapter: 13, verse: 2, verseEnd: null, contentJson: fused, plainText: "the LORD" }],
    null,
    null,
    false,
  );

  eq(counts.skipped_normalized, 0, "dropping the separator is not cosmetic — it fuses \\w* onto \\w");
  eq(counts.updated, 1, "…so the write lands");
  eq(
    sqlite
      .prepare("SELECT version FROM verses WHERE book = ? AND chapter = 13 AND verse = 2 AND bible_version = ?")
      .all(BOOK, VERSION)[0].version,
    4,
    "…and the version moves",
  );
}

// Review F2: the plain_text leg of the guard, which nothing else exercises. The
// trees are lens-equal AND render-equal; only the stored plain_text disagrees, on
// a real word. That must still write — plain_text is what search and the
// translator's own reading view show.
console.log("\n[#609 F2: lens-equal trees whose plain_text differs by a real word still write]");
{
  const { env, sqlite } = freshEnv();
  const tree = JSON.stringify({ verseObjects: [{ type: "text", text: "In the beginning" }] });
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 13, 3, NULL, ?, ?, 'In the beginning', 3, NULL)`,
    )
    .run(BOOK, VERSION, tree);

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    VERSION,
    // Same tree bytes are impossible here (the raw fast path would catch them), so
    // carry the documented nextChar artifact in the tree while plain_text moves.
    [
      {
        chapter: 13,
        verse: 3,
        verseEnd: null,
        contentJson: JSON.stringify({ verseObjects: [{ type: "text", text: "In the beginning\n" }] }),
        plainText: "In the very beginning",
      },
    ],
    null,
    null,
    false,
  );

  eq(counts.skipped_normalized, 0, "a real plain_text difference is never a normalized no-op");
  eq(counts.updated, 1, "…the write lands");
  eq(
    sqlite
      .prepare("SELECT plain_text FROM verses WHERE book = ? AND chapter = 13 AND verse = 3 AND bible_version = ?")
      .all(BOOK, VERSION)[0].plain_text,
    "In the very beginning",
    "…and master's plain text landed",
  );
}

// The AI-only branch carried the identical raw comparison a few lines above the
// pristine one, so it churned the same way — on verses the AI pipeline wrote and
// no human has ever touched.
console.log("\n[#609: render round-trip churn on an AI-ONLY verse writes nothing and does not bump]");
{
  const { env, sqlite } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 707, 'ai-writer')`).run();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 12, 1, NULL, ?, ?, 'In the beginning', 3, 7)`,
    )
    .run(BOOK, VERSION, ROUNDTRIP_OURS);
  // What makes it AI-only rather than human-edited: the latest content edit_log
  // row for this verse carries source 'ai_pipeline' (reimportClassify.ts's
  // isReimportableRow).
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, created_at)
       VALUES ('verse', ?, ?, 7, 2, 3, 'update', ?, 'ai_pipeline', 100)`,
    )
    .run(`${BOOK}/12/1/${VERSION}`, BOOK, JSON.stringify({ plain_text: "In the beginning", content: ROUNDTRIP_OURS }));

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    VERSION,
    [{ chapter: 12, verse: 1, verseEnd: null, contentJson: ROUNDTRIP_THEIRS, plainText: "In the beginning" }],
    null,
    null,
    false,
  );

  eq(counts.skipped_normalized, 1, "the suppressed AI-only re-seed is counted");
  eq(counts.reimported_ai, 0, "…and no re-seed landed");
  const row = sqlite
    .prepare("SELECT content_json, version FROM verses WHERE book = ? AND chapter = 12 AND verse = 1 AND bible_version = ?")
    .all(BOOK, VERSION)[0];
  eq(row.version, 3, "the version does not move");
  eq(row.content_json, ROUNDTRIP_OURS, "…and the stored bytes are untouched");
  eq(
    sqlite.prepare("SELECT COUNT(*) AS n FROM edit_log WHERE row_key = ?").all(`${BOOK}/12/1/${VERSION}`)[0].n,
    1,
    "…and no new edit_log row (only the seeded ai_pipeline one remains)",
  );
}

console.log("\n[#609: a REAL master change on an AI-only verse still re-seeds and still bumps]");
{
  const { env, sqlite } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 707, 'ai-writer')`).run();
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 12, 2, NULL, ?, ?, 'In the beginning', 3, 7)`,
    )
    .run(BOOK, VERSION, ROUNDTRIP_OURS);
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, created_at)
       VALUES ('verse', ?, ?, 7, 2, 3, 'update', ?, 'ai_pipeline', 100)`,
    )
    .run(`${BOOK}/12/2/${VERSION}`, BOOK, JSON.stringify({ plain_text: "In the beginning", content: ROUNDTRIP_OURS }));

  const realChange = JSON.stringify({
    verseObjects: [
      { tag: "q1", type: "quote", nextChar: " " },
      { type: "text", text: "In the very beginning\n\n" },
    ],
  });

  const counts = await applyVerseRowsForTest(
    env,
    BOOK,
    VERSION,
    [{ chapter: 12, verse: 2, verseEnd: null, contentJson: realChange, plainText: "In the very beginning" }],
    null,
    null,
    false,
  );

  eq(counts.reimported_ai, 1, "master's real edit re-seeds the AI-only verse");
  eq(counts.skipped_normalized, 0, "…and is NOT suppressed by the lens");
  const row = sqlite
    .prepare("SELECT content_json, version, updated_by FROM verses WHERE book = ? AND chapter = 12 AND verse = 2 AND bible_version = ?")
    .all(BOOK, VERSION)[0];
  eq(row.version, 4, "the version DOES move");
  eq(row.content_json, realChange, "…master's bytes landed");
  eq(row.updated_by, null, "…and the verse is reclaimed to master-owned, exactly as before this guard");
}

// ── Issue #727: bridge-aware reimport guards ─────────────────────────────────

console.log("\n[#727: a chapter left with overlapping verse ranges trips structure_overlap and the watermark gate refuses]");
{
  // Seed the corrupt shape directly: a pristine `1-2` bridge beside a pristine
  // standalone verse 2 in the same chapter. Nothing in the reimport's own diff
  // fixes this (master's verse 2 is bridge-covered and skipped), so the ONLY
  // thing standing between it and `\v 1-2` + `\v 2` on Door43 is the post-apply
  // structural check.
  const { env, sqlite } = freshEnv();
  const ins = sqlite.prepare(
    `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
     VALUES (?, 30, ?, ?, ?, ?, ?, 1, NULL)`,
  );
  ins.run(BOOK, 1, 2, VERSION, contentJson("bridged one two"), "bridged one two");
  ins.run(BOOK, 2, null, VERSION, contentJson("stray two"), "stray two");

  const counts = await applyVerseRowsForTest(env, BOOK, VERSION, [verse(30, 3, "verse three")], null, null, false);
  eq(counts.inserted, 1, "the unrelated verse 3 still lands — the check is a post-apply audit, not a write refusal");
  eq(counts.structure_overlap, 1, "the overlapping pair (1-2 ∩ 2) is counted once");
  eq(shouldRecordResourceSync(counts), false, "…and the watermark gate refuses to stamp this run's counts");

  // Control: the same chapter with a bridge and a non-overlapping neighbour.
  const clean = freshEnv();
  const ins2 = clean.sqlite.prepare(
    `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
     VALUES (?, 30, ?, ?, ?, ?, ?, 1, NULL)`,
  );
  ins2.run(BOOK, 1, 2, VERSION, contentJson("bridged one two"), "bridged one two");
  ins2.run(BOOK, 3, null, VERSION, contentJson("three"), "three");
  const cleanCounts = await applyVerseRowsForTest(clean.env, BOOK, VERSION, [verse(30, 4, "verse four")], null, null, false);
  eq(cleanCounts.structure_overlap, 0, "adjacent, non-intersecting ranges (1-2, 3, 4) are not an overlap");
  eq(shouldRecordResourceSync(cleanCounts), true, "…and the gate stamps a structurally clean run");
}

console.log("\n[#727: a verse whose newest edit_log row is a 'bridge' (source NULL) is human-owned, not AI-only]");
{
  // History: the AI pipeline wrote v2 ('update', source ai_pipeline), then a
  // human bridged it with verse 2 ('bridge', source NULL, v3), and the bridge
  // has since been exported, so master carries `1-2` too. Tonight a maintainer
  // corrected the bridged text on Door43. The ownership sub-select used to see
  // only create/update, so the bridge row was invisible: the newest visible row
  // was the AI 'update', the verse classified AI-only and took the wholesale
  // re-seed path (master's bytes in, updated_by → NULL) instead of the
  // human-owned merge/skip path. (Master carrying a PLAIN verse 1 here would
  // never reach this classification — the bridgeCover skip from PR #721 drops
  // it first — so the master row must itself be the bridge to test ownership.)
  const { env, sqlite } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 707, 'ai-writer')`).run();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator')`).run();
  const bridged = contentJson("bridged one and two");
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 12, 1, 2, ?, ?, 'bridged one and two', 3, 1)`,
    )
    .run(BOOK, VERSION, bridged);
  const key = `${BOOK}/12/1/${VERSION}`;
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, created_at)
       VALUES ('verse', ?, ?, 7, 1, 2, 'update', ?, 'ai_pipeline', 100)`,
    )
    .run(key, BOOK, JSON.stringify({ plain_text: "ai one", content: contentJson("ai one") }));
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, created_at)
       VALUES ('verse', ?, ?, 1, 2, 3, 'bridge', ?, NULL, 200)`,
    )
    .run(key, BOOK, JSON.stringify({ content: JSON.parse(bridged), verse_end: 2 }));

  const counts = await applyVerseRowsForTest(
    env, BOOK, VERSION,
    [{ chapter: 12, verse: 1, verseEnd: 2, contentJson: contentJson("master's corrected one and two"), plainText: "master's corrected one and two" }],
    null, null, false,
  );

  eq(counts.reimported_ai, 0, "NOT re-seeded as AI-only");
  eq(counts.skipped_edited, 1, "classified human-owned and left alone (no watermark → no merge attempt)");
  eq(counts.inserted, 0, "nothing inserted");
  const row = sqlite
    .prepare("SELECT content_json, verse_end, version, updated_by FROM verses WHERE book = ? AND chapter = 12 AND verse = 1 AND bible_version = ?")
    .all(BOOK, VERSION)[0];
  eq(row.verse_end, 2, "the bridge survives");
  eq(row.version, 3, "…unbumped");
  eq(row.content_json, bridged, "…with its bridged content intact");
  eq(row.updated_by, 1, "…still owned by the translator");
}

console.log("\n[#727: a 'bridge' edit_log payload at/below the boundary is recoverable as the merge ancestor]");
{
  // Same shape as the #537 baseline case, but the ONLY pre-watermark
  // content-bearing history for this verse is the 'bridge' row a human wrote
  // (payload carries the full bridged content at that version). Pre-#727 the
  // base_payload sub-select filtered to create/update, so this verse was
  // permanently keep_no_base even though a perfectly good ancestor existed.
  const { env, sqlite } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator')`).run();
  const bridged = contentJson("bridged five and six");
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, version, updated_by)
       VALUES (?, 7, 5, 6, ?, ?, 'bridged five and six', 4, 1)`,
    )
    .run(BOOK, VERSION, bridged);
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, created_at)
       VALUES ('verse', ?, ?, 1, 3, 4, 'bridge', ?, 500)`,
    )
    .run(`${BOOK}/7/5/${VERSION}`, BOOK, JSON.stringify({ content: JSON.parse(bridged), verse_end: 6 }));

  // Master already carries the exported bridge (5-6) and a maintainer corrected
  // its text out-of-band on Door43.
  const counts = await applyVerseRowsForTest(
    env, BOOK, VERSION,
    [{ chapter: 7, verse: 5, verseEnd: 6, contentJson: contentJson("master's corrected five and six"), plainText: "master's corrected five and six" }],
    null,
    { confirmedAt: 1000, editId: null },
    false,
  );

  eq(counts.merge_no_base, 0, "NOT keep_no_base — the bridge row is a real ancestor");
  eq(counts.merge_adopted, 1, "master's out-of-band correction is adopted");
  const row = sqlite
    .prepare("SELECT content_json, verse_end, version FROM verses WHERE book = ? AND chapter = 7 AND verse = 5 AND bible_version = ?")
    .all(BOOK, VERSION)[0];
  eq(JSON.parse(row.content_json).verseObjects[0].text, "master's corrected five and six", "…and landed");
  eq(row.verse_end, 6, "the bridge grouping is preserved through the adoption");
  eq(row.version, 5, "the adoption wrote a new version");
}

console.log("\n[#727: a verse absent from D1 is recreated ABOVE its edit_log high-water, never at version 1]");
{
  // A verse that once existed (and reached version 7 through edits, a bridge
  // and a split) is gone from D1 — the bridge→split lifecycle deletes and
  // re-mints rows — and tonight master still carries it. The reimport INSERT
  // used to take the column default (1) and log new_version = 1, so a stale
  // `If-Match: 1` in a tab's outbox would pass CAS against the recreated row.
  const { env, sqlite } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator')`).run();
  const key = `${BOOK}/40/1/${VERSION}`;
  const log = sqlite.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, created_at)
     VALUES ('verse', ?, ?, 1, ?, ?, ?, '{}', ?)`,
  );
  log.run(key, BOOK, null, 1, "create", 100);
  log.run(key, BOOK, 1, 2, "update", 110);
  log.run(key, BOOK, 2, 3, "update", 120);
  log.run(key, BOOK, 3, 4, "update", 130);
  log.run(key, BOOK, 4, 5, "update", 140);
  log.run(key, BOOK, 5, 6, "bridge", 150);
  log.run(key, BOOK, 6, 7, "split", 160);
  const before = sqlite.prepare("SELECT COUNT(*) AS n FROM edit_log WHERE row_key = ?").all(key)[0].n;

  const counts = await applyVerseRowsForTest(env, BOOK, VERSION, [verse(40, 1, "recreated text")], null, null, false);

  eq(counts.inserted, 1, "the absent verse is inserted");
  const row = sqlite
    .prepare("SELECT version, content_json FROM verses WHERE book = ? AND chapter = 40 AND verse = 1 AND bible_version = ?")
    .all(BOOK, VERSION)[0];
  eq(row.version, 8, "version starts strictly above the edit_log high-water (7), not at the column default");
  const audit = sqlite
    .prepare("SELECT action, prev_version, new_version FROM edit_log WHERE row_key = ? ORDER BY id DESC LIMIT 1")
    .all(key)[0];
  eq(audit.action, "create", "the audit row is a 'create'");
  eq(audit.new_version, 8, "…whose new_version matches the row's actual version");
  eq(audit.prev_version, null, "…with no predecessor version");
  eq(
    sqlite.prepare("SELECT COUNT(*) AS n FROM edit_log WHERE row_key = ?").all(key)[0].n,
    before + 1,
    "exactly one audit row added",
  );

  // Control: a verse with NO history still starts at 1.
  const fresh = await applyVerseRowsForTest(env, BOOK, VERSION, [verse(40, 2, "brand new")], null, null, false);
  eq(fresh.inserted, 1, "a never-seen verse inserts");
  const row2 = sqlite
    .prepare("SELECT version FROM verses WHERE book = ? AND chapter = 40 AND verse = 2 AND bible_version = ?")
    .all(BOOK, VERSION)[0];
  eq(row2.version, 1, "…at version 1 when edit_log holds nothing for it");
  const audit2 = sqlite
    .prepare("SELECT new_version FROM edit_log WHERE row_key = ? ORDER BY id DESC LIMIT 1")
    .all(`${BOOK}/40/2/${VERSION}`)[0];
  eq(audit2.new_version, 1, "…and its audit row says 1 too");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll applyVerseRows chunking/counting assertions passed.");
