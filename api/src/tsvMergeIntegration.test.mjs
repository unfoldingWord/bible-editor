// Integration test: the TSV three-way merge against REAL SQLite, exercising the
// exact edit_log fold query reconstructTsvBases runs (bookReimport.ts) — the
// master_confirmed_at cutoff, row_key grouping, ORDER BY, and JSON payload
// parsing — then the merge decision on the reconstructed ancestor. The pure
// pieces (foldTsvBase / computeTsvMerge) are unit-tested in tsvMerge.test.mjs;
// this proves they compose correctly over data shaped like the real edit_log,
// with partial human patches and a post-cutoff edit that must be excluded.
//
// Run from api/ (needs the sqlite flag):
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/tsvMergeIntegration.test.mjs

import { DatabaseSync } from "node:sqlite";
import { foldTsvBase, computeTsvMerge } from "./tsvMerge.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE edit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT, row_key TEXT, book TEXT, action TEXT,
    payload_json TEXT, created_at INTEGER
  );
`);

const BOOK = "ZEC";
const KIND = "tn";
const ID = "ab12";
const CUTOFF = 300; // stands in for book_resource_syncs.master_confirmed_at

const ins = db.prepare(
  `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
);
// t0: create — full row snapshot (what rows.ts create logs).
ins.run(KIND, ID, BOOK, "create", JSON.stringify({ quote: "q0", note: "n0", occurrence: 1, support_reference: "rc://s0" }), 100);
// t1: human note edit — PARTIAL patch (what rows.ts PATCH logs). Within cutoff.
ins.run(KIND, ID, BOOK, "update", JSON.stringify({ note: "n_human" }), 200);
// t3: human quote edit AFTER the cutoff — must be EXCLUDED from the ancestor.
ins.run(KIND, ID, BOOK, "update", JSON.stringify({ quote: "q_post_cutoff" }), 400);
// Noise: a different row, and a null-payload delete, must not pollute the fold.
ins.run(KIND, "other", BOOK, "create", JSON.stringify({ quote: "x", note: "y" }), 150);
ins.run(KIND, ID, BOOK, "delete", null, 250);

// The EXACT query reconstructTsvBases runs, with anonymous params in appearance
// order (bind: kind, book, boundary, ...ids). Logic identical to bookReimport.ts:
// when `boundaryId` is given (P1.3), the fold cuts at `id <= boundaryId`; else it
// falls back to the second-granularity `created_at < CUTOFF` timestamp.
function reconstructBase(ids, boundaryId = null) {
  const inClause = ids.map(() => "?").join(", ");
  const boundaryClause = boundaryId != null ? "id <= ?" : "created_at < ?";
  const boundaryBind = boundaryId != null ? boundaryId : CUTOFF;
  const rows = db
    .prepare(
      `SELECT row_key, action, payload_json FROM edit_log
        WHERE kind = ? AND (book = ? OR book IS NULL)
          AND action IN ('create', 'update', 'restore')
          AND ${boundaryClause}
          AND row_key IN (${inClause})
        ORDER BY row_key ASC, id ASC`,
    )
    .all(KIND, BOOK, boundaryBind, ...ids);
  const byId = new Map();
  for (const r of rows) {
    let payload = null;
    if (r.payload_json) {
      try {
        const p = JSON.parse(r.payload_json);
        if (p && typeof p === "object" && !Array.isArray(p)) payload = p;
      } catch {
        /* ignore */
      }
    }
    const list = byId.get(r.row_key) ?? [];
    list.push({ action: r.action, payload });
    byId.set(r.row_key, list);
  }
  const out = new Map();
  for (const id of ids) out.set(id, foldTsvBase(KIND, byId.get(id) ?? []));
  return out;
}

const base = reconstructBase([ID]).get(ID);

// Ancestor = create's fields with the t1 note patch overlaid, and the
// post-cutoff quote edit (t3) EXCLUDED (quote stays create's "q0").
eq(base.note, "n_human", "fold: t1 partial note patch overlays create");
eq(base.quote, "q0", "fold: post-cutoff quote edit is excluded from ancestor");
eq("occurrence" in base, false, "fold: occurrence is not a merged field, so it is not in the ancestor");

// Now the merge. Current D1 (ours) reflects t1 note + t3 quote. Master (theirs)
// changed the NOTE out-of-band on Door43 and left quote at the ancestor value.
const ours = { quote: "q_post_cutoff", note: "n_human", occurrence: 1, support_reference: "rc://s0" };
const theirs = { quote: "q0", note: "n_master", occurrence: 1, support_reference: "rc://s0" };
const merge = computeTsvMerge("tn", base, ours, theirs);

// Expected: adopt master's note (we never moved note since the ancestor), KEEP
// our post-cutoff quote (master never moved quote). No conflict.
eq(merge.action, "adopt", "merge adopts (master moved note only)");
eq(merge.conflict, false, "merge has no conflict");
eq(merge.writeFields, { note: "n_master" }, "merge writes only master's note; our quote is preserved");

// Boundary case (Codex P1.3, fixed). An edit committed in the SAME second as the
// export's D1 read (created_at === CUTOFF) but that was reflected in the render —
// i.e. its edit_log id is at/below the captured boundary — must fold INTO the
// ancestor. The old `created_at < cutoff` timestamp cut excluded it (the ancestor
// was then one edit too old, producing a false both-changed conflict later); the
// precise `id <= boundaryId` cut includes it.
{
  const ID2 = "cd34";
  const createInfo = ins.run(KIND, ID2, BOOK, "create", JSON.stringify({ quote: "qA", note: "nA" }), 100);
  // A pre-read edit whose created_at is EXACTLY the cutoff second. It was part of
  // what the export rendered, so the export's id boundary captured at read time is
  // at or above this row's id.
  const atCutoffInfo = ins.run(KIND, ID2, BOOK, "update", JSON.stringify({ note: "n_at_cutoff" }), CUTOFF);
  const boundaryId = Number(atCutoffInfo.lastInsertRowid); // MAX(edit_log.id) at read

  // Old timestamp behavior (regression guard): the same-second edit falls out.
  const baseTs = reconstructBase([ID2]).get(ID2);
  eq(baseTs.note, "nA", "timestamp fallback: an edit AT the cutoff second is excluded (created_at < cutoff)");

  // P1.3 precise boundary: the same-second edit is now INCLUDED.
  const basePrecise = reconstructBase([ID2], boundaryId).get(ID2);
  eq(basePrecise.note, "n_at_cutoff", "precise boundary: a same-second pre-read edit (id <= boundary) folds into the ancestor");
  eq(basePrecise.quote, "qA", "precise boundary: the create still folds in (id below the boundary)");

  // An edit committed AFTER the read (id > boundary) is still excluded, even
  // though its created_at (also === CUTOFF) ties the boundary second — the id cut
  // is what makes this unambiguous.
  ins.run(KIND, ID2, BOOK, "update", JSON.stringify({ note: "n_after_read" }), CUTOFF);
  const basePost = reconstructBase([ID2], boundaryId).get(ID2);
  eq(basePost.note, "n_at_cutoff", "precise boundary: a post-read edit (id > boundary) is excluded");
  // (Referenced so an unused-var lint can't hide a copy-paste of the wrong id.)
  eq(Number(createInfo.lastInsertRowid) < boundaryId, true, "sanity: create id is below the captured boundary");
}

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nall tsvMerge integration assertions passed");
db.close();
