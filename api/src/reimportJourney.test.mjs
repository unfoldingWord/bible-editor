// End-to-end journey for issue #427's option-2 instrumentation, against the
// REAL production schema (every file in api/migrations, applied in order) and
// the REAL functions — not hand-copied SQL.
//
// Run from api/ (needs the sqlite flag):
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/reimportJourney.test.mjs
//
// WHY THIS EXISTS, and why the earlier test was not enough. tombstoneCollision
// .test.mjs proves SQLite's behavior by re-typing applyTsvRows' two statements
// into the test. That proves nothing if the real SQL later drifts — and the
// single most drift-sensitive line in this whole fix is the `existing` read's
// deliberate ABSENCE of a `deleted_at IS NULL` filter. If someone "tidies" that
// filter in, a tombstoned id stops reaching the tombstone branch, the counter
// silently stops firing, and every test that re-types the SQL still passes.
// So this file drives the real applyTsvRows and the real gate.
//
// What the journey covers:
//   (a) the drop is COUNTED   — real applyTsvRows over a real tombstone
//   (b) the watermark is WITHHELD, and the withhold is visible in the STORED
//       book_resource_syncs row (not merely in a return value), including that
//       the taint survives the addCounts aggregation step
//   (c) the banner is QUERYABLE from system_alerts, where the UI reads it
//   (d) the HEALTHY path still stamps origin='reimport' — no false withhold

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyTsvRows,
  recordResourceSync,
  recordWithheldSyncIfAbsent,
} from "./bookReimport.ts";
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

// ── Minimal D1 shim over node:sqlite ───────────────────────────────────────
// Mirrors the slice of the D1 API bookReimport.ts uses: prepare().bind().all()
// / .first() / .run(), and batch(). `.run()` returns D1's `{ meta: { changes } }`
// shape, which is the exact signal the conflict counter reads.
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
  return { sqlite, env: { DB: makeDb(sqlite) } };
}

const BOOK = "1CH";
// The real id from the incident: minted for a 1CH 5:4 question, hand-deleted
// 2026-07-30, then reissued by bp-assistant for 1CH 23:7.
const ID = "hoig";

function seedTombstone(sqlite, { id = ID, ref = "5:4", chapter = 5, verse = 4 } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, BOOK, chapter, verse, ref, "old question", "old response", 10, 1753900000);
}

// Shaped exactly like parseTsvRow's output for a tq row.
function masterRow({ id = ID, ref = "23:7", chapter = 23, verse = 7, idCoerced = false } = {}) {
  return {
    id,
    idCoerced,
    refRaw: ref,
    chapter,
    verse,
    occurrence: null,
    tags: null,
    quote: null,
    question: "new question",
    response: "new response",
  };
}

console.log("\n[(a) the drop is COUNTED — real applyTsvRows over a real tombstone]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite);
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow()], null);

  eq(counts.tombstone_blocked, 1, "tombstone_blocked === 1 (was silent before this fix)");
  eq(counts.inserted, 0, "nothing was inserted");
  eq(counts.skipped_edited, 1, "still also counted skipped_edited — existing readers unchanged");
  eq(counts.conflict_skipped, 0, "NOT counted as a PK conflict: the tombstone branch owns this drop");
  eq(
    (counts.blocked_samples ?? []).length,
    1,
    "one sample recorded, so the banner can name the row a human must go fix",
  );
  eq(
    (counts.blocked_samples ?? [])[0].includes("5:4") && (counts.blocked_samples ?? [])[0].includes("23:7"),
    true,
    "the sample names BOTH references, which is what makes it actionable",
  );

  // The data loss is real: master's row is genuinely absent from D1.
  const stored = sqlite.prepare(`SELECT chapter, question, deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored.length, 1, "still exactly one row for that (book, id)");
  eq(stored[0].chapter, 5, "the surviving row is the old 5:4 tombstone");
  eq(stored[0].question, "old question", "master's text never landed — option 2 reports the loss, it does not fix it");

  // THE DRIFT DETECTOR. If anyone adds `deleted_at IS NULL` to applyTsvRows'
  // `existing` read, the tombstone stops being found, this row takes the INSERT
  // path instead, and these two assertions flip — which is the whole point.
  eq(counts.conflict_skipped + counts.tombstone_blocked, 1, "exactly one drop counted, by exactly one route");
}

console.log("\n[the same-reference tombstone must NOT count — it is a delete awaiting export]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { ref: "5:4", chapter: 5, verse: 4 });
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow({ ref: "5:4", chapter: 5, verse: 4 })], null);
  eq(counts.tombstone_blocked, 0, "same ref → not blocked (the 4 AMO rows in the production sweep)");
  eq(counts.skipped_edited, 1, "still skipped, which is what preserves the pending deletion");
  eq(shouldRecordResourceSync(counts), true, "and the watermark is NOT withheld for it");
}

console.log("\n[a COERCED id must never count as blocked — review finding F4]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { ref: "5:4", chapter: 5, verse: 4 });
  // coerceRowId hashes a malformed master id into a 96-id space, so landing on
  // an unrelated tombstone at a different reference is an expected collision,
  // not evidence master reissued anything. Counting it would freeze the export.
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow({ ref: "23:7", idCoerced: true })], null);
  eq(counts.tombstone_blocked, 0, "coerced id + different ref → NOT blocked (documented-benign no-op)");
  eq(shouldRecordResourceSync(counts), true, "so a coercion collision cannot withhold the watermark");
}

console.log("\n[(b) the watermark is WITHHELD, and the STORED row proves it]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite);
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow()], null);

  // The gate is consulted on the AGGREGATE, not on this raw object — that is the
  // step where an absent counter could be laundered into a present zero. Prove
  // the taint survives it by folding through the real aggregation path.
  const { zeroCountsForTest, addCountsForTest } = await import("./bookReimport.ts").then((m) => ({
    zeroCountsForTest: m.zeroCountsForTest,
    addCountsForTest: m.addCountsForTest,
  }));
  const aggregate = zeroCountsForTest();
  addCountsForTest(aggregate, counts);
  eq(aggregate.tombstone_blocked, 1, "the count survives aggregation (addCounts)");
  eq(shouldRecordResourceSync(aggregate), false, "the gate refuses to stamp on the aggregate");

  // Now the real write path the reimport-sync step takes when it withholds.
  await recordWithheldSyncIfAbsent(env, BOOK, "tq");
  const row = sqlite
    .prepare(`SELECT source_sha, origin FROM book_resource_syncs WHERE book = ? AND resource = ?`)
    .all(BOOK, "tq")[0];
  eq(row?.origin, "reimport_withheld", "STORED origin is 'reimport_withheld', NOT 'reimport'");
  eq(
    row?.source_sha,
    "withheld",
    "and the stored sha is the sentinel — a value no real commit sha can equal, so the export's " +
      "freshness gate reports master_ahead instead of the no_watermark/ok it would return for an absent row",
  );
}

console.log("\n[(c) the banner is QUERYABLE where the UI reads it]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite);
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow()], null);
  const { raiseTombstoneBlockAlertForTest } = await import("./bookReimport.ts");
  await raiseTombstoneBlockAlertForTest(env, BOOK, "tq", counts);

  const alert = sqlite
    .prepare(`SELECT username, severity, source, message FROM system_alerts WHERE source = ?`)
    .all(`reimport_id_blocked:${BOOK}:tq`)[0];
  eq(alert !== undefined, true, "an alert row exists in system_alerts");
  eq(alert?.severity, "error", "raised at error severity");
  eq(alert?.message.includes("1CH"), true, "names the book");
  eq(alert?.message.includes("hoig"), true, "names the actual blocked row id, so it is actionable");
  eq(
    alert?.message.includes("does NOT clear on its own"),
    true,
    "states the freeze-until-a-human-acts consequence plainly",
  );
  eq(
    alert?.message.includes("re-run the sync"),
    false,
    "and does NOT repeat the export_stale banner's advice, which cannot work here",
  );
}

console.log("\n[(d) the HEALTHY path still stamps — no false withhold]");
{
  const { sqlite, env } = freshEnv();
  // No tombstone at all: master's row is genuinely new.
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow()], null);
  eq(counts.inserted, 1, "the row lands normally");
  eq(counts.tombstone_blocked, 0, "nothing blocked");
  eq(counts.conflict_skipped, 0, "nothing conflicted");
  eq(shouldRecordResourceSync(counts), true, "the gate permits the stamp");

  await recordResourceSync(env, BOOK, "tq", "abc123def456", "reimport");
  const row = sqlite
    .prepare(`SELECT source_sha, origin FROM book_resource_syncs WHERE book = ? AND resource = ?`)
    .all(BOOK, "tq")[0];
  eq(row?.origin, "reimport", "STORED origin is 'reimport' — the book IS certified in sync");
  eq(row?.source_sha, "abc123def456", "with master's real sha, not the sentinel");

  const alerts = sqlite.prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source LIKE 'reimport_id_blocked:%'`).all()[0];
  eq(Number(alerts.n), 0, "and no banner is raised on a clean run");
}

// ── Reference-move attribution, at the CALLER (issue #540 item 3) ───────────
// classifyTsvRefMove/foldTsvRefBase are unit-tested, but every consequence that
// matters lives in applyTsvRows: whether apply_incomplete is set (which withholds
// the resource watermark and blocks the nightly export), whether the row is
// flagged, and whether a stale flag is cleared. This drives the REAL applyTsvRows
// over real SQLite, which is the only place those can be observed.
console.log("\n[reference-move attribution at the caller]");
{
  // An edited tq row that the APP moved 1:2 -> 1:6 after the watermark, while
  // master still sits at the ancestor. The livelock case.
  const seedUser = (sqlite) =>
    sqlite
      .prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`)
      .run();
  const seedMoved = (sqlite, { reviewKind = null } = {}) => {
    seedUser(sqlite);
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, updated_by, version, review_kind, review_reason)
         VALUES ('mv01', ?, 1, 6, '1:6', 'our question', 'our response', 10, 7, 3, ?, ?)`,
      )
      .run(BOOK, reviewKind, reviewKind ? "some earlier reason" : null);
    // Ancestor: the row at 1:2, logged before the boundary.
    const e = sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at)
         VALUES ('tq', 'mv01', ?, 'create', ?, 100)`,
      )
      .run(BOOK, JSON.stringify({ chapter: 1, verse: 2, ref_raw: "1:2", question: "our question", response: "our response" }));
    return Number(e.lastInsertRowid);
  };
  const masterAt = (ref, chapter, verse, extra = {}) => ({
    id: "mv01", idCoerced: false, refRaw: ref, chapter, verse,
    occurrence: null, tags: null, quote: null,
    question: "our question", response: "our response", ...extra,
  });

  // 1. Pure app-side move: no hold, no flag. This is the whole point.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedMoved(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", [masterAt("1:2", 1, 2)], null, {
      confirmedAt: 200, editId: boundary,
    });
    eq(counts.ref_moved_ours, 1, "app-side move is attributed to us");
    eq(counts.apply_incomplete, false, "…and does NOT withhold the resource watermark (the livelock kill)");
    const row = sqlite.prepare(`SELECT review_kind, version FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(row.review_kind, null, "…and raises no flag");
    eq(row.version, 3, "…and writes nothing, so the version does not move");
  }

  // 2. Same move, but a previous run left the mis-attributed flag. Cleared, once.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedMoved(sqlite, { reviewKind: "ref_moved" });
    const counts = await applyTsvRows(env, BOOK, "tq", [masterAt("1:2", 1, 2)], null, {
      confirmedAt: 200, editId: boundary,
    });
    eq(counts.apply_incomplete, false, "clearing a stale flag does not withhold the watermark");
    const row = sqlite.prepare(`SELECT review_kind, review_reason FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(row.review_kind, null, "the stale ref_moved flag is cleared");
    eq(row.review_reason, null, "…reason too");
  }

  // 3. A merge_conflict flag is NOT collateral damage of that clear.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedMoved(sqlite, { reviewKind: "merge_conflict" });
    await applyTsvRows(env, BOOK, "tq", [masterAt("1:2", 1, 2)], null, { confirmedAt: 200, editId: boundary });
    const row = sqlite.prepare(`SELECT review_kind FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(row.review_kind, "merge_conflict", "an unacknowledged merge_conflict survives an ours_moved run");
  }

  // 4. Master moved instead: the old behavior, hold + flag, must be intact.
  {
    const { sqlite, env } = freshEnv();
    // D1 back at the ancestor, master re-anchored.
    sqlite.prepare(`UPDATE tq_rows SET chapter=1, verse=2, ref_raw='1:2' WHERE id='mv01'`).run();
    const boundary = seedMoved(sqlite);
    sqlite.prepare(`UPDATE tq_rows SET chapter=1, verse=2, ref_raw='1:2' WHERE id='mv01'`).run();
    const counts = await applyTsvRows(env, BOOK, "tq", [masterAt("1:9", 1, 9)], null, {
      confirmedAt: 200, editId: boundary,
    });
    eq(counts.ref_moved_theirs, 1, "a master-side move is attributed to Door43");
    eq(counts.apply_incomplete, true, "…and still withholds the resource watermark");
    const row = sqlite.prepare(`SELECT review_kind, review_reason FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(row.review_kind, "ref_moved", "…and flags the row");
    eq(row.review_reason.includes("A Door43 editor moved this row"), true, "…naming Door43, which the ancestor proves");
    eq(row.review_reason.includes("export stays on hold"), true, "…and saying what actually releases the hold");
  }

  // 5. No ancestor at all: holds, and must NOT name Door43.
  {
    const { sqlite, env } = freshEnv();
    seedUser(sqlite);
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, updated_by, version)
         VALUES ('mv02', ?, 1, 6, '1:6', 'q', 'r', 10, 7, 3)`,
      )
      .run(BOOK);
    const counts = await applyTsvRows(
      env, BOOK, "tq",
      [{ id: "mv02", idCoerced: false, refRaw: "1:2", chapter: 1, verse: 2, occurrence: null, tags: null, quote: null, question: "q", response: "r" }],
      null, { confirmedAt: 200, editId: 999999 },
    );
    eq(counts.ref_moved_unattributable, 1, "no ancestor -> unattributable");
    eq(counts.apply_incomplete, true, "…still holds (fail safe)");
    const row = sqlite.prepare(`SELECT review_reason FROM tq_rows WHERE id='mv02'`).all()[0];
    eq(row.review_reason.includes("Door43 editor moved"), false, "…and never claims a Door43 editor moved it");
    eq(row.review_reason.includes("no edit history survives"), true, "…it states the measured cause");
  }
}

// ── AI-vs-human conflict policy at the caller (#540 item 2) ─────────────────
// The pure computeTsvMerge decision is covered in tsvMerge.test.mjs. What is
// NOT — and where every defect in the last change of this shape lived — is the
// caller: whether a keep_ai_master row is actually written, flagged, counted,
// and, critically, whether it withholds the resource watermark. It must not:
// the export is how the kept human edit reaches Door43.
console.log("\n[AI-vs-human conflict policy at the caller]");
{
  const seedContested = (sqlite) => {
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`).run();
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, quote, question, response, sort_order, updated_by, version)
         VALUES ('ai01', ?, 1, 2, '1:2', null, 'our question', 'our response', 10, 7, 3)`,
      )
      .run(BOOK);
    // The ancestor: what D1 held when the export last published this row.
    const e = sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at)
         VALUES ('tq', 'ai01', ?, 'create', ?, 100)`,
      )
      .run(
        BOOK,
        JSON.stringify({ chapter: 1, verse: 2, ref_raw: "1:2", question: "our question", response: "base response" }),
      );
    return Number(e.lastInsertRowid);
  };
  // Master's row: the response moved on that side too, so BOTH sides moved it.
  const masterRowAt = (response) => ({
    id: "ai01", idCoerced: false, refRaw: "1:2", chapter: 1, verse: 2,
    occurrence: null, tags: null, quote: null, question: "our question", response,
  });
  const AI_ONLY = {
    mayHoldHumanEdit: false, hasHumanCommit: false, incomplete: false, incompleteReason: "",
    counts: { ours: 1, ai: 1, human: 0 }, humanShas: [],
  };
  const HAS_HUMAN = {
    mayHoldHumanEdit: true, hasHumanCommit: true, incomplete: false, incompleteReason: "",
    counts: { ours: 1, ai: 0, human: 1 }, humanShas: ["abc123"],
  };
  const readRow = (sqlite) =>
    sqlite.prepare(`SELECT response, review_kind, review_reason, version FROM tq_rows WHERE id='ai01'`).all()[0];

  // 1. The AMO 4:2 shape. Only our export and the pipeline moved master, so the
  //    app edit wins — and it is still flagged, because a human should look.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", [masterRowAt("the AI run's response")], null, {
      confirmedAt: 200, editId: boundary, lineage: AI_ONLY,
    });
    const row = readRow(sqlite);
    eq(row.response, "our response", "the app edit is KEPT — master's AI-authored value never lands");
    eq(counts.merge_kept_ai, 1, "…counted as merge_kept_ai");
    eq(counts.merge_adopted, 0, "…and never counted as an adoption");
    eq(counts.merge_refused, 0, "…and never as a refusal, which would freeze the export at 5");
    eq(counts.apply_incomplete, false, "…and does NOT withhold the watermark: the export must publish this");
    // A DISTINCT review_kind, not just distinct prose: the cleanup chip titles
    // itself from this column, and "Merged Door43 edit" over a kept row is the
    // reverse of what happened.
    eq(row.review_kind, "merge_kept", "…the row is flagged for review, as a KEPT row");
    eq(
      row.review_reason.startsWith("Your response was kept over Door43's"),
      true,
      "…the reason leads with the outcome (the chip clamps to two lines)",
    );
    eq(
      row.review_reason.includes("no commit from a Door43 editor's own account was found"),
      true,
      "…and states the measured cause, not an inferred one",
    );
    eq(
      row.review_reason.includes("was merged over your app-side change"),
      false,
      "…never the opposite claim, that Door43's edit won",
    );
    eq(
      row.review_reason.includes("will be published to Door43"),
      false,
      "…and never promises a publish this per-row code cannot schedule",
    );
    eq(row.version, 4, "…the flag write bumps the version once");

    // 2. Re-running the same night's shape must not churn the version. The
    //    condition recurs every sync until a human resolves it, and a flag-only
    //    write is still a write (#539).
    const again = await applyTsvRows(env, BOOK, "tq", [masterRowAt("the AI run's response")], null, {
      confirmedAt: 200, editId: boundary, lineage: AI_ONLY,
    });
    eq(again.merge_kept_ai, 1, "the conflict is still detected on the next run");
    eq(readRow(sqlite).version, 4, "…but an unchanged flag is not re-written");
  }

  // 3. A human commit on master since the ancestor: unchanged behaviour, master
  //    still wins. This is the half of the policy that must NOT move.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", [masterRowAt("a maintainer's fix")], null, {
      confirmedAt: 200, editId: boundary, lineage: HAS_HUMAN,
    });
    const row = readRow(sqlite);
    eq(row.response, "a maintainer's fix", "a human-authored master edit still wins the collision");
    eq(counts.merge_adopted, 1, "…counted as an adoption");
    eq(counts.merge_kept_ai, 0, "…and not as a kept AI conflict");
    eq(row.review_reason.includes("was merged over your app-side change"), true, "…with the pre-existing wording");
  }

  // 4. No lineage at all — the field an in-flight Workflow's memoized plan does
  //    not carry. Must read as "a human may have", i.e. today's behaviour.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", [masterRowAt("a maintainer's fix")], null, {
      confirmedAt: 200, editId: boundary,
    });
    eq(readRow(sqlite).response, "a maintainer's fix", "an absent lineage keeps master-wins, not D1-wins");
    eq(counts.merge_kept_ai, 0, "…and never reports a kept AI conflict it did not measure");
  }

  // 5. A row that ALSO moved reference keeps the reference-move flag. That flag
  //    is the only thing telling the translator why the whole book+resource has
  //    stopped exporting, and a kept-conflict message replacing it would both
  //    destroy that and describe an export that is not going to run.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const moved = { ...masterRowAt("the AI run's response"), refRaw: "1:9", verse: 9 };
    const counts = await applyTsvRows(env, BOOK, "tq", [moved], null, {
      confirmedAt: 200, editId: boundary, lineage: AI_ONLY,
    });
    const row = readRow(sqlite);
    eq(counts.apply_incomplete, true, "a master-side reference move still withholds the watermark");
    eq(row.review_kind, "ref_moved", "…and the row keeps the reference-move flag, not the kept-conflict one");
    eq(
      row.review_reason.includes("kept over Door43's"),
      false,
      "…so the hold's explanation is not overwritten by a publish the hold prevents",
    );
  }

  // 6. An INCOMPLETE walk that happened to see no human commit is not the same
  //    claim as a complete one that found none — and only the complete one may
  //    flip the outcome.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", [masterRowAt("a maintainer's fix")], null, {
      confirmedAt: 200,
      editId: boundary,
      lineage: {
        mayHoldHumanEdit: true, hasHumanCommit: false, incomplete: true, incompleteReason: "page_cap",
        counts: { ours: 0, ai: 3, human: 0 }, humanShas: [],
      },
    });
    eq(readRow(sqlite).response, "a maintainer's fix", "an incomplete walk protects master exactly like a human commit");
    eq(counts.merge_kept_ai, 0, "…and does not report a kept AI conflict");
  }
}

// ── merge_no_base_refs folds through the REAL addCounts (issue #537) ─────────
// The banner's ref list is a capped diagnostic sample merged across Workflow
// chunks. Everything that makes it safe lives in addCounts — the cap, and
// tolerating a chunk memoized before the field existed — and none of it was
// covered, so a dropped `break` or a missing `??` would have gone red nowhere.
// Folds through the same real aliases the blocked_samples case above uses,
// rather than re-implementing the aggregation.
{
  const { zeroCountsForTest, addCountsForTest } = await import("./bookReimport.ts").then((m) => ({
    zeroCountsForTest: m.zeroCountsForTest,
    addCountsForTest: m.addCountsForTest,
  }));

  // Two chunks' worth of refs merge and accumulate.
  const agg = zeroCountsForTest();
  const chunkA = zeroCountsForTest();
  chunkA.merge_no_base = 2;
  chunkA.merge_no_base_refs = ["40:5", "40:6"];
  const chunkB = zeroCountsForTest();
  chunkB.merge_no_base = 1;
  chunkB.merge_no_base_refs = ["42:2"];
  addCountsForTest(agg, chunkA);
  addCountsForTest(agg, chunkB);
  eq(agg.merge_no_base, 3, "counts sum across chunks");
  eq((agg.merge_no_base_refs ?? []).join(","), "40:5,40:6,42:2", "refs concatenate in chunk order");

  // A chunk memoized before the field existed carries a count and NO refs. It
  // must fold without throwing and without poisoning the count — the banner
  // then reports a count larger than the sample, which buildNoBaseSentence
  // renders as "+N more".
  const legacy = zeroCountsForTest();
  legacy.merge_no_base = 5;
  delete legacy.merge_no_base_refs;
  addCountsForTest(agg, legacy);
  eq(agg.merge_no_base, 8, "a pre-field chunk still contributes its count");
  eq((agg.merge_no_base_refs ?? []).length, 3, "…and contributes no refs, rather than undefined-poisoning the list");

  // The cap holds under a flood, and the aggregate never exceeds it.
  const flood = zeroCountsForTest();
  flood.merge_no_base = 500;
  flood.merge_no_base_refs = Array.from({ length: 500 }, (_, i) => `9:${i}`);
  const capped = zeroCountsForTest();
  addCountsForTest(capped, flood);
  const cap = (await import("./verseMergeEditorAlerts.ts")).NO_BASE_REF_DISPLAY;
  eq((capped.merge_no_base_refs ?? []).length, cap, "addCounts enforces the ref cap");
  eq(capped.merge_no_base, 500, "…while the authoritative count is uncapped");

  // A fresh zeroCounts must not alias another accumulator's array.
  const one = zeroCountsForTest();
  const two = zeroCountsForTest();
  one.merge_no_base_refs.push("1:1");
  eq((two.merge_no_base_refs ?? []).length, 0, "zeroCounts allocates a fresh refs array per call (no aliasing)");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll reimportJourney assertions passed.");
