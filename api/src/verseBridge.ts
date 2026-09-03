// Verse bridges — combining two adjacent verses into a `\v 1-2` block, and
// splitting one back apart. See verses.ts for the routes that drive these.
//
// A bridge is stored as ONE `verses` row: the start verse's row carries
// `verse_end` (migration 0022) and `content_json` holds the combined
// verseObjects; the interior verse rows do not exist. Import/export already
// round-trip `\v a-b` through this same shape (import-book.mjs, export.ts).
//
// This module is PURE — no `hono`, no `Env`, no `D1`. `api/src/*.test.mjs`
// runs under plain `node --experimental-strip-types`, which cannot resolve
// `hono` from node_modules (STATE.md: "A module that imports hono cannot be
// unit-tested"), so the merge/split math and the version-guarded SQL live here
// where verseBridge.test.mjs can exercise them against real SQLite, and the
// Hono route in verses.ts only wires them to the request. Same split as
// verseMergeConflictSql.ts + verseMergeConflicts.ts.

// The minimal shape this module needs off a verse row. Both VerseRow (server)
// and VerseDto (client) satisfy it, so callers pass whichever they hold.
export interface BridgeVerseRef {
  verse: number;
  verse_end: number | null;
}

// The inclusive end of a bridge (or the verse itself for a singleton).
export function verseRangeEnd(row: BridgeVerseRef): number {
  return row.verse_end ?? row.verse;
}

// True for a real multi-verse block (verse_end past the start). A row with
// verse_end == verse is a degenerate singleton and is NOT a bridge.
export function isBridge(row: BridgeVerseRef): boolean {
  return row.verse_end != null && row.verse_end > row.verse;
}

// The verse number the "next" row must start at for a merge-with-next. For a
// singleton verse V it is V+1; for a bridge V..E it is E+1 (extend the bridge).
export function expectedNextStart(start: BridgeVerseRef): number {
  return verseRangeEnd(start) + 1;
}

// The end the bridge gets after absorbing `next` — `next` may itself be a
// bridge (extending 1-2 by a 3-4 block yields 1-4).
export function computeBridgeEnd(next: BridgeVerseRef): number {
  return verseRangeEnd(next);
}

// Every integer verse the absorbed `next` row covered — the keys whose
// verse_statuses / verse_lane_checks orphan when its row is deleted, and the
// keys other tabs must prune on a `verse.bridged` broadcast.
export function absorbedVerseNumbers(next: BridgeVerseRef): number[] {
  const out: number[] = [];
  for (let v = next.verse; v <= verseRangeEnd(next); v++) out.push(v);
  return out;
}

// The new singleton verse numbers a split mints — every verse past the start.
// `[]` for a non-bridge (nothing to split).
export function splitVerseNumbers(bridge: BridgeVerseRef): number[] {
  const out: number[] = [];
  for (let v = bridge.verse + 1; v <= verseRangeEnd(bridge); v++) out.push(v);
  return out;
}

// The seed content for a verse a split emptied. NOT `[]`: an empty verseObjects
// array is refused for a real verse (refusesEmptyVerseObjects in contentJson.ts
// — "an empty tree would blank the verse text with no way to type it back"). A
// single trailing-newline text node is the minimal valid tree: it renders as an
// empty, editable cell and exports as a bare `\v N` with no body. Kept here as
// the single source of truth so the route and the tests agree.
export function splitSeedVerseObjects(): unknown[] {
  return [{ type: "text", text: "\n" }];
}

// True when a parsed content tree is the expected `{ verseObjects: [...] }`
// shape. A row whose content_json is valid JSON but NOT this shape (a bare
// array, a typo'd key) must never be bridged: verseObjectsOf would silently
// drop its content while BRIDGE_DELETE_NEXT_SQL still deletes the row. The merge
// route refuses when either side fails this, mirroring the corrupt-JSON refusal
// (which also never deletes). An empty `verseObjects: []` passes — that is a
// legal, in-shape tree with nothing to lose, not an off-shape row.
export function hasVerseObjectsArray(parsed: unknown): boolean {
  return Array.isArray((parsed as { verseObjects?: unknown } | null)?.verseObjects);
}

// Concatenate the start verse's objects with the next verse's, with a single
// space between so the two texts don't run together — the same separator
// verseRange.ts's concatSourceRange uses to join a source range for the
// aligner. Neither array is mutated. Occurrence renumbering across the combined
// verse is the caller's job (recomputeTargetOccurrences in the route), kept out
// of this pure module because it lives in importParsers.ts.
export function mergeVerseObjects(startVos: unknown[], nextVos: unknown[]): unknown[] {
  if (startVos.length === 0) return [...nextVos];
  if (nextVos.length === 0) return [...startVos];
  return [...startVos, { type: "text", text: " " }, ...nextVos];
}

// ---------------------------------------------------------------------------
// SQL for the two structural writes. Exported as constants so verseBridge.test.mjs
// can drive the EXACT `EXISTS` + `changes()` chaining against real SQLite — the
// same anti-drift reason verseMergeConflictSql.ts's statements are shared
// constants. A D1 batch is one transaction but does NOT roll back a statement
// that matches zero rows (only an error rolls the batch back), so two
// independent version-guarded writes could half-commit — a deleted verse-2 row
// with no bridge. The two writes below are made mutually atomic instead: the
// UPDATE carries BOTH version checks (its own on the start row, plus an EXISTS
// on the next row's version), and every following statement chains on
// `changes() > 0`, so the DELETE and the audit rows fire only when the UPDATE
// landed with both versions matched. This is the same pattern verses.ts's PATCH
// route already uses to seed its edit_log / resolve statements.
// ---------------------------------------------------------------------------

// MERGE statement 1 — rewrite the start row into the bridge, gated on BOTH the
// start row's version AND the next row still being at the version we read.
//
// Binds, in order: (contentJson, verseEnd, updatedAt, updatedBy,
// lastChangeAction, lastChangeSource, lastChangeActor, book, chapter, verse,
// bibleVersion, startVersion, nextVerse, nextVersion, plainText). plainText is
// the ?15 tail (appended rather than inserted so the version/EXISTS binds keep
// their numbers) — the joined plain_text search cache for the merged verse.
export const BRIDGE_UPDATE_START_SQL = `UPDATE verses
   SET content_json = ?1, verse_end = ?2, plain_text = ?15, version = version + 1,
       updated_at = ?3, updated_by = ?4,
       last_change_action = ?5, last_change_source = ?6, last_change_actor = ?7
 WHERE book = ?8 AND chapter = ?9 AND verse = ?10 AND bible_version = ?11
   AND version = ?12
   AND EXISTS (SELECT 1 FROM verses
                WHERE book = ?8 AND chapter = ?9 AND verse = ?13 AND bible_version = ?11
                  AND version = ?14)`;

// MERGE statement 2 — delete the absorbed row, only if statement 1 landed.
// Binds, in order: (book, chapter, nextVerse, bibleVersion).
export const BRIDGE_DELETE_NEXT_SQL = `DELETE FROM verses
  WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4
    AND changes() > 0`;

// SPLIT statement 1 — de-bridge the start row (drop verse_end, keep all
// content), gated on its version and on it actually being a bridge.
//
// Binds, in order: (updatedAt, updatedBy, lastChangeAction, lastChangeSource,
// lastChangeActor, book, chapter, verse, bibleVersion, expectedVersion).
export const SPLIT_UPDATE_START_SQL = `UPDATE verses
   SET verse_end = NULL, version = version + 1,
       updated_at = ?1, updated_by = ?2,
       last_change_action = ?3, last_change_source = ?4, last_change_actor = ?5
 WHERE book = ?6 AND chapter = ?7 AND verse = ?8 AND bible_version = ?9
   AND version = ?10 AND verse_end IS NOT NULL AND verse_end > verse`;

// SPLIT — insert ALL the seeded singleton verses in ONE statement, only if the
// preceding statement in the batch landed (so a lost CAS inserts nothing).
//
// A recursive CTE generates the verse numbers (startVerse+1 .. verseEnd) so the
// statement count and bound-param count are FIXED regardless of how many verses
// the bridge spans. This matters: the old one-INSERT-per-verse shape put
// 2 + 2*(N-1) statements in the split batch, and D1 caps a batch at 100
// statements / 100 params each — so splitting a bridge of 51+ verses (reachable
// by repeatedly extending a bridge, or by an imported long bridge) overflowed
// the batch and failed. Two fixed multi-row INSERTs keep the whole split at
// exactly four statements, preserving the atomic all-or-nothing guarantee.
//
// The recreated verse's `version` is NOT a literal 1. A bridge→split cycle
// re-mints a deleted verse's primary key, and a stale outbox PATCH still holding
// a pre-bridge `If-Match` for that verse would pass the numeric CAS against a
// fresh version=1 row and silently overwrite the seed with stale text. Start
// each recreated verse ABOVE both (a) the highest version it ever reached in
// edit_log and (b) the bridge row's current version (?12) — so any stale
// If-Match a client could hold is strictly less than the new version and its CAS
// fails with a 409 instead. The CAST mirrors the row_key format stored elsewhere
// (a REAL-bound integer would concatenate as "5.0" and never match).
//
// Binds, in order: (book, chapter, bibleVersion, contentJson, updatedAt,
// updatedBy, startVerse, verseEnd, lastChangeAction, lastChangeSource,
// lastChangeActor, bridgeVersion).
export const SPLIT_INSERT_VERSES_RANGE_SQL = `INSERT INTO verses
     (book, chapter, verse, verse_end, bible_version, content_json, plain_text,
      version, updated_at, updated_by, last_change_action, last_change_source, last_change_actor)
   WITH RECURSIVE split_seq(v) AS (
     SELECT ?7 + 1
     UNION ALL SELECT v + 1 FROM split_seq WHERE v + 1 <= ?8
   )
   SELECT ?1, ?2, v, NULL, ?3, ?4, NULL,
     MAX(
       COALESCE((SELECT MAX(new_version) FROM edit_log
                  WHERE kind = 'verse'
                    AND row_key = ?1 || '/' || CAST(?2 AS INTEGER) || '/' || CAST(v AS INTEGER) || '/' || ?3), 0),
       ?12
     ) + 1,
     ?5, ?6, ?9, ?10, ?11
     FROM split_seq
    WHERE changes() > 0`;

// SPLIT — the matching 'create' audit rows for the seeded verses, again in one
// CTE-driven statement, chained on the verse INSERT above having landed.
// row_key is `book/chapter/verse/bibleVersion`, built in SQL from the seq.
//
// Binds, in order: (book, chapter, bibleVersion, startVerse, verseEnd, userId,
// payloadJson).
// row_key must read `book/chapter/verse/bibleVersion` — the canonical form used
// everywhere else (verseHistory, the merge route's JS-built keys). CAST chapter
// and v to INTEGER before concatenating: SQLite string `||` renders a REAL-bound
// number as "5.0", and drivers (node:sqlite, and D1 for a JS number) bind
// integers as REAL — so without the CAST the key would be `book/5.0/2.0/bv` and
// never match a lookup. The verse COLUMN is unaffected (INTEGER affinity coerces
// on insert); only this text concatenation needs the cast.
export const SPLIT_INSERT_EDITLOG_RANGE_SQL = `INSERT INTO edit_log
     (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
   WITH RECURSIVE split_seq(v) AS (
     SELECT ?4 + 1
     UNION ALL SELECT v + 1 FROM split_seq WHERE v + 1 <= ?5
   )
   SELECT 'verse', ?1 || '/' || CAST(?2 AS INTEGER) || '/' || CAST(v AS INTEGER) || '/' || ?3, ?1, ?6, NULL, 1, 'create', ?7
     FROM split_seq
    WHERE changes() > 0`;

// Delete the orphaned per-verse checkoff/status for a contiguous absorbed range
// [fromVerse, toVerse]. Run POST-CONFIRM (after the merge UPDATE is known to
// have landed), NOT chained in the merge batch: these can legitimately match
// zero rows (the verse was never checked), which would break a `changes() > 0`
// chain for any statement after them. Best-effort cleanup — a surviving status
// row keyed at a now-absent verse is simply unused until (and unless) the
// bridge is split again.
//
// Binds, in order: (book, chapter, fromVerse, toVerse).
export const DELETE_VERSE_STATUSES_RANGE_SQL = `DELETE FROM verse_statuses
  WHERE book = ?1 AND chapter = ?2 AND verse >= ?3 AND verse <= ?4`;

// Binds, in order: (book, chapter, fromVerse, toVerse).
export const DELETE_VERSE_LANE_CHECKS_RANGE_SQL = `DELETE FROM verse_lane_checks
  WHERE book = ?1 AND chapter = ?2 AND verse >= ?3 AND verse <= ?4`;
