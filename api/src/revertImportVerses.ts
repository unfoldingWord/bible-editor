// ── Verse revert report after D1 imported master's current file (#1439) ───
//
// The ULT/UST half of export.ts's partitionTsvRevertEntriesByImport (#1419).
// The false alarm: a person commits a verse on master, the nightly reimport
// takes it into D1, a translator then edits the verse in Bible Editor, and the
// export's revert report calls that edit a Door43 overwrite, because the
// person's commit put the verse in the lineage's humanRefs and
// partitionRevertEntriesByLineage (#1231) keeps it in attention.
//
// Evidence, all of it required (any gap keeps the verse in attention):
//   1. File level: export.ts's importedHeadUnusableReason. D1's last sync is a
//      clean reimport of the very master commit the report diffs against, so
//      master has not moved since the import read it.
//   2. Verse level: D1's own verse as of the import (the newest edit_log row
//      for the verse at or before synced_at, loadPreImportVerses) is master's
//      verse exactly as extractVersesForRange reads it from master's file,
//      compared EXACTLY: no whitespace, occurrence or NFC mask, because a
//      looser compare here only moves verses toward quiet. A pristine write
//      or create stores exactly that. An adoption over an edited verse stores
//      it after canonizeAlignmentSource (applyVerseRows step 6), which is NOT
//      reproduced (review A1): canonize can fold a Door43 person's
//      x-lemma / x-content fix back to D1's stale UHB bytes, so such a verse
//      stays loud unless canonize changed nothing.
//   3. No verse_merge_conflicts row for the verse, of any action, that is
//      unresolved or was recorded around this import (reviews A2, B1: loadVerseConflictRefs).
// Together: D1 held master's verse as imported and master has not moved
// since, so whatever the render now changes there was edited in Bible Editor
// after the import. The verse is labelled probably ours (still recorded in
// export_reverts, #1231 option B).
//
// Stays loud by construction, measured in revertImportVersePayloadShape.test.mjs:
//   - a kept verse (keep_ai_master, keep_no_base, alignment refused, a
//     source_attr_divergent flag): the import writes no row, so the newest
//     pre-import row is D1's own wording;
//   - a source-attribute reconcile: it logs a dcs_reimport 'update' with the
//     same payload keys as an adoption, but its content is the translator's
//     wording with master's source attributes, which is not master's verse
//     (#1090: source and shape cannot tell the two apart; content can);
//   - an app edit, AI write, restore, heal or repair script logged at or
//     before synced_at (any action but create/update is no evidence);
//   - a verse master bridges, or a bridged verse in the report (`3:6-9`):
//     reimport payloads mostly carry no verse_end, so the key alone cannot
//     prove which rows D1 held;
//   - a master verse carrying U+FFFD (the import healed it first), or an
//     adoption whose canonize step changed bytes (measured with Door43's own
//     UHB on the sample files: 0 of 21 OBA verses, 31-32 of 211 ZEC verses).
//
// Retention: the hourly sweep (editLogSweep.ts) deletes verse rows older than
// EDIT_LOG_RETENTION_SECONDS except a few exempt survivors per verse, so an
// aged row may be the survivor of a swept later write. As for tq/twl
// (export.ts loadPreImportTsvRows), a picked row within a day of the cutoff,
// or older, is no evidence.
//
// Known limit, shared by every edit_log reader: a content write that logs
// nothing (a script, a manual SQL fix) is invisible here.
import { extractVersesForRange } from "./importParsers.ts";
import { verseContentJsonFromPayload } from "./verseHistory.ts";
import { EDIT_LOG_RETENTION_SECONDS } from "./editLogSweep.ts";

const PLAIN_REF = /^(\d+):(\d+)$/;
function verseObjectsJson(contentJson: string | null): string | null {
  if (contentJson == null) return null;
  try {
    const vo = (JSON.parse(contentJson) as { verseObjects?: unknown }).verseObjects;
    return Array.isArray(vo) ? JSON.stringify(vo) : null;
  } catch {
    return null;
  }
}

// Master's plain (unbridged) verses as the reimport would store them, keyed
// `chapter:verse` like verseTextByRef: the verseObjects JSON
// extractVersesForRange produces from master's file. A verse that appears
// twice, or that a bridge in the same chapter also covers, is left out (stays
// loud). Null when master does not parse.
export function masterVersesAsImported(masterUsfm: string): Map<string, string> | null {
  let verses;
  try {
    verses = extractVersesForRange(masterUsfm, 0, 999);
  } catch {
    return null;
  }
  const out = new Map<string, string>();
  // usfm-js keeps the first of two `\v N` markers in a chapter and silently
  // drops the second (and what follows it), so a doubled key is found by
  // scanning the raw markers, as export.ts's usfmVerseSpans does.
  const drop = new Set<string>();
  const seen = new Set<string>();
  let chapter: string | null = null;
  for (const m of masterUsfm.matchAll(/\\([cv])\s+(\d+)(?:-\d+)?(?=\s)/g)) {
    if (m[1] === "c") chapter = String(Number(m[2]));
    else if (chapter !== null) {
      const ref = `${chapter}:${Number(m[2])}`;
      if (seen.has(ref)) drop.add(ref);
      seen.add(ref);
    }
  }
  const bridges = verses.filter((v) => v.verseEnd != null && v.verseEnd > v.verse);
  for (const v of verses) {
    if (v.verse < 1 || v.verseEnd != null) continue;
    const ref = `${v.chapter}:${v.verse}`;
    if (out.has(ref) || bridges.some((b) => b.chapter === v.chapter && b.verse <= v.verse && v.verse <= (b.verseEnd as number))) {
      drop.add(ref);
    }
    const json = verseObjectsJson(v.contentJson);
    if (json === null) drop.add(ref);
    else out.set(ref, json);
  }
  for (const ref of drop) out.delete(ref);
  return out;
}

// True when D1's pre-import verse is master's verse exactly as extracted from
// master's file. Deliberately NOT the extract after the adoption's
// canonizeAlignmentSource step (review A1): canonize can fold a Door43
// person's x-lemma / x-content fix back to D1's (possibly stale) UHB bytes, so
// "D1 held canonize(master)" does not mean D1 held master's verse, and the
// export would then revert that fix. An adoption whose canonize changed
// nothing stores the raw extract and still matches; one it changed stays loud.
export function preImportVerseMatchesMaster(
  preImport: string | null | undefined,
  masterAsImported: string | undefined,
): boolean {
  return typeof preImport === "string" && typeof masterAsImported === "string" && preImport === masterAsImported;
}

export function partitionUsfmRevertEntriesByImport<E extends { ref: string }>(
  entries: E[],
  masterAsImported: ReadonlyMap<string, string> | null,
  preImport: ReadonlyMap<string, string | null>,
  // Refs with a verse_merge_conflicts row from this import or still unresolved (loadVerseConflictRefs).
  openConflicts: ReadonlySet<string>,
): { attention: E[]; probablyOurs: E[] } {
  if (masterAsImported === null) return { attention: entries, probablyOurs: [] };
  const ours = (e: E): boolean =>
    typeof e.ref === "string" &&
    PLAIN_REF.test(e.ref) &&
    !openConflicts.has(e.ref) &&
    preImportVerseMatchesMaster(preImport.get(e.ref), masterAsImported.get(e.ref));
  // Decided per ref (export_reverts is unique on book, resource, ref).
  const loudRefs = new Set(entries.filter((e) => !ours(e)).map((e) => e.ref));
  const attention: E[] = [];
  const probablyOurs: E[] = [];
  for (const e of entries) (loudRefs.has(e.ref) ? attention : probablyOurs).push(e);
  return { attention, probablyOurs };
}

// D1's own verse as of the import, per plain `chapter:verse` ref: the
// verseObjects JSON of the newest edit_log row (by id, any action, any source)
// at or before `syncedAt`, or null when that row is not a create/update with a
// parseable content payload, or is within a day of the sweep's cutoff. Refs
// with no such row are absent. `book IS NULL` rows (pre-0017) count too: the
// row_key names the book, and leaving a newer row out could only pick an
// older one. Chunked under D1's 100-parameter limit.
const PRE_IMPORT_CHUNK = 90;
export async function loadPreImportVerses(
  db: D1Database,
  book: string,
  bibleVersion: "ULT" | "UST",
  refs: string[],
  syncedAt: number,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<Map<string, string | null>> {
  const sweepFloor = nowS - EDIT_LOG_RETENTION_SECONDS + 86400;
  const keyToRef = new Map<string, string>();
  for (const ref of new Set(refs)) {
    const m = PLAIN_REF.exec(ref);
    if (m) keyToRef.set(`${book}/${Number(m[1])}/${Number(m[2])}/${bibleVersion}`, ref);
  }
  const keys = [...keyToRef.keys()];
  const out = new Map<string, string | null>();
  for (let i = 0; i < keys.length; i += PRE_IMPORT_CHUNK) {
    const chunk = keys.slice(i, i + PRE_IMPORT_CHUNK);
    const marks = chunk.map((_, j) => `?${j + 3}`).join(", ");
    const { results } = await db
      .prepare(
        `SELECT e.row_key, e.action, e.payload_json, e.created_at
           FROM edit_log e
          WHERE e.kind = 'verse' AND e.row_key IN (${marks}) AND (e.book = ?1 OR e.book IS NULL)
            AND e.id = (SELECT MAX(x.id) FROM edit_log x
                         WHERE x.kind = 'verse' AND x.row_key = e.row_key
                           AND (x.book = ?1 OR x.book IS NULL) AND x.created_at <= ?2)`,
      )
      .bind(book, syncedAt, ...chunk)
      .all<{ row_key: string; action: string; payload_json: string | null; created_at: number }>();
    for (const r of results ?? []) {
      const ref = keyToRef.get(r.row_key);
      if (ref === undefined) continue;
      const usable = Number(r.created_at) >= sweepFloor && (r.action === "create" || r.action === "update");
      out.set(ref, usable ? verseObjectsJson(verseContentJsonFromPayload(r.payload_json)) : null);
    }
  }
  return out;
}

// The plain refs among `refs` that have a verse_merge_conflicts row for this
// book and resource, of ANY action, that is still unresolved, or was recorded
// at or after `recordedSince`, or was resolved at or after it (reviews A2, B1,
// C1). Such
// a verse stays loud: after an adopt_conflict, a translator restoring or
// re-typing their overwritten text reverts the Door43 author's commit, and the
// payload test alone would call that ours; a kept source_attr_divergent /
// keep_alignment_refused / keep_local_structure verse means D1 did not take
// master's verse. A clean 'adopt' row counts too (stay loud when in doubt), so
// only verses the import wrote with no recorded merge decision (a pristine
// write or a create) can go quiet.
//
// Why resolved rows count (B1): any app save of a verse resolves its row in
// the same batch (verses.ts, RESOLVE_VERSE_MERGE_CONFLICT_SQL), so by export
// time the very edit that reverts the Door43 commit has resolved the flag.
// No column names the run that wrote a row; `last_recorded_at` is the time of
// the latest reimport write to it (detected_at for rows from before migration
// 0049), and a save's resolve does not touch it. The caller passes a bound no
// later than the import (see exportWorkflow.ts).
//
// Why a row resolved since the bound counts (C1): an adopt_conflict recorded
// by an EARLIER import can stay unresolved across our next confirmed push and
// a later import; the translator's save after that import then resolves it,
// and its last_recorded_at is older than the bound. resolved_at is unix
// seconds, like the bound (verses.ts binds Math.floor(Date.now() / 1000);
// the reimport's resolves use unixepoch()).
//
// Read per chapter, chunked under D1's 100-parameter limit; a failed read
// throws, and the caller then keeps every verse in attention.
export async function loadVerseConflictRefs(
  db: D1Database,
  book: string,
  resource: "ult" | "ust",
  refs: string[],
  recordedSince: number,
): Promise<Set<string>> {
  const chapters = [...new Set(refs.flatMap((r) => (PLAIN_REF.test(r) ? [Number(r.split(":")[0])] : [])))];
  const wanted = new Set(refs);
  const out = new Set<string>();
  for (let i = 0; i < chapters.length; i += PRE_IMPORT_CHUNK) {
    const chunk = chapters.slice(i, i + PRE_IMPORT_CHUNK);
    const marks = chunk.map((_, j) => `?${j + 4}`).join(", ");
    const { results } = await db
      .prepare(
        `SELECT chapter, verse FROM verse_merge_conflicts
          WHERE book = ?1 AND resource = ?2 AND chapter IN (${marks})
            AND (resolved_at IS NULL OR COALESCE(last_recorded_at, detected_at) >= ?3 OR resolved_at >= ?3)`,
      )
      .bind(book, resource, recordedSince, ...chunk)
      .all<{ chapter: number; verse: number }>();
    for (const r of results ?? []) {
      const ref = `${r.chapter}:${r.verse}`;
      if (wanted.has(ref)) out.add(ref);
    }
  }
  return out;
}
