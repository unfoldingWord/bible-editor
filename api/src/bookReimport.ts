// Non-destructive per-chapter, per-resource re-import from Door43.
//
// The bootstrap path (bookImport.ts) wipes the book and re-inserts. This
// module is the maintenance lane: pull fresh content from DCS for selected
// chapters / resources without clobbering rows a translator has edited.
//
// Don't-clobber rule (canonical): a row is "safe to overwrite" iff it has
// never been touched by a human. The signal is the same predicate the AI
// pipeline sweep uses in pipelineImport.ts deleteUnkeptTns:
//   tn:  updated_by IS NULL AND deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0
//   tq:  updated_by IS NULL AND deleted_at IS NULL
//   twl: updated_by IS NULL AND deleted_at IS NULL
// (trashed_at: a note pending deletion is never overwritten/resurrected by a
// reimport — it's promoted to a deleted_at tombstone by the nightly job.)
// For verses (which don't have preserve/hint) we use updated_by IS NULL.
// Edited rows are SKIPPED, not merged or warned about.
//
// v1 limitation: a verse that the AI pipeline wrote (sets updated_by to the
// pipeline-starter's id) is treated as "edited" and skipped here. A future
// pass could distinguish "AI-touched, never human-touched" by inspecting
// edit_log.source, but the simple predicate is enough for the transition
// use case this module was built for.
//
// Concurrency:
//   - book_import_locks is reused (per-book serialization). A second caller
//     gets 409 in_progress.
//   - Active AI pipelines on a chapter cause that chapter to be skipped
//     (counted as skipped_locked) — the AI run would overwrite us anyway.
//   - The UPDATE-WHERE-pristine predicate is the real race guard: if a user
//     edits mid-import, their PATCH bumps updated_by and our UPDATE matches
//     0 rows. No SELECT-then-UPDATE window.

import type { Env } from "./index";
import type { WorkflowStep } from "cloudflare:workers";
import { dcsUrls, dcsResourceFile, dcsRawUrl, fileCommitSha, fetchText } from "./dcsSources";
import {
  extractVersesForRange,
  parseTsv,
  refParts,
  type VerseExtract,
} from "./importParsers";
import { activePipelineForChapter } from "./chapterLock";
import { placeSortOrder } from "./sortOrder";

export type Resource = "ult" | "ust" | "tn" | "tq" | "twl";

export const ALL_RESOURCES: readonly Resource[] = ["ult", "ust", "tn", "tq", "twl"];

// Chapters per Workflow step in the chunked reimport. Sized so even the largest
// book (Psalms, 150 ch) stays well under Cloudflare's 600 000 ms per-step limit
// that the old whole-book reimport blew on Isaiah. In steady state the
// per-resource SHA gate skips unchanged files entirely, so this rarely bites.
export const REIMPORT_CHAPTER_CHUNK = 8;

// Max statements per env.DB.batch() write. D1 caps a batch at 100 statements;
// stay well under so a batch is always a single subrequest. Each changed row is
// one write statement here (audit rows go in a separate follow-up batch).
const WRITE_BATCH = 90;

export interface ReimportCounts {
  updated: number;
  inserted: number;
  skipped_edited: number;
  skipped_locked: number;
  skipped_noop: number;
  dcs_404: number;
  errors: string[];
}

export interface ReimportResult {
  book: string;
  perResource: Record<Resource, ReimportCounts>;
  totals: ReimportCounts;
}

const REIMPORT_SOURCE = "dcs_reimport";

function zeroCounts(): ReimportCounts {
  return {
    updated: 0,
    inserted: 0,
    skipped_edited: 0,
    skipped_locked: 0,
    skipped_noop: 0,
    dcs_404: 0,
    errors: [],
  };
}

function addCounts(into: ReimportCounts, from: ReimportCounts): void {
  into.updated += from.updated;
  into.inserted += from.inserted;
  into.skipped_edited += from.skipped_edited;
  into.skipped_locked += from.skipped_locked;
  into.skipped_noop += from.skipped_noop;
  into.dcs_404 += from.dcs_404;
  if (from.errors.length) into.errors.push(...from.errors);
}

export class BookNotImportedError extends Error {
  constructor(public book: string) {
    super(`book not imported: ${book}`);
  }
}

export class ImportInProgressError extends Error {
  constructor(public book: string) {
    super(`import in progress for ${book}`);
  }
}

export async function reimportBookFromDcs(
  env: Env,
  book: string,
  chapters: number[],
  resources: Resource[],
  userId: number | null,
  _opts: { source: "user" | "cron" },
): Promise<ReimportResult> {
  const urls = dcsUrls(env, book);
  if (!urls) throw new Error(`unknown book: ${book}`);

  // Re-import is the maintenance lane — book must already be bootstrapped.
  // The first-time path (bookImport.ts POST /:book/import) handles the
  // wipe-and-load case; re-running it post-edits would clobber everything.
  const imported = await env.DB.prepare(
    `SELECT 1 FROM book_imports WHERE book = ?1`,
  )
    .bind(book)
    .first();
  if (!imported) throw new BookNotImportedError(book);

  // Reuse the per-book lock (same table the first-time import uses + the
  // */5 stale sweep cleans up). A second concurrent re-import on the same
  // book gets a 409 from the caller. A first-time import racing a re-import
  // on the same book is also blocked — that's the safe answer.
  const startedAt = Math.floor(Date.now() / 1000);
  const lock = await env.DB.prepare(
    `INSERT OR IGNORE INTO book_import_locks (book, started_at, started_by)
     VALUES (?1, ?2, ?3)`,
  )
    .bind(book, startedAt, userId)
    .run();
  if (!lock.meta.changes) throw new ImportInProgressError(book);

  try {
    return await runReimport(env, book, chapters, resources, userId);
  } finally {
    await env.DB.prepare(`DELETE FROM book_import_locks WHERE book = ?1`)
      .bind(book)
      .run();
  }
}

async function runReimport(
  env: Env,
  book: string,
  chapters: number[],
  resources: Resource[],
  userId: number | null,
): Promise<ReimportResult> {
  const urls = dcsUrls(env, book)!;

  // Fetch each requested resource once at the book level. ULT/UST/TN/TQ/TWL
  // are whole-book files; chapter filtering happens after parse.
  const want = new Set(resources);
  const [ultRaw, ustRaw, tnRaw, tqRaw, twlRaw] = await Promise.all([
    want.has("ult") ? fetchText(urls.ult) : Promise.resolve(null),
    want.has("ust") ? fetchText(urls.ust) : Promise.resolve(null),
    want.has("tn") ? fetchText(urls.tn) : Promise.resolve(null),
    want.has("tq") ? fetchText(urls.tq) : Promise.resolve(null),
    want.has("twl") ? fetchText(urls.twl) : Promise.resolve(null),
  ]);

  const perResource: Record<Resource, ReimportCounts> = {
    ult: zeroCounts(),
    ust: zeroCounts(),
    tn: zeroCounts(),
    tq: zeroCounts(),
    twl: zeroCounts(),
  };
  const totals = zeroCounts();

  // Mark DCS-missing resources up front (one 404 per requested resource,
  // not per chapter). If a resource wasn't requested, leave counts at zero.
  if (want.has("ult") && !ultRaw) perResource.ult.dcs_404++;
  if (want.has("ust") && !ustRaw) perResource.ust.dcs_404++;
  if (want.has("tn") && !tnRaw) perResource.tn.dcs_404++;
  if (want.has("tq") && !tqRaw) perResource.tq.dcs_404++;
  if (want.has("twl") && !twlRaw) perResource.twl.dcs_404++;

  for (const chapter of chapters) {
    const lock = await activePipelineForChapter(env, book, chapter);
    if (lock) {
      for (const r of resources) perResource[r].skipped_locked++;
      continue;
    }

    if (want.has("tn") && tnRaw) {
      const c = await reimportTsvForChapter(env, book, chapter, tnRaw, "tn", userId);
      addCounts(perResource.tn, c);
    }
    if (want.has("tq") && tqRaw) {
      const c = await reimportTsvForChapter(env, book, chapter, tqRaw, "tq", userId);
      addCounts(perResource.tq, c);
    }
    if (want.has("twl") && twlRaw) {
      const c = await reimportTsvForChapter(env, book, chapter, twlRaw, "twl", userId);
      addCounts(perResource.twl, c);
    }
    if (want.has("ult") && ultRaw) {
      const c = await reimportVersesForChapter(env, book, chapter, ultRaw, "ULT", userId);
      addCounts(perResource.ult, c);
    }
    if (want.has("ust") && ustRaw) {
      const c = await reimportVersesForChapter(env, book, chapter, ustRaw, "UST", userId);
      addCounts(perResource.ust, c);
    }
  }

  for (const r of resources) addCounts(totals, perResource[r]);

  return { book, perResource, totals };
}

// ── TSV resources (tn / tq / twl) ──────────────────────────────────────────

type TsvKind = "tn" | "tq" | "twl";

// Canonical "never touched by a human" predicate (see module header). Shared
// by the update path, the chapter diff gate, and the removed-on-master soft
// delete so the three can never disagree on what is safe to overwrite.
function tsvPristinePredicate(kind: TsvKind): string {
  return kind === "tn"
    ? `updated_by IS NULL AND deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0`
    : `updated_by IS NULL AND deleted_at IS NULL`;
}

interface ParsedTsvRow {
  id: string;
  refRaw: string;
  chapter: number;
  verse: number;
  occurrence: number | null;
  tags: string | null;
  // tn-specific
  support_reference?: string | null;
  quote?: string | null;
  note?: string | null;
  // tq-specific
  question?: string | null;
  response?: string | null;
  // twl-specific
  orig_words?: string | null;
  tw_link?: string | null;
}

// Normalize one raw TSV record into a ParsedTsvRow (no chapter filter). Shared
// by rowsForChapter (the reimport row loop) and changedTsvChapters (the diff
// gate) so the two agree exactly on field normalization — otherwise the gate
// could mis-classify a chapter as unchanged. Returns null for a row with no ID.
function parseTsvRow(r: Record<string, string>, kind: TsvKind): ParsedTsvRow | null {
  const id = r["ID"];
  if (!id) return null;
  const refRaw = r["Reference"] ?? "";
  const [ch, v] = refParts(refRaw);
  const occRaw = r["Occurrence"];
  const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
  const base: ParsedTsvRow = {
    id,
    refRaw,
    chapter: ch,
    verse: v,
    occurrence,
    tags: r["Tags"] || null,
  };
  if (kind === "tn") {
    base.support_reference = r["SupportReference"] || null;
    base.quote = r["Quote"] || null;
    base.note = r["Note"] || null;
  } else if (kind === "tq") {
    base.quote = r["Quote"] || null;
    base.question = r["Question"] || null;
    base.response = r["Response"] || null;
  } else {
    base.orig_words = r["OrigWords"] || null;
    base.tw_link = r["TWLink"] || null;
  }
  return base;
}

function rowsForChapter(raw: string, kind: TsvKind, chapter: number): ParsedTsvRow[] {
  const { rows } = parseTsv(raw);
  const out: ParsedTsvRow[] = [];
  for (const r of rows) {
    const parsed = parseTsvRow(r, kind);
    if (!parsed || parsed.chapter !== chapter) continue;
    out.push(parsed);
  }
  return out;
}

// Thin per-chapter wrapper for the HTTP reimport route; applyTsvRows does the
// hoist-read + batched-write work for whatever rows it's handed.
async function reimportTsvForChapter(
  env: Env,
  book: string,
  chapter: number,
  raw: string,
  kind: TsvKind,
  userId: number | null,
): Promise<ReimportCounts> {
  return applyTsvRows(env, book, kind, rowsForChapter(raw, kind, chapter), userId);
}

// Upsert over already-parsed TSV rows (any chapters). Split out so the chunked
// path can parse a staged file ONCE and feed pre-grouped rows rather than
// re-parsing the whole file per chapter.
//
// Subrequest-frugal like applyVerseRows: hoist one read (by id — a row may have
// moved chapters), classify in memory, batch the writes. New rows keep the
// proven per-row insert + file-position sort_order placement (they're rare and
// midpointSortOrder chains off the preceding just-placed row). Updates batch a
// CAS UPDATE (the full pristine predicate AND `version = <read version>`) so a
// translator edit between read and write flips the row to skipped, never
// clobbered — identical guarantee to the old per-row predicate, now race-safe.
async function applyTsvRows(
  env: Env,
  book: string,
  kind: TsvKind,
  incoming: ParsedTsvRow[],
  userId: number | null,
): Promise<ReimportCounts> {
  const counts = zeroCounts();
  if (incoming.length === 0) return counts;
  const now = Math.floor(Date.now() / 1000);

  // Read the comparable columns PLUS the pristine-predicate columns in one
  // (chunked) query so noop / edited / update classification is all in memory.
  const pristineCols = kind === "tn"
    ? "version, updated_by, deleted_at, trashed_at, preserve, hint"
    : "version, updated_by, deleted_at";
  const existing = new Map<string, Record<string, unknown>>();
  const ids = incoming.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 90) {
    const slice = ids.slice(i, i + 90);
    const inClause = slice.map((_, j) => `?${j + 2}`).join(",");
    const rs = await env.DB.prepare(
      `SELECT id, ${TSV_STORED_COLS[kind]}, ${pristineCols}
         FROM ${kind}_rows WHERE book = ?1 AND id IN (${inClause})`,
    )
      .bind(book, ...slice)
      .all<Record<string, unknown>>();
    for (const row of rs.results) existing.set(String(row.id), row);
  }

  const updates: Array<{ row: ParsedTsvRow; oldVersion: number }> = [];
  for (let i = 0; i < incoming.length; i++) {
    const row = incoming[i];
    const cur = existing.get(row.id);
    if (!cur) {
      // DCS-new row: place it where the file orders it. Export sorting is
      // `chapter, verse, sort_order ASC NULLS LAST, id`, so a NULL sort_order
      // would dump the row at the end of its verse regardless of file position.
      try {
        const inserted = await tryInsertTsvRow(env, book, kind, row);
        if (inserted) {
          counts.inserted++;
          const so = await midpointSortOrder(env, book, kind, incoming, i);
          await env.DB.prepare(
            `UPDATE ${kind}_rows SET sort_order = ?1 WHERE id = ?2 AND book = ?3`,
          )
            .bind(so, row.id, book)
            .run();
          await logEdit(env, kind, row.id, book, userId, null, 1, "create", row);
        } else {
          counts.skipped_noop++; // raced — appeared concurrently
        }
      } catch (e) {
        counts.errors.push(`${kind} ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    // Exists — short-circuit when the comparable signature already matches
    // (otherwise nightly reimports churn every pristine row's version and write
    // useless edit_log entries, silently invalidating clients' If-Match).
    if (tsvRowSignature(kind, storedTsvRowToParsed(kind, cur)) === tsvRowSignature(kind, row)) {
      counts.skipped_noop++;
      continue;
    }
    if (!isPristineTsv(kind, cur)) {
      counts.skipped_edited++;
      continue;
    }
    updates.push({ row, oldVersion: Number(cur.version) });
  }

  for (let i = 0; i < updates.length; i += WRITE_BATCH) {
    const slice = updates.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map(({ row, oldVersion }) => buildTsvUpdateStmt(env, book, kind, row, oldVersion, now)),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach(({ row, oldVersion }, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.updated++;
          logs.push(logEditStmt(env, kind, row.id, book, userId, oldVersion, oldVersion + 1, "update", row));
        } else {
          counts.skipped_edited++; // raced edit bumped version / set updated_by
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.errors.push(`${kind} update batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return counts;
}

// In-memory mirror of tsvPristinePredicate (keep in lockstep): is this stored
// row safe to overwrite (never touched by a human)? Used to classify before
// queuing an update; the UPDATE statement still carries the SQL predicate as
// the authoritative race guard.
function isPristineTsv(kind: TsvKind, row: Record<string, unknown>): boolean {
  if (row.updated_by != null) return false;
  if (row.deleted_at != null) return false;
  if (kind === "tn") {
    if (row.trashed_at != null) return false;
    if (Number(row.preserve ?? 0) !== 0) return false;
    if (Number(row.hint ?? 0) !== 0) return false;
  }
  return true;
}

// Build (don't run) the pristine, CAS-guarded UPDATE for one TSV row. Mirrors
// the per-kind columns the old tryUpdateTsvRow wrote; sets version explicitly to
// oldVersion+1 and guards on `version = oldVersion` so a concurrent edit can't
// be clobbered between the hoisted read and this batched write.
function buildTsvUpdateStmt(
  env: Env,
  book: string,
  kind: TsvKind,
  row: ParsedTsvRow,
  oldVersion: number,
  now: number,
): D1PreparedStatement {
  const pristine = tsvPristinePredicate(kind);
  const newVersion = oldVersion + 1;
  if (kind === "tn") {
    return env.DB.prepare(
      `UPDATE tn_rows
          SET ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
              support_reference = ?5, quote = ?6, occurrence = ?7, note = ?8,
              version = ?9, updated_at = ?10
        WHERE id = ?11 AND book = ?12 AND ${pristine} AND version = ?13`,
    ).bind(
      row.refRaw, row.chapter, row.verse, row.tags,
      row.support_reference ?? null, row.quote ?? null, row.occurrence, row.note ?? null,
      newVersion, now, row.id, book, oldVersion,
    );
  }
  if (kind === "tq") {
    return env.DB.prepare(
      `UPDATE tq_rows
          SET ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
              quote = ?5, occurrence = ?6, question = ?7, response = ?8,
              version = ?9, updated_at = ?10
        WHERE id = ?11 AND book = ?12 AND ${pristine} AND version = ?13`,
    ).bind(
      row.refRaw, row.chapter, row.verse, row.tags,
      row.quote ?? null, row.occurrence, row.question ?? null, row.response ?? null,
      newVersion, now, row.id, book, oldVersion,
    );
  }
  return env.DB.prepare(
    `UPDATE twl_rows
        SET ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
            orig_words = ?5, occurrence = ?6, tw_link = ?7,
            version = ?8, updated_at = ?9
      WHERE id = ?10 AND book = ?11 AND ${pristine} AND version = ?12`,
  ).bind(
    row.refRaw, row.chapter, row.verse, row.tags,
    row.orig_words ?? null, row.occurrence, row.tw_link ?? null,
    newVersion, now, row.id, book, oldVersion,
  );
}

// sort_order for a DCS-new row, derived from its file position. Only the
// row's own (chapter, verse) group matters (chapter/verse dominate the export
// sort), so anchor on the file-adjacent same-verse neighbours' stored
// sort_orders. Rows are inserted AND placed in file order, so a preceding new
// row already has its sort_order by the time we reach the next one — that's
// what keeps a RUN of consecutive DCS-new rows in file order (each chains off
// the one before it). The earlier version only looked at the immediate
// neighbours and returned NULL whenever EITHER was itself a same-pass new row
// (the common case: a verse whose notes were rewritten upstream), so adjacent
// new rows all landed NULL and NULLS-LAST then ordered them by id — scrambling
// the export diff, the exact churn this is meant to prevent.
async function midpointSortOrder(
  env: Env,
  book: string,
  kind: TsvKind,
  incoming: ParsedTsvRow[],
  idx: number,
): Promise<number> {
  const me = incoming[idx];
  const sameGroup = (r: ParsedTsvRow | undefined): r is ParsedTsvRow =>
    r != null && r.chapter === me.chapter && r.verse === me.verse;
  const sortOrderOf = async (id: string): Promise<number | null> => {
    const r = await env.DB.prepare(
      `SELECT sort_order FROM ${kind}_rows WHERE id = ?1 AND book = ?2`,
    )
      .bind(id, book)
      .first<{ sort_order: number | null }>();
    return r?.sort_order ?? null;
  };
  // Nearest preceding same-verse neighbour that already has a sort_order
  // (a pre-existing row, or an earlier new row we just placed this pass).
  let before: number | null = null;
  for (let j = idx - 1; sameGroup(incoming[j]); j--) {
    const so = await sortOrderOf(incoming[j].id);
    if (so != null) {
      before = so;
      break;
    }
  }
  // Nearest following same-verse neighbour that has a sort_order. Following
  // NEW rows aren't inserted yet (their lookup returns null) and are skipped,
  // so this anchors on the next already-existing row.
  let after: number | null = null;
  for (let j = idx + 1; sameGroup(incoming[j]); j++) {
    const so = await sortOrderOf(incoming[j].id);
    if (so != null) {
      after = so;
      break;
    }
  }
  return placeSortOrder(before, after);
}

// Returns true if the row was inserted (was new), false if a row with this id
// already existed (a concurrent insert raced us between the hoisted read and
// here — the caller counts it as a noop).
async function tryInsertTsvRow(
  env: Env,
  book: string,
  kind: TsvKind,
  row: ParsedTsvRow,
): Promise<boolean> {
  if (kind === "tn") {
    const r = await env.DB.prepare(
      `INSERT INTO tn_rows
         (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)
       ON CONFLICT(id, book) DO NOTHING`,
    )
      .bind(
        row.id, book, row.chapter, row.verse, row.refRaw,
        row.tags, row.support_reference ?? null, row.quote ?? null,
        row.occurrence, row.note ?? null,
      )
      .run();
    return (r.meta.changes ?? 0) > 0;
  }
  if (kind === "tq") {
    const r = await env.DB.prepare(
      `INSERT INTO tq_rows
         (id, book, chapter, verse, ref_raw, tags, quote, occurrence, question, response, sort_order)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)
       ON CONFLICT(id, book) DO NOTHING`,
    )
      .bind(
        row.id, book, row.chapter, row.verse, row.refRaw,
        row.tags, row.quote ?? null, row.occurrence,
        row.question ?? null, row.response ?? null,
      )
      .run();
    return (r.meta.changes ?? 0) > 0;
  }
  const r = await env.DB.prepare(
    `INSERT INTO twl_rows
       (id, book, chapter, verse, ref_raw, tags, orig_words, occurrence, tw_link, sort_order)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)
     ON CONFLICT(id, book) DO NOTHING`,
  )
    .bind(
      row.id, book, row.chapter, row.verse, row.refRaw,
      row.tags, row.orig_words ?? null, row.occurrence, row.tw_link ?? null,
    )
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// ── Verses (ULT / UST) ─────────────────────────────────────────────────────

async function reimportVersesForChapter(
  env: Env,
  book: string,
  chapter: number,
  rawUsfm: string,
  bibleVersion: "ULT" | "UST",
  userId: number | null,
): Promise<ReimportCounts> {
  return applyVerseRows(env, book, bibleVersion, extractVersesForRange(rawUsfm, chapter, chapter), userId);
}

// Per-verse upsert over already-parsed verses (keys off each verse's own
// chapter, so it works across a whole chunk range). Split out so the chunked
// path parses a staged USFM file ONCE per chunk instead of re-parsing the whole
// book per chapter.
//
// Subrequest-frugal: the old version did INSERT-OR-IGNORE + SELECT for EVERY
// verse of a changed file — thousands of D1 round-trips that exhausted
// Cloudflare's per-invocation subrequest cap and aborted the nightly sync (the
// LAM clobber's root cause). Now we hoist one SELECT per chapter, classify in
// memory, and batch the writes:
//   - byte-equal verse  → noop, zero writes (the common case)
//   - new verse         → batched INSERT … ON CONFLICT DO NOTHING (+ audit)
//   - changed pristine  → batched UPDATE guarded by `updated_by IS NULL AND
//                         version = <read version>` (CAS), so a translator edit
//                         landing between the read and the write flips the row
//                         to skipped, never clobbered — same guarantee the
//                         per-row predicate gave, now race-safe via the version.
async function applyVerseRows(
  env: Env,
  book: string,
  bibleVersion: "ULT" | "UST",
  verses: VerseExtract[],
  userId: number | null,
): Promise<ReimportCounts> {
  const counts = zeroCounts();
  if (verses.length === 0) return counts;
  const now = Math.floor(Date.now() / 1000);

  // One read for every chapter present (usually a single chapter per call).
  const chapters = [...new Set(verses.map((v) => v.chapter))];
  const inClause = chapters.map((_, i) => `?${i + 3}`).join(",");
  const existingRs = await env.DB.prepare(
    `SELECT chapter, verse, content_json, plain_text, verse_end, version, updated_by
       FROM verses WHERE book = ?1 AND bible_version = ?2 AND chapter IN (${inClause})`,
  )
    .bind(book, bibleVersion, ...chapters)
    .all<{
      chapter: number; verse: number; content_json: string;
      plain_text: string | null; verse_end: number | null;
      version: number; updated_by: number | null;
    }>();
  const existing = new Map<string, { content_json: string; plain_text: string | null; verse_end: number | null; version: number; updated_by: number | null }>();
  for (const r of existingRs.results) existing.set(`${r.chapter}:${r.verse}`, r);

  const inserts: VerseExtract[] = [];
  const updates: Array<{ v: VerseExtract; oldVersion: number }> = [];
  for (const v of verses) {
    const cur = existing.get(`${v.chapter}:${v.verse}`);
    if (!cur) {
      inserts.push(v);
      continue;
    }
    if (
      cur.content_json === v.contentJson &&
      (cur.plain_text ?? null) === (v.plainText ?? null) &&
      (cur.verse_end ?? null) === (v.verseEnd ?? null)
    ) {
      counts.skipped_noop++;
      continue;
    }
    if (cur.updated_by !== null) {
      counts.skipped_edited++;
      continue;
    }
    updates.push({ v, oldVersion: cur.version });
  }

  const insSql =
    `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(book, chapter, verse, bible_version) DO NOTHING`;
  for (let i = 0; i < inserts.length; i += WRITE_BATCH) {
    const slice = inserts.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((v) =>
          env.DB.prepare(insSql).bind(book, v.chapter, v.verse, v.verseEnd, bibleVersion, v.contentJson, v.plainText),
        ),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach((v, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.inserted++;
          logs.push(logEditStmt(env, "verse", `${book}/${v.chapter}/${v.verse}/${bibleVersion}`, book, userId, null, 1, "create", { plain_text: v.plainText }));
        } else {
          counts.skipped_noop++; // raced insert — already present
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.errors.push(`verse ${bibleVersion} insert batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const updSql =
    `UPDATE verses SET content_json = ?1, plain_text = ?2, verse_end = ?3, version = ?4, updated_at = ?5
      WHERE book = ?6 AND chapter = ?7 AND verse = ?8 AND bible_version = ?9
        AND updated_by IS NULL AND version = ?10`;
  for (let i = 0; i < updates.length; i += WRITE_BATCH) {
    const slice = updates.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map(({ v, oldVersion }) =>
          env.DB.prepare(updSql).bind(v.contentJson, v.plainText, v.verseEnd, oldVersion + 1, now, book, v.chapter, v.verse, bibleVersion, oldVersion),
        ),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach(({ v, oldVersion }, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.updated++;
          logs.push(logEditStmt(env, "verse", `${book}/${v.chapter}/${v.verse}/${bibleVersion}`, book, userId, oldVersion, oldVersion + 1, "update", { plain_text: v.plainText }));
        } else {
          counts.skipped_edited++; // raced edit bumped version / set updated_by
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.errors.push(`verse ${bibleVersion} update batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return counts;
}

// ── Audit ──────────────────────────────────────────────────────────────────

// Build (don't run) an edit_log insert so callers can collect statements into a
// single env.DB.batch() instead of one round-trip per row.
function logEditStmt(
  env: Env,
  kind: "tn" | "tq" | "twl" | "verse",
  rowKey: string,
  book: string,
  userId: number | null,
  prevVersion: number | null,
  newVersion: number,
  action: "create" | "update",
  payload: unknown,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO edit_log
       (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(kind, rowKey, book, userId, prevVersion, newVersion, action, JSON.stringify(payload), REIMPORT_SOURCE);
}

async function logEdit(
  env: Env,
  kind: "tn" | "tq" | "twl" | "verse",
  rowKey: string,
  book: string,
  userId: number | null,
  prevVersion: number | null,
  newVersion: number,
  action: "create" | "update",
  payload: unknown,
): Promise<void> {
  await logEditStmt(env, kind, rowKey, book, userId, prevVersion, newVersion, action, payload).run();
}

// ── Chunked, SHA-gated, diff-aware reimport (Workflow path) ─────────────────
//
// reimportBookFromDcs (above) runs in one call and is used by the HTTP route
// (client-supplied chapters) + first-time bootstrap. It is NOT safe inside a
// Cloudflare Workflow step for a large book — per-chapter re-parse + sequential
// D1 round-trips blow the 600 000 ms step limit (what failed on Isaiah). The
// functions below run the same row-level logic but:
//   1. skip a whole (book,resource) when its DCS file commit SHA is unchanged,
//   2. fetch each changed file once and stage it to R2,
//   3. process chapters in REIMPORT_CHAPTER_CHUNK-sized Workflow steps,
//   4. for TSV, skip chapters whose pristine content already matches DCS.
// No per-book lock is taken: a Workflow step REPLAYS on retry, so a held lock
// would self-deadlock; the pristine `WHERE updated_by IS NULL ...` UPDATE guard
// (unchanged) is the real protection against clobbering a concurrent edit.

interface StagedResource {
  resource: Resource;
  changed: boolean;        // false → SHA unchanged or DCS 404; skipped
  masterSha: string | null;
  r2Key: string | null;    // staged file location when changed
}

interface ReimportPlan {
  maxChapter: number;
  entries: StagedResource[];
}

function freshPerResource(): Record<Resource, ReimportCounts> {
  return { ult: zeroCounts(), ust: zeroCounts(), tn: zeroCounts(), tq: zeroCounts(), twl: zeroCounts() };
}

function mergePerResource(
  into: Record<Resource, ReimportCounts>,
  from: Record<Resource, ReimportCounts>,
): void {
  for (const r of ALL_RESOURCES) addCounts(into[r], from[r]);
}

function emptyResult(book: string): ReimportResult {
  return { book, perResource: freshPerResource(), totals: zeroCounts() };
}

async function readStaged(env: Env, key: string): Promise<string | null> {
  const obj = await env.BLOBS.get(key);
  return obj ? await obj.text() : null;
}

// Upsert the per-(book,resource) sync watermark. `origin` is provenance only;
// only 'import'/'reimport' watermarks are written as skip gates.
export async function recordResourceSync(
  env: Env,
  book: string,
  resource: Resource,
  sha: string,
  origin: "import" | "reimport" | "export",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO book_resource_syncs (book, resource, source_sha, synced_at, origin)
     VALUES (?1, ?2, ?3, unixepoch(), ?4)
     ON CONFLICT(book, resource) DO UPDATE SET
       source_sha = excluded.source_sha,
       synced_at = excluded.synced_at,
       origin = excluded.origin`,
  )
    .bind(book, resource, sha, origin)
    .run();
}

export async function storedResourceSha(env: Env, book: string, resource: Resource): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT source_sha FROM book_resource_syncs WHERE book = ?1 AND resource = ?2`,
  )
    .bind(book, resource)
    .first<{ source_sha: string | null }>();
  return row?.source_sha ?? null;
}

// Comparable-field signature for a normalized TSV row. MUST cover exactly the
// columns tryUpdateTsvRow compares (same fields, same null normalization) so a
// signature match is equivalent to a reimport no-op.
function tsvRowSignature(kind: TsvKind, r: ParsedTsvRow): string {
  const f =
    kind === "tn"
      ? [r.refRaw, r.chapter, r.verse, r.tags ?? null, r.support_reference ?? null, r.quote ?? null, r.occurrence ?? null, r.note ?? null]
      : kind === "tq"
        ? [r.refRaw, r.chapter, r.verse, r.tags ?? null, r.quote ?? null, r.occurrence ?? null, r.question ?? null, r.response ?? null]
        : [r.refRaw, r.chapter, r.verse, r.tags ?? null, r.orig_words ?? null, r.occurrence ?? null, r.tw_link ?? null];
  return JSON.stringify(f);
}

const TSV_STORED_COLS: Record<TsvKind, string> = {
  tn: "ref_raw, chapter, verse, tags, support_reference, quote, occurrence, note",
  tq: "ref_raw, chapter, verse, tags, quote, occurrence, question, response",
  twl: "ref_raw, chapter, verse, tags, orig_words, occurrence, tw_link",
};

// Build a ParsedTsvRow from a stored D1 row so it yields the same signature an
// incoming TSV row would.
function storedTsvRowToParsed(kind: TsvKind, row: Record<string, unknown>): ParsedTsvRow {
  const base: ParsedTsvRow = {
    id: String(row.id),
    refRaw: (row.ref_raw as string | null) ?? "",
    chapter: Number(row.chapter),
    verse: Number(row.verse),
    occurrence: (row.occurrence as number | null) ?? null,
    tags: (row.tags as string | null) ?? null,
  };
  if (kind === "tn") {
    base.support_reference = (row.support_reference as string | null) ?? null;
    base.quote = (row.quote as string | null) ?? null;
    base.note = (row.note as string | null) ?? null;
  } else if (kind === "tq") {
    base.quote = (row.quote as string | null) ?? null;
    base.question = (row.question as string | null) ?? null;
    base.response = (row.response as string | null) ?? null;
  } else {
    base.orig_words = (row.orig_words as string | null) ?? null;
    base.tw_link = (row.tw_link as string | null) ?? null;
  }
  return base;
}

// Chapters whose pristine D1 content differs from the incoming DCS TSV. A
// chapter is "unchanged" (skippable) ONLY when its incoming {id → signature}
// map equals its stored-pristine map exactly. Detects add/change/delete and id
// moves; errs toward "changed" whenever an edited (non-pristine) row is present
// (excluded from the stored map → chapter re-runs, edited row skipped
// harmlessly). A perf filter — it can never skip a real update.
export async function changedTsvChapters(
  env: Env,
  book: string,
  kind: TsvKind,
  rawTsv: string,
): Promise<Set<number>> {
  const pristine = tsvPristinePredicate(kind);

  const incoming = new Map<number, Map<string, string>>();
  for (const r of parseTsv(rawTsv).rows) {
    const p = parseTsvRow(r, kind);
    if (!p || p.chapter < 1) continue;
    let m = incoming.get(p.chapter);
    if (!m) incoming.set(p.chapter, (m = new Map()));
    m.set(p.id, tsvRowSignature(kind, p));
  }

  const stored = new Map<number, Map<string, string>>();
  const res = await env.DB.prepare(
    `SELECT id, ${TSV_STORED_COLS[kind]} FROM ${kind}_rows WHERE book = ?1 AND ${pristine}`,
  )
    .bind(book)
    .all<Record<string, unknown>>();
  for (const row of res.results) {
    const p = storedTsvRowToParsed(kind, row);
    if (p.chapter < 1) continue;
    let m = stored.get(p.chapter);
    if (!m) stored.set(p.chapter, (m = new Map()));
    m.set(p.id, tsvRowSignature(kind, p));
  }

  const changed = new Set<number>();
  for (const ch of new Set<number>([...incoming.keys(), ...stored.keys()])) {
    const a = incoming.get(ch) ?? new Map<string, string>();
    const b = stored.get(ch) ?? new Map<string, string>();
    if (a.size !== b.size) { changed.add(ch); continue; }
    let same = true;
    for (const [id, sig] of a) {
      if (b.get(id) !== sig) { same = false; break; }
    }
    if (!same) changed.add(ch);
  }
  return changed;
}

// Soft-delete pristine rows that master no longer carries, so the nightly
// export can't resurrect an out-of-band deletion. Mirrors pipelineImport.ts
// deleteUnkeptTns and the app's DELETE handler shape (rows.ts): set
// deleted_at, bump version, audit a 'delete'. Conservative on every axis:
// only chapters the incoming file covers AND the diff gate flagged as changed
// (a deletion always flags its chapter), only rows passing the pristine
// predicate (kept on the UPDATE itself so an edit landing after the SELECT
// skips the row), and never under an active pipeline lock. The id comparison
// is against the WHOLE file's id set so a row the update path just moved to
// another chapter isn't mistaken for removed.
async function softDeleteRemovedTsvRows(
  env: Env,
  book: string,
  kind: TsvKind,
  rawTsv: string,
  candidateChapters: number[],
): Promise<{ deleted: number; skippedLocked: number }> {
  const incomingIds = new Set<string>();
  const coveredChapters = new Set<number>();
  for (const r of parseTsv(rawTsv).rows) {
    const p = parseTsvRow(r, kind);
    if (!p) continue;
    incomingIds.add(p.id);
    if (p.chapter >= 1) coveredChapters.add(p.chapter);
  }
  // Defensive: an empty or garbled file must never sweep a book clean.
  if (incomingIds.size === 0) return { deleted: 0, skippedLocked: 0 };

  const pristine = tsvPristinePredicate(kind);
  const now = Math.floor(Date.now() / 1000);
  let deleted = 0;
  let skippedLocked = 0;
  for (const ch of candidateChapters) {
    if (!coveredChapters.has(ch)) continue;
    if (await activePipelineForChapter(env, book, ch)) {
      skippedLocked++;
      continue;
    }
    const rs = await env.DB.prepare(
      `SELECT id, version FROM ${kind}_rows WHERE book = ?1 AND chapter = ?2 AND ${pristine}`,
    )
      .bind(book, ch)
      .all<{ id: string; version: number }>();
    const targets = (rs.results ?? []).filter((r) => !incomingIds.has(r.id));
    for (const t of targets) {
      const upd = await env.DB.prepare(
        `UPDATE ${kind}_rows
            SET deleted_at = ?1, version = version + 1, updated_at = ?1
          WHERE id = ?2 AND book = ?3 AND ${pristine}`,
      )
        .bind(now, t.id, book)
        .run();
      if (!upd.meta.changes) continue;
      deleted++;
      await env.DB.prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, 'delete', ?6)`,
      )
        .bind(kind, t.id, book, t.version, t.version + 1, REIMPORT_SOURCE)
        .run();
    }
  }
  return { deleted, skippedLocked };
}

// SHA-gate each requested resource and stage the changed ones to R2. Returns
// the book's chapter extent + a manifest the chunk steps read from.
async function planAndStageBookResources(
  env: Env,
  book: string,
  resources: Resource[],
  instanceId: string,
): Promise<ReimportPlan> {
  const maxRow = await env.DB
    .prepare(`SELECT MAX(chapter) AS m FROM verses WHERE book = ?1`)
    .bind(book)
    .first<{ m: number | null }>();
  const maxChapter = maxRow?.m ?? 0;
  if (maxChapter < 1) return { maxChapter, entries: [] };

  const entries: StagedResource[] = [];
  for (const resource of resources) {
    const file = dcsResourceFile(book, resource);
    if (!file) { entries.push({ resource, changed: false, masterSha: null, r2Key: null }); continue; }

    const masterSha = await fileCommitSha(env, file.repo, file.path);
    const stored = await storedResourceSha(env, book, resource);
    // Skip ONLY on a positive SHA match (fail-open: null/unknown → reimport).
    if (masterSha && stored && masterSha === stored) {
      entries.push({ resource, changed: false, masterSha, r2Key: null });
      continue;
    }

    const raw = await fetchText(dcsRawUrl(env, file.repo, file.path));
    if (raw == null) {
      // DCS 404 / fetch error → nothing to import, no watermark.
      entries.push({ resource, changed: false, masterSha: null, r2Key: null });
      continue;
    }
    const r2Key = `reimport-stage/${instanceId}/${book}/${resource}`;
    await env.BLOBS.put(r2Key, raw);
    entries.push({ resource, changed: true, masterSha, r2Key });
  }
  return { maxChapter, entries };
}

// Reimport one chapter range from staged files. Reads each staged file once,
// then loops chapters. TSV chapters absent from changedTsv[kind] are skipped.
async function reimportStagedChunk(
  env: Env,
  book: string,
  startChapter: number,
  endChapter: number,
  staged: StagedResource[],
  changedTsv: Partial<Record<TsvKind, number[]>>,
  userId: number | null,
): Promise<Record<Resource, ReimportCounts>> {
  const perResource = freshPerResource();

  // Read + parse each staged file ONCE for the whole chunk (not per chapter).
  // The old per-chapter calls re-parsed the entire book each time (usfm.toJSON
  // / parseTsv), which tripped the per-step CPU limit on large books.
  const rawByResource: Partial<Record<Resource, string>> = {};
  for (const e of staged) {
    if (!e.changed || !e.r2Key) continue;
    const raw = await readStaged(env, e.r2Key);
    if (raw != null) rawByResource[e.resource] = raw;
  }

  // USFM: one parse of the chunk range per version, grouped by chapter.
  const versesByChapter: Partial<Record<"ult" | "ust", Map<number, VerseExtract[]>>> = {};
  for (const resource of ["ult", "ust"] as const) {
    const raw = rawByResource[resource];
    if (!raw) continue;
    const byCh = new Map<number, VerseExtract[]>();
    for (const ve of extractVersesForRange(raw, startChapter, endChapter)) {
      let arr = byCh.get(ve.chapter);
      if (!arr) byCh.set(ve.chapter, (arr = []));
      arr.push(ve);
    }
    versesByChapter[resource] = byCh;
  }

  // TSV: one parse per kind, grouped by chapter (within the chunk range).
  const rowsByChapter: Partial<Record<TsvKind, Map<number, ParsedTsvRow[]>>> = {};
  for (const kind of ["tn", "tq", "twl"] as TsvKind[]) {
    const raw = rawByResource[kind];
    if (!raw) continue;
    const byCh = new Map<number, ParsedTsvRow[]>();
    for (const r of parseTsv(raw).rows) {
      const p = parseTsvRow(r, kind);
      if (!p || p.chapter < startChapter || p.chapter > endChapter) continue;
      let arr = byCh.get(p.chapter);
      if (!arr) byCh.set(p.chapter, (arr = []));
      arr.push(p);
    }
    rowsByChapter[kind] = byCh;
  }

  const changedSets: Partial<Record<TsvKind, Set<number>>> = {};
  for (const k of ["tn", "tq", "twl"] as TsvKind[]) {
    if (changedTsv[k]) changedSets[k] = new Set(changedTsv[k]);
  }

  for (let chapter = startChapter; chapter <= endChapter; chapter++) {
    const lock = await activePipelineForChapter(env, book, chapter);
    if (lock) {
      for (const e of staged) if (e.changed) perResource[e.resource].skipped_locked++;
      continue;
    }
    for (const kind of ["tn", "tq", "twl"] as TsvKind[]) {
      const byCh = rowsByChapter[kind];
      if (!byCh) continue;
      const set = changedSets[kind];
      if (set && !set.has(chapter)) continue;  // chapter unchanged — skip the row loop
      addCounts(perResource[kind], await applyTsvRows(env, book, kind, byCh.get(chapter) ?? [], userId));
    }
    if (versesByChapter.ult) {
      addCounts(perResource.ult, await applyVerseRows(env, book, "ULT", versesByChapter.ult.get(chapter) ?? [], userId));
    }
    if (versesByChapter.ust) {
      addCounts(perResource.ust, await applyVerseRows(env, book, "UST", versesByChapter.ust.get(chapter) ?? [], userId));
    }
  }
  return perResource;
}

// Orchestrate a chunked, SHA-gated, diff-aware reimport of one book as a series
// of Workflow steps. Lock-free (see section header). Returns aggregate counts.
export async function runChunkedReimport(
  env: Env,
  step: WorkflowStep,
  book: string,
  instanceId: string,
  resources: Resource[],
  opts: { chunk?: number } = {},
): Promise<ReimportResult> {
  const chunkSize = opts.chunk ?? REIMPORT_CHAPTER_CHUNK;

  const plan = await step.do(
    `reimport-fetch-${book}`,
    { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
    async () => planAndStageBookResources(env, book, resources, instanceId),
  );

  const changed = plan.entries.filter((e) => e.changed);
  if (plan.maxChapter < 1 || changed.length === 0) return emptyResult(book);

  // Per-changed-TSV: which chapters actually differ (so chunks skip the rest).
  const changedTsv = await step.do(`reimport-tsvgate-${book}`, async () => {
    const out: Partial<Record<TsvKind, number[]>> = {};
    for (const e of changed) {
      if (e.resource === "ult" || e.resource === "ust" || !e.r2Key) continue;
      const raw = await readStaged(env, e.r2Key);
      if (raw == null) continue;
      out[e.resource] = [...(await changedTsvChapters(env, book, e.resource, raw))];
    }
    return out;
  });

  const perResource = freshPerResource();
  for (let start = 1; start <= plan.maxChapter; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, plan.maxChapter);
    const counts = await step.do(
      `reimport-${book}-ch${start}-${end}`,
      { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
      async () => reimportStagedChunk(env, book, start, end, changed, changedTsv, null),
    );
    mergePerResource(perResource, counts);
  }

  // After applying each changed TSV file, soft-delete pristine rows whose ids
  // master no longer carries — otherwise the next export branch resurrects
  // out-of-band deletions. See softDeleteRemovedTsvRows for the guardrails.
  for (const e of changed) {
    const kind = e.resource;
    if (kind === "ult" || kind === "ust" || !e.r2Key) continue;
    const chs = changedTsv[kind];
    if (!chs || chs.length === 0) continue;
    const r2Key = e.r2Key;
    await step.do(`reimport-prune-${book}-${kind}`, async () => {
      const raw = await readStaged(env, r2Key);
      if (raw == null) return { deleted: 0, skippedLocked: 0 };
      const res = await softDeleteRemovedTsvRows(env, book, kind, raw, chs);
      if (res.deleted > 0 || res.skippedLocked > 0) {
        console.log("reimport pruned rows removed on master", { book, resource: kind, ...res });
      }
      return res;
    });
  }

  // Record fetch-time SHAs for resources that ran (so a later night can skip).
  await step.do(`reimport-sync-${book}`, async () => {
    let recorded = 0;
    for (const e of changed) {
      if (e.masterSha) { await recordResourceSync(env, book, e.resource, e.masterSha, "reimport"); recorded++; }
    }
    return { recorded };
  });

  // Best-effort cleanup of staged R2 objects.
  await step.do(`reimport-cleanup-${book}`, async () => {
    let cleaned = 0;
    for (const e of changed) {
      if (e.r2Key) { try { await env.BLOBS.delete(e.r2Key); cleaned++; } catch { /* best-effort */ } }
    }
    return { cleaned };
  });

  const totals = zeroCounts();
  for (const r of ALL_RESOURCES) addCounts(totals, perResource[r]);
  return { book, perResource, totals };
}
