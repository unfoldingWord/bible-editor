// Regression test: a versioned content PATCH landing on a TRASHED tn row must
// UN-trash it, or the 05:30 nightly finalize permanently tombstones the edit.
//
// Run from api/:
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/trashedRowPatch.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors blankStubTrash.test.mjs.
//
// The bug: user A trashes a note (POST /tn/:id/trash — a non-versioning
// bit-toggle: trashed_at set, version unchanged). User B's queued outbox PATCH
// then arrives with the still-valid If-Match. The content-PATCH UPDATE's WHERE
// filters `deleted_at IS NULL` but not trashed_at, so the PATCH lands with 200
// — and the nightly finalize (index.ts, 05:30 cron) promotes trashed_at →
// deleted_at unconditionally, permanently tombstoning B's fresh edit: never
// exported, and the reimport skips tombstones, so the work is gone.
//
// The fix (contentPatchClauses.ts): a versioned content edit sets
// `trashed_at = NULL` — an edit is the strongest signal the row should live,
// mirroring how any content edit clears review flags. This test builds the
// UPDATE exactly the way rows.ts does, from the REAL exported fragment, and
// runs it against real SQLite alongside the real finalize statement.

import { DatabaseSync } from "node:sqlite";
import { contentPatchClearClauses } from "./contentPatchClauses.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE tn_rows (
    id TEXT, book TEXT, chapter INTEGER, verse INTEGER, ref_raw TEXT,
    tags TEXT, support_reference TEXT, quote TEXT, occurrence INTEGER,
    note TEXT, sort_order REAL, version INTEGER NOT NULL DEFAULT 1,
    review_kind TEXT, review_reason TEXT, review_master_json TEXT,
    updated_at INTEGER, updated_by INTEGER, restored_from_version INTEGER,
    trashed_at INTEGER, deleted_at INTEGER,
    PRIMARY KEY (book, id)
  )`);
  d.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, version, updated_by)
     VALUES ('ab12', 'JER', 36, 21, '36:21', 'original note text', 1, 30)`,
  ).run();
  return d;
}

// User A trashes the row — mirrors setTnTrashed (rows.ts): trashed_at set,
// version NOT bumped (that non-bump is exactly what lets B's If-Match pass).
function trash(d, ts = 1785800000) {
  d.prepare(
    `UPDATE tn_rows SET trashed_at = ?1, updated_at = ?1
      WHERE id = 'ab12' AND deleted_at IS NULL AND book = 'JER'`,
  ).run(ts);
}

// User B's content PATCH — built exactly the way rows.ts builds it, from the
// real contentPatchClearClauses fragment. fields = ["note"].
function contentPatch(d, expectedVersion = 1) {
  const fields = ["note"];
  const setClauses = fields.map((f, i) => `${f} = ?${i + 1}`);
  setClauses.push(...contentPatchClearClauses("tn"));
  const baseParams = fields.length;
  setClauses.push(`version = version + 1`);
  setClauses.push(`updated_at = ?${baseParams + 1}`);
  setClauses.push(`updated_by = ?${baseParams + 2}`);
  setClauses.push(`restored_from_version = ?${baseParams + 3}`);
  const res = d
    .prepare(
      `UPDATE tn_rows
         SET ${setClauses.join(", ")}
       WHERE id = ?${baseParams + 4}
         AND version = ?${baseParams + 5}
         AND deleted_at IS NULL AND book = ?${baseParams + 6}`,
    )
    .run("B's fresh edit", 1785801000, 45, null, "ab12", expectedVersion, "JER");
  return res.changes === 1;
}

// The 05:30 nightly finalize — copied verbatim from index.ts's scheduled()
// (the promote statement; the audit INSERT reads pre-update state and doesn't
// affect what this test asserts).
function finalize(d) {
  d.exec(
    `UPDATE tn_rows SET deleted_at = trashed_at, trashed_at = NULL
      WHERE trashed_at IS NOT NULL AND deleted_at IS NULL`,
  );
}

function row(d) {
  return d.prepare(`SELECT * FROM tn_rows WHERE id = 'ab12' AND book = 'JER'`).get();
}

// ── THE INCIDENT: trash → queued content PATCH → nightly finalize ──
{
  const d = db();
  trash(d);
  assert(row(d).trashed_at !== null && row(d).version === 1, "trash sets trashed_at without bumping version (the If-Match stays valid)");
  assert(contentPatch(d), "B's content PATCH with valid If-Match lands (200)");
  const afterPatch = row(d);
  assert(afterPatch.trashed_at === null, "the versioned content edit UN-trashes the row");
  finalize(d);
  const final = row(d);
  assert(final.deleted_at === null, "nightly finalize does NOT tombstone the freshly-edited row");
  assert(final.note === "B's fresh edit", "B's edit survives the night");
  assert(final.version === 2, "the edit bumped the version normally");
}

// ── the deliberate policy stays: untouched trash IS finalized ──
{
  const d = db();
  trash(d, 1785800000);
  finalize(d);
  const final = row(d);
  assert(final.deleted_at === 1785800000, "a trashed row nobody edited is still finalized (deleted_at = trashed_at)");
  assert(final.trashed_at === null, "finalize clears trashed_at as before");
}

// ── a stale If-Match still 409s: un-trash never weakens concurrency ──
{
  const d = db();
  trash(d);
  assert(!contentPatch(d, 7), "a content PATCH with a stale If-Match does not land and does not un-trash");
  finalize(d);
  assert(row(d).deleted_at !== null, "the stale PATCH left the trash intact, so finalize proceeds");
}

// ── the reorder-only fast path must NOT resurrect a trashed note ──
// Mirrors rows.ts's sort_order-only UPDATE (non-versioning, no clear clauses).
{
  const d = db();
  trash(d);
  const res = d
    .prepare(
      `UPDATE tn_rows SET sort_order = ?1, updated_at = ?2
        WHERE id = ?3 AND version = ?4 AND deleted_at IS NULL AND book = ?5`,
    )
    .run(2.5, 1785801000, "ab12", 1, "JER");
  assert(res.changes === 1 && row(d).trashed_at !== null, "a drag/reorder leaves trashed_at intact (no resurrection)");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll trashedRowPatch tests passed");
}
