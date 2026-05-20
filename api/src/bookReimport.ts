// Non-destructive per-chapter, per-resource re-import from Door43.
//
// The bootstrap path (bookImport.ts) wipes the book and re-inserts. This
// module is the maintenance lane: pull fresh content from DCS for selected
// chapters / resources without clobbering rows a translator has edited.
//
// Don't-clobber rule (canonical): a row is "safe to overwrite" iff it has
// never been touched by a human. The signal is the same predicate the AI
// pipeline sweep uses in pipelineImport.ts deleteUnkeptTns:
//   tn:  updated_by IS NULL AND deleted_at IS NULL AND preserve = 0 AND hint = 0
//   tq:  updated_by IS NULL AND deleted_at IS NULL
//   twl: updated_by IS NULL AND deleted_at IS NULL
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
import { dcsUrls, fetchText } from "./dcsSources";
import {
  extractVersesForRange,
  parseTsv,
  refParts,
} from "./importParsers";
import { activePipelineForChapter } from "./chapterLock";

export type Resource = "ult" | "ust" | "tn" | "tq" | "twl";

export const ALL_RESOURCES: readonly Resource[] = ["ult", "ust", "tn", "tq", "twl"];

export interface ReimportCounts {
  updated: number;
  inserted: number;
  skipped_edited: number;
  skipped_locked: number;
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
    dcs_404: 0,
    errors: [],
  };
}

function addCounts(into: ReimportCounts, from: ReimportCounts): void {
  into.updated += from.updated;
  into.inserted += from.inserted;
  into.skipped_edited += from.skipped_edited;
  into.skipped_locked += from.skipped_locked;
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

function rowsForChapter(raw: string, kind: TsvKind, chapter: number): ParsedTsvRow[] {
  const { rows } = parseTsv(raw);
  const out: ParsedTsvRow[] = [];
  for (const r of rows) {
    const id = r["ID"];
    if (!id) continue;
    const refRaw = r["Reference"] ?? "";
    const [ch, v] = refParts(refRaw);
    if (ch !== chapter) continue;
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
    out.push(base);
  }
  return out;
}

// One UPDATE per pristine row, plus one INSERT-OR-IGNORE per row to seed
// any DCS-new entries. We don't batch into env.DB.batch() because the per-
// row "did anything change?" signal comes from meta.changes, and batch()
// reports aggregate counts only. Throughput is fine — a chapter's worth of
// tn rows is dozens, not thousands.
async function reimportTsvForChapter(
  env: Env,
  book: string,
  chapter: number,
  raw: string,
  kind: TsvKind,
  userId: number | null,
): Promise<ReimportCounts> {
  const counts = zeroCounts();
  const incoming = rowsForChapter(raw, kind, chapter);
  if (incoming.length === 0) return counts;

  const pristinePredicate =
    kind === "tn"
      ? `updated_by IS NULL AND deleted_at IS NULL AND preserve = 0 AND hint = 0`
      : `updated_by IS NULL AND deleted_at IS NULL`;

  for (const row of incoming) {
    try {
      const inserted = await tryInsertTsvRow(env, book, kind, row);
      if (inserted) {
        counts.inserted++;
        await logEdit(env, kind, row.id, book, userId, null, 1, "create", row);
        continue;
      }
      // Row exists. Try a pristine-scoped UPDATE; rowcount tells us whether
      // we actually overwrote (1) or skipped because someone edited (0).
      const updated = await tryUpdateTsvRow(env, book, kind, row, pristinePredicate);
      if (updated) {
        counts.updated++;
        // Pull the new version for the audit log. We don't have it from the
        // UPDATE result (D1 doesn't return RETURNING), so a follow-up SELECT.
        const v = await env.DB.prepare(
          `SELECT version FROM ${kind}_rows WHERE id = ?1 AND book = ?2`,
        )
          .bind(row.id, book)
          .first<{ version: number }>();
        if (v) {
          await logEdit(env, kind, row.id, book, userId, v.version - 1, v.version, "update", row);
        }
      } else {
        counts.skipped_edited++;
      }
    } catch (e) {
      counts.errors.push(`${kind} ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return counts;
}

// Returns true if the row was inserted (was new), false if it already existed
// (caller falls through to the pristine UPDATE branch).
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
         (id, book, chapter, verse, ref_raw, tags, quote, occurrence, question, response)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
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

// UPDATE only if the row is still pristine. updated_by stays NULL so future
// re-imports still see it as "safe to overwrite" — re-import is conceptually
// a re-seed, not a human edit.
async function tryUpdateTsvRow(
  env: Env,
  book: string,
  kind: TsvKind,
  row: ParsedTsvRow,
  pristine: string,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  if (kind === "tn") {
    const r = await env.DB.prepare(
      `UPDATE tn_rows
          SET ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
              support_reference = ?5, quote = ?6, occurrence = ?7, note = ?8,
              version = version + 1, updated_at = ?9
        WHERE id = ?10 AND book = ?11 AND ${pristine}`,
    )
      .bind(
        row.refRaw, row.chapter, row.verse, row.tags,
        row.support_reference ?? null, row.quote ?? null,
        row.occurrence, row.note ?? null,
        now, row.id, book,
      )
      .run();
    return (r.meta.changes ?? 0) > 0;
  }
  if (kind === "tq") {
    const r = await env.DB.prepare(
      `UPDATE tq_rows
          SET ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
              quote = ?5, occurrence = ?6, question = ?7, response = ?8,
              version = version + 1, updated_at = ?9
        WHERE id = ?10 AND book = ?11 AND ${pristine}`,
    )
      .bind(
        row.refRaw, row.chapter, row.verse, row.tags,
        row.quote ?? null, row.occurrence,
        row.question ?? null, row.response ?? null,
        now, row.id, book,
      )
      .run();
    return (r.meta.changes ?? 0) > 0;
  }
  const r = await env.DB.prepare(
    `UPDATE twl_rows
        SET ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
            orig_words = ?5, occurrence = ?6, tw_link = ?7,
            version = version + 1, updated_at = ?8
      WHERE id = ?9 AND book = ?10 AND ${pristine}`,
  )
    .bind(
      row.refRaw, row.chapter, row.verse, row.tags,
      row.orig_words ?? null, row.occurrence, row.tw_link ?? null,
      now, row.id, book,
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
  const counts = zeroCounts();
  const verses = extractVersesForRange(rawUsfm, chapter, chapter);
  if (verses.length === 0) return counts;

  const now = Math.floor(Date.now() / 1000);
  for (const v of verses) {
    try {
      // Try insert first; cheap signal for "doesn't exist locally".
      const ins = await env.DB.prepare(
        `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(book, chapter, verse, bible_version) DO NOTHING`,
      )
        .bind(book, chapter, v.verse, v.verseEnd, bibleVersion, v.contentJson, v.plainText)
        .run();
      if ((ins.meta.changes ?? 0) > 0) {
        counts.inserted++;
        await logEdit(
          env, "verse",
          `${book}/${chapter}/${v.verse}/${bibleVersion}`,
          book, userId, null, 1, "create",
          { plain_text: v.plainText },
        );
        continue;
      }
      // Exists locally — pristine UPDATE. updated_by IS NULL is the signal
      // here (verses don't have preserve/hint). updated_by stays NULL.
      const upd = await env.DB.prepare(
        `UPDATE verses
            SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                version = version + 1, updated_at = ?4
          WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8
            AND updated_by IS NULL`,
      )
        .bind(v.contentJson, v.plainText, v.verseEnd, now, book, chapter, v.verse, bibleVersion)
        .run();
      if ((upd.meta.changes ?? 0) > 0) {
        counts.updated++;
        const got = await env.DB.prepare(
          `SELECT version FROM verses
            WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
        )
          .bind(book, chapter, v.verse, bibleVersion)
          .first<{ version: number }>();
        if (got) {
          await logEdit(
            env, "verse",
            `${book}/${chapter}/${v.verse}/${bibleVersion}`,
            book, userId, got.version - 1, got.version, "update",
            { plain_text: v.plainText },
          );
        }
      } else {
        counts.skipped_edited++;
      }
    } catch (e) {
      counts.errors.push(
        `verse ${bibleVersion} ${book} ${chapter}:${v.verse}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return counts;
}

// ── Audit ──────────────────────────────────────────────────────────────────

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
  await env.DB.prepare(
    `INSERT INTO edit_log
       (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(kind, rowKey, book, userId, prevVersion, newVersion, action, JSON.stringify(payload), REIMPORT_SOURCE)
    .run();
}
