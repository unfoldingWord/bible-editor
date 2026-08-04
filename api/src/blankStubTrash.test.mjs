// Regression test for the server-side precondition on the blank-stub auto-discard.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/blankStubTrash.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors chapterLock.test.mjs.
//
// The bug: "Add note" POSTs note:"" on purpose to mint an empty stub, so neither
// blank-note guard (the 422 backstop in rows.ts, wouldBlankExistingNote in the
// note dialog) can fire on create — both are scoped to a non-empty -> empty
// PATCH. A stub the translator never filled therefore persisted forever and
// exported to DCS as a blank tn line. Confirmed live for JER 36:21 `fa9t` and
// 36:24 `c3u7` (created 2026-07-27/28, on no en_tn master file at all).
//
// The client discards such a stub on deactivation, but it decides from a CACHED
// row. If a collaborator fills the stub in between, an unconditional trash would
// bin a now-substantive note and the nightly job would promote that to a
// permanent tombstone. So the UPDATE carries BLANK_STUB_CLAUSE and D1 re-asserts
// the predicate atomically. This test runs that exact clause against real SQLite
// — asserting the string would prove nothing about what SQLite does with it.

import { DatabaseSync } from "node:sqlite";
import { BLANK_STUB_CLAUSE } from "./blankStub.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Only the columns the clause reads. Defaults mirror a stub straight out of the
// create route: version 1, updated_by set, everything else empty/NULL.
function db(row = {}) {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE tn_rows (
    id TEXT PRIMARY KEY, book TEXT, version INTEGER, updated_by INTEGER,
    note TEXT, quote TEXT, support_reference TEXT, tags TEXT,
    occurrence INTEGER, trashed_at INTEGER, deleted_at INTEGER,
    preserve INTEGER DEFAULT 0, hint INTEGER DEFAULT 0, updated_at INTEGER
  )`);
  const r = {
    id: "fa9t", book: "JER", version: 1, updated_by: 30,
    note: "", quote: null, support_reference: null, tags: null,
    occurrence: null, trashed_at: null, deleted_at: null,
    preserve: 0, hint: 0, updated_at: 0,
    ...row,
  };
  d.prepare(
    `INSERT INTO tn_rows (id,book,version,updated_by,note,quote,support_reference,tags,
       occurrence,trashed_at,deleted_at,preserve,hint,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    r.id, r.book, r.version, r.updated_by, r.note, r.quote, r.support_reference,
    r.tags, r.occurrence, r.trashed_at, r.deleted_at, r.preserve, r.hint, r.updated_at,
  );
  return d;
}

// Run the guarded UPDATE exactly as setTnTrashed builds it (bookClause(4) is
// `AND book = ?4` when a book is supplied). Returns true if the trash landed.
function tryDiscard(d) {
  const res = d
    .prepare(
      `UPDATE tn_rows SET trashed_at = ?1, updated_at = ?2
        WHERE id = ?3 AND deleted_at IS NULL AND book = ?4${BLANK_STUB_CLAUSE}`,
    )
    .run(1785801457, 1785801457, "fa9t", "JER");
  return res.changes === 1;
}

// ── the rows this exists to remove ──
assert(tryDiscard(db()), "JER fa9t: app-created v1 stub with note '' → discarded");
assert(tryDiscard(db({ note: "   " })), "whitespace-only note → discarded");
assert(
  tryDiscard(db({ note: "\\n\\n" })),
  "TSV newline escapes only (literal backslash-n) → discarded",
);
assert(tryDiscard(db({ note: null })), "NULL note → discarded");
assert(
  tryDiscard(db({ note: "", quote: "  ", support_reference: "", tags: "" })),
  "all content fields blank-ish → discarded",
);

// ── the P1 race this precondition exists to stop ──
assert(
  !tryDiscard(db({ note: "A collaborator filled this in.", version: 2 })),
  "RACE: stub filled to v2 under us → refused (this is the whole point)",
);
assert(
  !tryDiscard(db({ note: "filled but still v1" })),
  "content present even at v1 → refused",
);
assert(
  !tryDiscard(db({ version: 2 })),
  "version moved past 1 → refused even while blank",
);

// ── the 11 genuine upstream empties must be untouchable ──
// 2CH 13:4 ai78, JER 52:28 l6dd, … : version 1, updated_by NULL, present on
// en_tn master. Deleting these would remove real upstream rows.
assert(
  !tryDiscard(db({ updated_by: null })),
  "upstream empty (updated_by NULL) → refused",
);

// ── explicit keep signals ──
assert(!tryDiscard(db({ preserve: 1 })), "preserve bit → refused");
assert(
  !tryDiscard(db({ hint: 1 })),
  "hint stub is intentionally empty (queued for AI) → refused",
);

// ── partial content that is easy to forget ──
assert(!tryDiscard(db({ quote: "בְּרֵאשִׁית" })), "saved quote, empty body → refused");
assert(
  !tryDiscard(db({ support_reference: "rc://*/ta/man/translate/figs-metaphor" })),
  "support reference chosen, empty body → refused",
);
assert(!tryDiscard(db({ tags: "figs-metaphor" })), "tags present → refused");
assert(!tryDiscard(db({ occurrence: 1 })), "occurrence present → refused");

// ── already-gone rows ──
assert(!tryDiscard(db({ trashed_at: 1785000000 })), "already trashed → refused");
assert(!tryDiscard(db({ deleted_at: 1785000000 })), "already tombstoned → refused");

// ── the clause must not match a different row or book ──
{
  const d = db();
  const res = d
    .prepare(
      `UPDATE tn_rows SET trashed_at = ?1, updated_at = ?2
        WHERE id = ?3 AND deleted_at IS NULL AND book = ?4${BLANK_STUB_CLAUSE}`,
    )
    .run(1, 1, "fa9t", "ECC");
  assert(res.changes === 0, "book mismatch → refused");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll blankStubTrash tests passed");
}
