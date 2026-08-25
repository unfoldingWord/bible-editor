// Issue #539 item 3: "switch to v{N}" from the row history dialog must not
// burn a version when the version being restored holds the content the row
// already has.
//
// Run from api/ (needs the sqlite flag and the resolve hook, since rows.ts
// imports its siblings extensionless):
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/rowRestoreNoop.test.mjs
//
// THE BUG. rows.ts's no-op short-circuit required BOTH "every patched field
// already matches" AND "the restore marker isn't changing". A restore always
// sends a marker, so restoring to identical content failed the second half,
// fell through to the full versioned UPDATE, and wrote: version+1, an edit_log
// row, and a stored restored_from_version. Two costs, both reported from
// production. The version climbs for a change nobody made — the row shows v8
// after a restore that changed nothing — and the phantom entry then had to be
// hidden by RowHistoryDialog's `restored_from_version == null` filter, which
// hid every OTHER restore along with it (a translator's real v7 disappeared
// from her own history).
//
// Driven through the REAL Hono router against the REAL migration schema, not a
// re-typed UPDATE: the fix is a control-flow decision in the handler (which
// branch a request takes), and re-typing the SQL would prove nothing about it.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { rows } from "./rows.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Minimal D1 shim over node:sqlite — same shape as applyVerseRows.test.mjs.
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

const BOOK = "JER";
const ID = "ab12";
const NOTE = "The prophet is speaking to the exiles.";

function freshApp() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();

  const app = new Hono();
  // Stand in for attachAuth — requireEditor reads exactly these two.
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  app.route("/api/rows", rows);

  const env = { DB: makeDb(sqlite) };
  // waitUntil swallows the post-write broadcast / lane-reopen side effects,
  // which are best-effort in production too.
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const patch = (body, ifMatch) =>
    app.request(
      `/api/rows/tn/${ID}?book=${BOOK}`,
      {
        method: "PATCH",
        headers: { "if-match": String(ifMatch), "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
      ctx,
    );
  return { sqlite, patch };
}

function seedRow(sqlite, { note = NOTE, version = 4, restoredFrom = null } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, updated_by, restored_from_version)
       VALUES (?, ?, 36, 21, '36:21', ?, 10, ?, 9, ?)`,
    )
    .run(ID, BOOK, note, version, restoredFrom);
}

const row = (sqlite) => sqlite.prepare(`SELECT * FROM tn_rows WHERE id = ? AND book = ?`).all(ID, BOOK)[0];
const logCount = (sqlite) =>
  sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE kind = 'tn' AND row_key = ?`).all(ID)[0].n;

console.log("\n[restoring to content the row already holds is a genuine no-op]");
{
  const { sqlite, patch } = freshApp();
  seedRow(sqlite);

  const res = await patch({ note: NOTE, restored_from_version: 2 }, 4);
  eq(res.status, 200, "the restore is accepted");

  const r = row(sqlite);
  eq(r.version, 4, "the version does NOT move — THE assertion this fix exists for");
  eq(r.note, NOTE, "the note is unchanged");
  eq(logCount(sqlite), 0, "no edit_log row: a phantom history entry is what hid the real ones");
  eq(r.restored_from_version, null, "the marker is left alone — the row's content did not move, so its provenance did not either");
}

console.log("\n[an ordinary no-op save on a row that carries a restore marker also stops bumping]");
{
  // The same shape in the other direction: no marker sent (which used to mean
  // "clear it"), row currently marked. Content still did not move.
  const { sqlite, patch } = freshApp();
  seedRow(sqlite, { restoredFrom: 2 });

  const res = await patch({ note: NOTE }, 4);
  eq(res.status, 200, "the save is accepted");
  eq(row(sqlite).version, 4, "the version does not move");
  eq(logCount(sqlite), 0, "and no edit_log row is written");
}

console.log("\n[a restore that DOES change the content still bumps, and still records the marker]");
{
  // The control. Without it, "stop burning versions" could be satisfied by
  // never writing at all.
  const { sqlite, patch } = freshApp();
  seedRow(sqlite);

  const res = await patch({ note: "An older wording of the note.", restored_from_version: 2 }, 4);
  eq(res.status, 200, "the restore is accepted");

  const r = row(sqlite);
  eq(r.version, 5, "the version DOES move for a real content change");
  eq(r.note, "An older wording of the note.", "…and v2's text landed");
  eq(r.restored_from_version, 2, "…and the chip's marker records where it came from");
  eq(logCount(sqlite), 1, "…and the change is in the audit log");
}

console.log("\n[an ordinary content edit still bumps]");
{
  const { sqlite, patch } = freshApp();
  seedRow(sqlite, { restoredFrom: 2 });

  const res = await patch({ note: "A brand new wording." }, 4);
  eq(res.status, 200, "the edit is accepted");
  const r = row(sqlite);
  eq(r.version, 5, "the version moves");
  eq(r.restored_from_version, null, "…and an ordinary edit still clears the restore marker");
}

// F3 (cold review): the no-op short-circuit must never leave a TRASHED tn row
// heading for deletion.
//
// A trashed tn row is queued for the 05:30 finalize, which promotes trashed_at
// -> deleted_at unconditionally. The full write path applies
// contentPatchClearClauses, which sets trashed_at = NULL for tn — an edit is the
// strongest signal the row should live (trashedRowPatch.test.mjs pins the
// incident). Before the #539 change, a trashed row carrying a restore marker
// failed the old `restoreMatches` test and fell through to that write even on
// identical content, so it was revived as a side effect. Short-circuiting would
// have left it dying. A saved version is not worth a deleted note, so a trashed
// tn row keeps the full-write path — it is the one carve-out from item 3.
console.log("\n[a no-op save on a TRASHED tn row still revives it (the item-3 carve-out)]");
{
  const { sqlite, patch } = freshApp();
  seedRow(sqlite, { restoredFrom: 2 });
  sqlite.prepare(`UPDATE tn_rows SET trashed_at = 1785800000 WHERE id = ? AND book = ?`).run(ID, BOOK);

  const res = await patch({ note: NOTE, restored_from_version: 2 }, 4);
  eq(res.status, 200, "the save is accepted");

  const r = row(sqlite);
  eq(r.trashed_at, null, "the row is UN-trashed — it is no longer queued for tonight's finalize");
  eq(r.version, 5, "…which costs a version, deliberately: reviving the note outranks saving one");
  eq(r.note, NOTE, "…and the content is unchanged");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll restore-no-op assertions passed.");
