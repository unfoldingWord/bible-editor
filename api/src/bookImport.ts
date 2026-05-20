// Book list + on-demand import from DCS.
//
// GET  /api/books              — list imported books (existing behaviour).
// POST /api/books/:book/import — pull ULT/UST/UHB-or-UGNT/tn/tq/twl for a
//   single book from DCS, parse, and write into D1. Idempotent: if the
//   book is already in book_imports we short-circuit and return ok.
//
// This is the Worker equivalent of `scripts/import-book.mjs`. Same shape,
// just running server-side so the editor's dropdown can auto-import a book
// on first selection instead of asking the operator to run a CLI.

import { Hono } from "hono";
import type { Env } from "./index";
import {
  extractUsfmHeaders,
  extractVersesForRange,
  parseTsv,
  refParts,
} from "./importParsers";
import { requireEditor, currentUserId } from "./auth";
import { BOOK_NUMBERS, dcsUrls, fetchText } from "./dcsSources";
import { reimportBookFromDcs, type Resource } from "./bookReimport";

export const books = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

books.get("/", async (c) => {
  const rs = await c.env.DB.prepare(
    `SELECT book, imported_at FROM book_imports ORDER BY book`,
  ).all<{ book: string; imported_at: number }>();
  return c.json({ books: rs.results });
});

books.post("/:book/import", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const book = c.req.param("book").toUpperCase();
  const num = BOOK_NUMBERS[book];
  if (!num) return c.json({ error: "unknown_book", book }, 400);

  // Idempotency: already imported → fast path.
  const existing = await c.env.DB.prepare(
    `SELECT book, imported_at FROM book_imports WHERE book = ?1`,
  )
    .bind(book)
    .first<{ book: string; imported_at: number }>();
  if (existing) {
    return c.json({ ok: true, book, alreadyImported: true, imported_at: existing.imported_at });
  }

  // Orphan recovery: rows exist but book_imports is missing (import succeeded but
  // the final INSERT crashed). Re-register without wiping so any edits are preserved.
  const hasData = await c.env.DB.prepare(
    `SELECT 1 FROM verses WHERE book = ?1 LIMIT 1`,
  )
    .bind(book)
    .first();
  if (hasData) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO book_imports (book, source_url, imported_at, imported_by)
       VALUES (?1, 'recovered', unixepoch(), ?2)`,
    )
      .bind(book, userId)
      .run();
    return c.json({ ok: true, book, recovered: true });
  }

  // Cross-isolate import lock — `INSERT OR IGNORE` on the PK gives us an
  // atomic "first writer wins" handshake. The previous in-memory Set was
  // per-Worker-isolate, so a second POST that happened to land on a
  // different edge node would have raced the DELETE-then-INSERT pipeline
  // below and double-imported the book. A stale lock from a crashed Worker
  // is reclaimed by the */5 sweep in api/src/index.ts.
  const lock = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO book_import_locks (book, started_at, started_by)
     VALUES (?1, unixepoch(), ?2)`,
  )
    .bind(book, userId)
    .run();
  if (!lock.meta.changes) {
    return c.json({ error: "in_progress", book }, 409);
  }

  try {
    const result = await importBookFromDcs(c.env, book, num, userId);
    return c.json({ ok: true, book, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: "import_failed", book, message: msg }, 502);
  } finally {
    await c.env.DB.prepare(
      `DELETE FROM book_import_locks WHERE book = ?1`,
    )
      .bind(book)
      .run();
  }
});

// POST /api/books/:book/reimport — non-destructive per-chapter, per-resource
// re-import from DCS. Required body: { chapters: number[], resources: Resource[] }.
// Skips rows that have been edited locally (see bookReimport.ts for the
// pristine predicate). Requires the book to be bootstrapped (404 otherwise);
// reuses book_import_locks (409 in_progress if held).
const ALLOWED_RESOURCES: ReadonlyArray<Resource> = ["ult", "ust", "tn", "tq", "twl"];

books.post("/:book/reimport", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const book = c.req.param("book").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  let body: { chapters?: unknown; resources?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_body" }, 422);
  }
  const chapters = Array.isArray(body.chapters)
    ? body.chapters
        .map((n) => (typeof n === "number" ? Math.floor(n) : NaN))
        .filter((n) => Number.isFinite(n) && n >= 1)
    : [];
  const resources = Array.isArray(body.resources)
    ? body.resources.filter((r): r is Resource =>
        typeof r === "string" && (ALLOWED_RESOURCES as readonly string[]).includes(r),
      )
    : [];
  if (chapters.length === 0) {
    return c.json({ error: "invalid_body", detail: "chapters must be a non-empty list of positive integers" }, 422);
  }
  if (resources.length === 0) {
    return c.json({ error: "invalid_body", detail: "resources must include at least one of ult/ust/tn/tq/twl" }, 422);
  }

  try {
    const result = await reimportBookFromDcs(c.env, book, chapters, resources, userId, { source: "user" });
    return c.json({ ok: true, ...result });
  } catch (e) {
    const name = e instanceof Error ? e.constructor.name : "";
    if (name === "BookNotImportedError") return c.json({ error: "book_not_imported", book }, 404);
    if (name === "ImportInProgressError") return c.json({ error: "in_progress", book }, 409);
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: "reimport_failed", book, message: msg }, 502);
  }
});

interface ImportCounts {
  verses: number;
  tn: number;
  tq: number;
  twl: number;
  fetched: { ult: boolean; ust: boolean; orig: boolean; tn: boolean; tq: boolean; twl: boolean };
}

async function importBookFromDcs(
  env: Env,
  book: string,
  _num: string,
  userId: number,
): Promise<ImportCounts> {
  const urls = dcsUrls(env, book);
  if (!urls) throw new Error(`unknown book: ${book}`);
  const origVersion = urls.origVersion;

  // Fire all six fetches in parallel. A missing file (404) returns null and
  // the caller proceeds without that resource — matches the script's "warn
  // and continue" behaviour for incomplete sample dirs.
  const [ultRaw, ustRaw, origRaw, tnRaw, tqRaw, twlRaw] = await Promise.all([
    fetchText(urls.ult),
    fetchText(urls.ust),
    fetchText(urls.orig),
    fetchText(urls.tn),
    fetchText(urls.tq),
    fetchText(urls.twl),
  ]);

  if (!ultRaw && !ustRaw && !origRaw && !tnRaw && !tqRaw && !twlRaw) {
    const urlList = [urls.ult, urls.ust, urls.orig, urls.tn, urls.tq, urls.twl];
    throw new Error(`no files fetched from DCS (checked ${urlList.join(", ")})`);
  }

  // Wipe any partial leftovers from a prior failed run. book_imports stays
  // empty until the very end so a midway failure leaves the book in an
  // unimported state (the next POST retries cleanly).
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM tn_rows  WHERE book = ?1`).bind(book),
    env.DB.prepare(`DELETE FROM tq_rows  WHERE book = ?1`).bind(book),
    env.DB.prepare(`DELETE FROM twl_rows WHERE book = ?1`).bind(book),
    env.DB.prepare(`DELETE FROM verses   WHERE book = ?1`).bind(book),
    env.DB.prepare(`DELETE FROM book_usfm_meta WHERE book = ?1`).bind(book),
  ]);

  const counts: ImportCounts = {
    verses: 0,
    tn: 0,
    tq: 0,
    twl: 0,
    fetched: {
      ult: !!ultRaw,
      ust: !!ustRaw,
      orig: !!origRaw,
      tn: !!tnRaw,
      tq: !!tqRaw,
      twl: !!twlRaw,
    },
  };

  counts.verses += await insertVerses(env, book, "ULT", ultRaw);
  counts.verses += await insertVerses(env, book, "UST", ustRaw);
  counts.verses += await insertVerses(env, book, origVersion, origRaw);

  counts.tn = await insertTnRows(env, book, tnRaw, userId);
  counts.tq = await insertTqRows(env, book, tqRaw, userId);
  counts.twl = await insertTwlRows(env, book, twlRaw, userId);

  // Final marker — the read path keys off this row's presence.
  const sources = Object.entries(counts.fetched)
    .filter(([, ok]) => ok)
    .map(([k]) => k)
    .join(",");
  await env.DB.prepare(
    `INSERT OR REPLACE INTO book_imports (book, source_url, imported_at, imported_by)
     VALUES (?1, ?2, unixepoch(), ?3)`,
  )
    .bind(book, `dcs:${sources}`, userId)
    .run();

  return counts;
}

// D1 batch() caps at 100 statements per call. Keep chunks well under that.
const CHUNK = 80;

async function insertVerses(
  env: Env,
  book: string,
  bibleVersion: string,
  rawUsfm: string | null,
): Promise<number> {
  if (!rawUsfm) return 0;

  const headers = extractUsfmHeaders(rawUsfm);
  if (headers) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO book_usfm_meta (book, bible_version, headers_json)
       VALUES (?1, ?2, ?3)`,
    )
      .bind(book, bibleVersion, JSON.stringify(headers))
      .run();
  }

  // Whole-book extract; the [1, 999] range covers any chapter that exists.
  const verses = extractVersesForRange(rawUsfm, 1, 999);
  if (verses.length === 0) return 0;

  const stmt = env.DB.prepare(
    `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  );
  for (let i = 0; i < verses.length; i += CHUNK) {
    const slice = verses.slice(i, i + CHUNK);
    await env.DB.batch(
      slice.map((v) =>
        stmt.bind(book, v.chapter, v.verse, v.verseEnd, bibleVersion, v.contentJson, v.plainText),
      ),
    );
  }
  return verses.length;
}

async function insertTnRows(
  env: Env,
  book: string,
  raw: string | null,
  userId: number,
): Promise<number> {
  if (!raw) return 0;
  const { rows } = parseTsv(raw);
  if (rows.length === 0) return 0;

  const insertStmt = env.DB.prepare(
    `INSERT INTO tn_rows
       (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  );
  const auditStmt = env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, user_id, prev_version, new_version, action, payload_json)
     VALUES ('tn', ?1, ?2, NULL, 1, 'create', ?3)`,
  );

  let count = 0;
  let batch: D1PreparedStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await env.DB.batch(batch);
    batch = [];
  };

  for (const r of rows) {
    const id = r["ID"];
    if (!id) continue;
    const refRaw = r["Reference"] ?? "";
    const [ch, v] = refParts(refRaw);
    const occRaw = r["Occurrence"];
    const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
    const payload = {
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: r["Tags"] || null,
      support_reference: r["SupportReference"] || null,
      quote: r["Quote"] || null,
      occurrence,
      note: r["Note"] || null,
    };
    batch.push(
      insertStmt.bind(
        id, book, ch, v, refRaw,
        payload.tags, payload.support_reference, payload.quote, payload.occurrence, payload.note,
        (count + 1) * 100,
      ),
      auditStmt.bind(id, userId, JSON.stringify(payload)),
    );
    count++;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  return count;
}

async function insertTqRows(
  env: Env,
  book: string,
  raw: string | null,
  userId: number,
): Promise<number> {
  if (!raw) return 0;
  const { rows } = parseTsv(raw);
  if (rows.length === 0) return 0;

  const insertStmt = env.DB.prepare(
    `INSERT INTO tq_rows
       (id, book, chapter, verse, ref_raw, tags, quote, occurrence, question, response)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  );
  const auditStmt = env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, user_id, prev_version, new_version, action, payload_json)
     VALUES ('tq', ?1, ?2, NULL, 1, 'create', ?3)`,
  );

  let count = 0;
  let batch: D1PreparedStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await env.DB.batch(batch);
    batch = [];
  };

  for (const r of rows) {
    const id = r["ID"];
    if (!id) continue;
    const refRaw = r["Reference"] ?? "";
    const [ch, v] = refParts(refRaw);
    const occRaw = r["Occurrence"];
    const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
    const payload = {
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: r["Tags"] || null,
      quote: r["Quote"] || null,
      occurrence,
      question: r["Question"] || null,
      response: r["Response"] || null,
    };
    batch.push(
      insertStmt.bind(
        id, book, ch, v, refRaw,
        payload.tags, payload.quote, payload.occurrence, payload.question, payload.response,
      ),
      auditStmt.bind(id, userId, JSON.stringify(payload)),
    );
    count++;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  return count;
}

async function insertTwlRows(
  env: Env,
  book: string,
  raw: string | null,
  userId: number,
): Promise<number> {
  if (!raw) return 0;
  const { rows } = parseTsv(raw);
  if (rows.length === 0) return 0;

  const insertStmt = env.DB.prepare(
    `INSERT INTO twl_rows
       (id, book, chapter, verse, ref_raw, tags, orig_words, occurrence, tw_link, sort_order)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  );
  const auditStmt = env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, user_id, prev_version, new_version, action, payload_json)
     VALUES ('twl', ?1, ?2, NULL, 1, 'create', ?3)`,
  );

  let count = 0;
  let batch: D1PreparedStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await env.DB.batch(batch);
    batch = [];
  };

  for (const r of rows) {
    const id = r["ID"];
    if (!id) continue;
    const refRaw = r["Reference"] ?? "";
    const [ch, v] = refParts(refRaw);
    const occRaw = r["Occurrence"];
    const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
    const payload = {
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: r["Tags"] || null,
      orig_words: r["OrigWords"] || null,
      occurrence,
      tw_link: r["TWLink"] || null,
    };
    batch.push(
      insertStmt.bind(
        id, book, ch, v, refRaw,
        payload.tags, payload.orig_words, payload.occurrence, payload.tw_link,
        (count + 1) * 100,
      ),
      auditStmt.bind(id, userId, JSON.stringify(payload)),
    );
    count++;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  return count;
}
