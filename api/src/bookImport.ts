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

export const books = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

// Standard unfoldingWord book number prefixes for USFM filenames. Mirror of
// the BOOK_NUMBERS map in scripts/import-book.mjs and api/src/export.ts;
// kept duplicated to keep this module's surface small.
const BOOK_NUMBERS: Record<string, string> = {
  GEN: "01", EXO: "02", LEV: "03", NUM: "04", DEU: "05", JOS: "06", JDG: "07",
  RUT: "08", "1SA": "09", "2SA": "10", "1KI": "11", "2KI": "12", "1CH": "13",
  "2CH": "14", EZR: "15", NEH: "16", EST: "17", JOB: "18", PSA: "19",
  PRO: "20", ECC: "21", SNG: "22", ISA: "23", JER: "24", LAM: "25",
  EZK: "26", DAN: "27", HOS: "28", JOL: "29", AMO: "30", OBA: "31",
  JON: "32", MIC: "33", NAM: "34", HAB: "35", ZEP: "36", HAG: "37",
  ZEC: "38", MAL: "39",
  MAT: "41", MRK: "42", LUK: "43", JHN: "44", ACT: "45",
  ROM: "46", "1CO": "47", "2CO": "48", GAL: "49", EPH: "50",
  PHP: "51", COL: "52", "1TH": "53", "2TH": "54", "1TI": "55",
  "2TI": "56", TIT: "57", PHM: "58", HEB: "59", JAS: "60",
  "1PE": "61", "2PE": "62", "1JN": "63", "2JN": "64", "3JN": "65",
  JUD: "66", REV: "67",
};

const NT_BOOKS = new Set([
  "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH",
  "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS",
  "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV",
]);

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
  num: string,
  userId: number,
): Promise<ImportCounts> {
  const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  const usfmName = `${num}-${book}.usfm`;
  const isNt = NT_BOOKS.has(book);
  const origRepo = isNt ? "el-x-koine_ugnt" : "hbo_uhb";
  const origVersion = isNt ? "UGNT" : "UHB";

  const urls = {
    ult: `${base}/unfoldingWord/en_ult/raw/branch/master/${usfmName}`,
    ust: `${base}/unfoldingWord/en_ust/raw/branch/master/${usfmName}`,
    orig: `${base}/unfoldingWord/${origRepo}/raw/branch/master/${usfmName}`,
    tn: `${base}/unfoldingWord/en_tn/raw/branch/master/tn_${book}.tsv`,
    tq: `${base}/unfoldingWord/en_tq/raw/branch/master/tq_${book}.tsv`,
    twl: `${base}/unfoldingWord/en_twl/raw/branch/master/twl_${book}.tsv`,
  };

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
    throw new Error(`no files fetched from DCS (checked ${Object.values(urls).join(", ")})`);
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

async function fetchText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
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
