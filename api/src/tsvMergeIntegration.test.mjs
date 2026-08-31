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
import { classifyTsvRefMove, computeTsvMerge, foldTsvBase, foldTsvRefBase } from "./tsvMerge.ts";

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
function loadEntriesById(ids, boundaryId = null) {
  const inClause = ids.map(() => "?").join(", ");
  const boundaryClause = boundaryId != null ? "id <= ?" : "created_at < ?";
  const boundaryBind = boundaryId != null ? boundaryId : CUTOFF;
  const rows = db
    .prepare(
      `SELECT row_key, action, payload_json, book FROM edit_log
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
    // `book` and the bookKnown mapping are part of the production shape, not
    // decoration: the WHERE deliberately admits `book IS NULL` rows, and
    // foldTsvRefBase refuses them. Dropping `book` from this SELECT would make
    // `r.book` undefined, so `bookKnown` would be false for EVERY entry, every
    // reference ancestor would be null, and every move would become
    // `unattributable` — re-holding every book. That is one keystroke away and
    // would pass a copy of this query that did not carry the column.
    list.push({ action: r.action, payload, bookKnown: r.book != null });
    byId.set(r.row_key, list);
  }
  return byId;
}

// The content ancestor, folded from those entries — what reconstructTsvBases
// returns as `.content`.
function reconstructBase(ids, boundaryId = null) {
  const byId = loadEntriesById(ids, boundaryId);
  const out = new Map();
  for (const id of ids) out.set(id, foldTsvBase(KIND, byId.get(id) ?? []));
  return out;
}

// The REFERENCE ancestor, folded from the SAME entries — what
// reconstructTsvBases returns as `.ref`. Production folds both from one read;
// so does this, which is the point of running it here rather than only in the
// pure test.
function reconstructRefBase(ids, boundaryId = null) {
  const byId = loadEntriesById(ids, boundaryId);
  const out = new Map();
  for (const id of ids) out.set(id, foldTsvRefBase(byId.get(id) ?? []));
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

// ── Reference ancestor end to end (issue #540 item 3) ───────────────────────
// The pure classifyTsvRefMove / foldTsvRefBase decisions are unit-tested in
// tsvMerge.test.mjs. What this proves is the part a pure test cannot: that the
// REAL reconstructTsvBases query hands the fold entries in the shapes production
// actually wrote, so the reference ancestor is recovered rather than silently
// absent. An absent one degrades every move to `unattributable`, which fails
// safe but re-creates the livelock this change exists to kill.
{
  const ID3 = "ef56";
  // Production history, in the two writer shapes that really coexist in
  // edit_log: bookImport.ts's audit payload (snake_case ref_raw) and
  // bookReimport.ts's logEditStmt(..., u.row), which stringifies a ParsedTsvRow
  // (camelCase refRaw). Both predate the boundary.
  const createInfo = ins.run(
    KIND, ID3, BOOK, "create",
    JSON.stringify({ book: BOOK, chapter: 1, verse: 2, ref_raw: "1:2", quote: "q", note: "n" }),
    100,
  );
  // A later reimport brought in a verse-bridge reshape master had made
  // ("1:2" -> "1:2-3", same leading verse). The value DIFFERS from the create's,
  // so this assertion is only satisfiable by reading the camelCase spelling —
  // with `refRaw` ignored the fold would fall back to the create's "1:2" and the
  // classification below flips to both_moved.
  const reimportInfo = ins.run(
    KIND, ID3, BOOK, "update",
    JSON.stringify({ id: ID3, refRaw: "1:2-3", chapter: 1, verse: 2, quote: "q", note: "n2", occurrence: 1 }),
    200,
  );
  const boundaryId = Number(reimportInfo.lastInsertRowid);

  // The app then moves the row to verse 6 — a PARTIAL patch (rows.ts sends
  // ref_raw + verse and never chapter, since moves are same-chapter only), and
  // it lands AFTER the boundary, so it must not fold into the ancestor.
  ins.run(KIND, ID3, BOOK, "update", JSON.stringify({ ref_raw: "1:6", verse: 6 }), 400);

  const refBase = reconstructRefBase([ID3], boundaryId).get(ID3);
  eq(refBase, { chapter: 1, verse: 2, ref_raw: "1:2-3" },
    "reference ancestor is recovered through the real query, across both ref_raw spellings");

  // D1 now holds the move; master still holds what we last published. This is
  // the exact shape that used to flag the translator and withhold the watermark
  // forever. It must classify as ours_moved: no flag, no hold, export publishes.
  eq(
    classifyTsvRefMove({ chapter: 1, verse: 6, ref_raw: "1:6" }, { chapter: 1, verse: 2, refRaw: "1:2-3" }, refBase, false),
    "ours_moved",
    "an app-side move against a real reconstructed ancestor is ours_moved (the livelock case)",
  );

  // The mirror: D1 untouched since the boundary, master re-anchored out of band.
  // Still theirs_moved -> flag + hold, exactly as before this change.
  eq(
    classifyTsvRefMove({ chapter: 1, verse: 2, ref_raw: "1:2-3" }, { chapter: 1, verse: 9, refRaw: "1:9" }, refBase, false),
    "theirs_moved",
    "an out-of-band master move against the same ancestor still holds",
  );

  // Without the boundary (no watermark yet), reconstructTsvBases is never called
  // and the base is null — which must withhold, not guess a side.
  eq(classifyTsvRefMove({ chapter: 1, verse: 6, ref_raw: "1:6" }, { chapter: 1, verse: 2, refRaw: "1:2" }, null, false),
    "unattributable", "no watermark -> no ancestor -> unattributable, never a guessed side");

  eq(Number(createInfo.lastInsertRowid) < boundaryId, true, "sanity: create id is below the captured boundary");
}

// The cross-book guard, through the real query rather than hand-built entries.
// The WHERE deliberately admits `book IS NULL` rows (0017's backfill left 7,689
// of them in prod), and row ids are unique only per (book, id) — so the SELECT
// must carry `book` and the fold must refuse what it cannot attribute. Exercised
// here because a pure test cannot catch the column going missing from the query:
// `r.book` would be undefined, every entry would be skipped, every reference
// ancestor would be null, and every move would re-hold.
{
  const ID4 = "gh78";
  // A legacy entry with NO book: another book's history landing on the same
  // 4-char id. It must not contribute a reference.
  ins.run(KIND, ID4, null, "create", JSON.stringify({ chapter: 9, verse: 9, ref_raw: "9:9" }), 50);
  const known = ins.run(
    KIND, ID4, BOOK, "create", JSON.stringify({ chapter: 1, verse: 2, ref_raw: "1:2" }), 100,
  );
  eq(
    reconstructRefBase([ID4], Number(known.lastInsertRowid)).get(ID4),
    { chapter: 1, verse: 2, ref_raw: "1:2" },
    "the book-NULL entry is admitted by the query but refused by the fold",
  );

  // With ONLY the unattributable entry the ancestor is null — withhold, never a
  // confident 9:9 lifted from another book.
  const ID5 = "ij90";
  const only = ins.run(KIND, ID5, null, "create", JSON.stringify({ chapter: 9, verse: 9, ref_raw: "9:9" }), 50);
  const noBase = reconstructRefBase([ID5], Number(only.lastInsertRowid)).get(ID5);
  eq(noBase, null, "a history of only book-NULL entries yields no reference ancestor");
  eq(
    classifyTsvRefMove(
      { chapter: 1, verse: 2, ref_raw: "1:2" }, { chapter: 1, verse: 6, refRaw: "1:6" }, noBase, false,
    ),
    "unattributable",
    "…so the move holds instead of borrowing another book's reference",
  );
}

// The same cross-book guard on the CONTENT ancestor (#545), through the real
// query. foldTsvBase got the identical `bookKnown === false` skip foldTsvRefBase
// already had — proven above — this exercises it against the SAME query, not a
// hand-built entry list, for the same reason: a missing `book` column in the
// SELECT would silently zero out every content ancestor too.
{
  const ID6 = "kl12";
  // A legacy entry with NO book: another book's note landing on the same
  // 4-char id. It must not contribute a field to this book's ancestor.
  ins.run(KIND, ID6, null, "create", JSON.stringify({ quote: "foreign-q", note: "foreign-n" }), 50);
  const known = ins.run(
    KIND, ID6, BOOK, "create", JSON.stringify({ quote: "q0", note: "n0" }), 100,
  );
  eq(
    reconstructBase([ID6], Number(known.lastInsertRowid)).get(ID6),
    { quote: "q0", note: "n0" },
    "the book-NULL entry is admitted by the query but refused by the content fold",
  );

  // With ONLY the unattributable entry the ancestor is null — withhold, never a
  // confident note lifted from another book.
  const ID7 = "mn34";
  const only = ins.run(KIND, ID7, null, "create", JSON.stringify({ quote: "foreign-q", note: "foreign-n" }), 50);
  eq(
    reconstructBase([ID7], Number(only.lastInsertRowid)).get(ID7),
    null,
    "a history of only book-NULL entries yields no content ancestor",
  );
}

// ── Create-as-ancestor fallback (#653) ──────────────────────────────────────
//
// The prod shape: bp-assistant pushed AI notes to master, the reimport CREATED
// them in D1 with a full-payload edit_log 'create', a translator then edited
// them — and the create's id sits ABOVE master_confirmed_edit_id because the
// evening pushes froze own-publish recognition. The bounded fold returns
// nothing and the row is flagged merge_no_base forever.
//
// The fallback query, re-typed here the way this file re-types the bounded one,
// and for the same reason: it is the SQL that has to be right.
function loadCreateFallback(ids) {
  const inClause = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT row_key, action, payload_json, book FROM edit_log
        WHERE kind = ? AND (book = ? OR book IS NULL)
          AND action = 'create'
          AND row_key IN (${inClause})
        ORDER BY row_key ASC, id ASC`,
    )
    .all(KIND, BOOK, ...ids);
  const byId = new Map();
  for (const r of rows) {
    if (byId.has(r.row_key)) continue; // earliest create per row_key
    let payload = null;
    if (r.payload_json) {
      try {
        const p = JSON.parse(r.payload_json);
        if (p && typeof p === "object" && !Array.isArray(p)) payload = p;
      } catch {
        /* ignore */
      }
    }
    byId.set(r.row_key, [{ action: r.action, payload, bookKnown: r.book != null }]);
  }
  return byId;
}

// Production's composition: bounded first, fallback ONLY where the bounded
// candidate set came back empty.
function reconstructBaseWithFallback(ids, boundaryId) {
  const bounded = loadEntriesById(ids, boundaryId);
  const missing = ids.filter((id) => !bounded.has(id));
  const fallback = missing.length ? loadCreateFallback(missing) : new Map();
  const out = new Map();
  for (const id of ids) out.set(id, foldTsvBase(KIND, bounded.get(id) ?? fallback.get(id) ?? []));
  return out;
}

{
  const NEW_ID = "cr56";
  const BOUNDARY = 1; // every entry below is above it
  ins.run(KIND, NEW_ID, BOOK, "create", JSON.stringify({ quote: "imported-q", note: "imported-n" }), 900);
  // The translator's own edit, AFTER the create. It must never be folded — it
  // is the very change being merged.
  ins.run(KIND, NEW_ID, BOOK, "update", JSON.stringify({ note: "app-n" }), 950);

  eq(
    reconstructBase([NEW_ID], BOUNDARY).get(NEW_ID),
    null,
    "control: the bounded fold alone finds nothing — this is the prod bug",
  );
  eq(
    reconstructBaseWithFallback([NEW_ID], BOUNDARY).get(NEW_ID),
    { quote: "imported-q", note: "imported-n" },
    "the create is the ancestor, and the post-create app edit is NOT folded in",
  );
  // And the merge that follows: master unchanged since the import, D1 edited ->
  // our edit stands, cleanly, instead of an unattributable keep_no_base.
  const merged = computeTsvMerge(
    KIND,
    reconstructBaseWithFallback([NEW_ID], BOUNDARY).get(NEW_ID),
    { quote: "imported-q", note: "app-n", occurrence: null, support_reference: null },
    { quote: "imported-q", note: "imported-n", occurrence: null, support_reference: null },
  );
  eq(merged.action, "keep_master_unchanged", "…so the merge attributes the difference to us, not to nobody");

  // A create that never carried a field degrades PER FIELD, not wholesale.
  const THIN_ID = "cr78";
  ins.run(KIND, THIN_ID, BOOK, "create", JSON.stringify({ note: "only-a-note" }), 900);
  eq(
    reconstructBaseWithFallback([THIN_ID], BOUNDARY).get(THIN_ID),
    { note: "only-a-note" },
    "a create missing a field leaves that field absent (computeTsvMerge reads it as no_base)",
  );

  // The fallback is STRICTLY a fallback: a non-empty bounded set is never
  // supplemented with a post-boundary entry.
  const HELD_ID = "cr90";
  const held = ins.run(KIND, HELD_ID, BOOK, "create", JSON.stringify({ quote: "old-q", note: "old-n" }), 100);
  ins.run(KIND, HELD_ID, BOOK, "create", JSON.stringify({ quote: "later-q", note: "later-n" }), 900);
  eq(
    reconstructBaseWithFallback([HELD_ID], Number(held.lastInsertRowid)).get(HELD_ID),
    { quote: "old-q", note: "old-n" },
    "a non-empty bounded set is used as-is — no post-boundary entry is mixed in",
  );
}

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nall tsvMerge integration assertions passed");
db.close();
