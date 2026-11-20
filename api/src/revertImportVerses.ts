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
//      verse exactly as the import stores it. The import stores
//      extractVersesForRange's output for master's file, byte for byte on a
//      pristine write or create, and after canonizeAlignmentSource (the \zaln
//      source words rewritten to the UHB/UGNT bytes) on an adoption over an
//      edited verse (bookReimport.ts applyVerseRows step 6). Both are
//      reproduced here and compared EXACTLY: no whitespace, occurrence or NFC
//      mask, because a looser compare here only moves verses toward quiet.
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
//   - a master verse carrying U+FFFD (the import healed it first) or a UHB row
//     that changed since the import (canonize would differ).
//
// Retention: the hourly sweep (editLogSweep.ts) deletes verse rows older than
// EDIT_LOG_RETENTION_SECONDS except a few exempt survivors per verse, so an
// aged row may be the survivor of a swept later write. As for tq/twl
// (export.ts loadPreImportTsvRows), a picked row within a day of the cutoff,
// or older, is no evidence.
//
// Known limit, shared by every edit_log reader: a content write that logs
// nothing (a script, a manual SQL fix) is invisible here.
import { collectSourceWords, extractVersesForRange, type SourceWord } from "./importParsers.ts";
import { canonizeAlignmentSource } from "./canonizeHebrew.ts";
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

// True when D1's pre-import verse is master's verse as the import stores it:
// the raw extract (pristine write, create), or the extract after the
// adoption's canonize step against the source words D1 holds for the verse.
export function preImportVerseMatchesMaster(
  preImport: string | null | undefined,
  masterAsImported: string | undefined,
  sourceWords: readonly SourceWord[] | undefined,
): boolean {
  if (typeof preImport !== "string" || typeof masterAsImported !== "string") return false;
  if (preImport === masterAsImported) return true;
  if (!sourceWords || sourceWords.length === 0) return false;
  const vo = JSON.parse(masterAsImported) as unknown[];
  if (canonizeAlignmentSource(vo, [...sourceWords]) === 0) return false;
  return preImport === JSON.stringify(vo);
}

export function partitionUsfmRevertEntriesByImport<E extends { ref: string }>(
  entries: E[],
  masterAsImported: ReadonlyMap<string, string> | null,
  preImport: ReadonlyMap<string, string | null>,
  sourceWords: ReadonlyMap<string, SourceWord[]>,
): { attention: E[]; probablyOurs: E[] } {
  if (masterAsImported === null) return { attention: entries, probablyOurs: [] };
  const ours = (e: E): boolean =>
    typeof e.ref === "string" &&
    PLAIN_REF.test(e.ref) &&
    preImportVerseMatchesMaster(preImport.get(e.ref), masterAsImported.get(e.ref), sourceWords.get(e.ref));
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

// The UHB (OT) / UGNT (NT) words D1 holds for each plain ref, as
// applyVerseRows step 6 reads them for canonizeAlignmentSource. Refs whose
// source row is missing or unparseable are absent (no canonized variant).
export async function loadSourceWordsForRefs(
  db: D1Database,
  book: string,
  sourceVersion: "UHB" | "UGNT",
  refs: string[],
): Promise<Map<string, SourceWord[]>> {
  const chapters = [...new Set(refs.flatMap((r) => (PLAIN_REF.test(r) ? [Number(r.split(":")[0])] : [])))];
  const out = new Map<string, SourceWord[]>();
  if (chapters.length === 0) return out;
  const wanted = new Set(refs);
  const marks = chapters.map((_, i) => `?${i + 3}`).join(", ");
  const { results } = await db
    .prepare(`SELECT chapter, verse, content_json FROM verses WHERE book = ?1 AND bible_version = ?2 AND chapter IN (${marks})`)
    .bind(book, sourceVersion, ...chapters)
    .all<{ chapter: number; verse: number; content_json: string }>();
  for (const r of results ?? []) {
    const ref = `${r.chapter}:${r.verse}`;
    if (!wanted.has(ref)) continue;
    const vo = verseObjectsJson(r.content_json);
    if (vo !== null) out.set(ref, collectSourceWords(JSON.parse(vo) as unknown[]));
  }
  return out;
}
