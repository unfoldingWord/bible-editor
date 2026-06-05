import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import type { ChapterPayload, TnRow, TqRow, TwlRow, VerseRow, VerseDto, VerseStatus } from "./types";
import { currentUserId, requireEditor } from "./auth";
import { broadcastChapter } from "./wsEvents";
import { recomputeTargetOccurrences } from "./importParsers";

export const chapters = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

// Bulk read everything for a chapter.
chapters.get("/:book/:chapter", async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  if (!book || !Number.isFinite(chapter) || chapter < 0) {
    return c.json({ error: "invalid_params" }, 400);
  }
  const db = c.env.DB;

  // `latest_source` is derived from edit_log per row — the source column on
  // the *most recent* entry for (kind, row_key). It's 'ai_pipeline' iff the
  // last write was AI-driven; any later human edit / keep overwrites with
  // NULL via a fresh edit_log row, so the chip disappears automatically.
  // The (kind, row_key) index makes the correlated subquery cheap.
  //
  // Book-scope the subquery on edit_log.book (added in migration 0017) so
  // cross-book id collisions can't leak the wrong source chip. Pre-0017
  // audit rows have NULL book; the `OR book IS NULL` keeps them visible
  // until the next edit naturally backfills.
  const [verses, tn, tq, twl, statuses] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM verses WHERE book = ?1 AND chapter = ?2 ORDER BY verse, bible_version",
      )
      .bind(book, chapter)
      .all<VerseRow>(),
    db
      .prepare(
        `SELECT t.*, (
           SELECT source FROM edit_log
            WHERE kind = 'tn' AND row_key = t.id
              AND (book = t.book OR book IS NULL)
            ORDER BY id DESC LIMIT 1
         ) AS latest_source
            FROM tn_rows t
           WHERE t.book = ?1 AND t.chapter = ?2 AND t.deleted_at IS NULL
           ORDER BY verse, sort_order ASC NULLS LAST, id`,
      )
      .bind(book, chapter)
      .all<TnRow>(),
    db
      .prepare(
        `SELECT t.*, (
           SELECT source FROM edit_log
            WHERE kind = 'tq' AND row_key = t.id
              AND (book = t.book OR book IS NULL)
            ORDER BY id DESC LIMIT 1
         ) AS latest_source
            FROM tq_rows t
           WHERE t.book = ?1 AND t.chapter = ?2 AND t.deleted_at IS NULL
           ORDER BY verse, sort_order ASC NULLS LAST, id`,
      )
      .bind(book, chapter)
      .all<TqRow>(),
    db
      .prepare(
        "SELECT * FROM twl_rows WHERE book = ?1 AND chapter = ?2 AND deleted_at IS NULL ORDER BY verse, sort_order ASC NULLS LAST, id",
      )
      .bind(book, chapter)
      .all<TwlRow>(),
    db
      .prepare(
        "SELECT * FROM verse_statuses WHERE book = ?1 AND chapter = ?2",
      )
      .bind(book, chapter)
      .all<VerseStatus>(),
  ]);

  // Reshape verses → verses[bibleVersion][verseNum] = VerseDto for easy client lookup.
  const verseMap: Record<string, Record<number, VerseDto>> = {};
  for (const v of verses.results) {
    if (!verseMap[v.bible_version]) verseMap[v.bible_version] = {};
    const { content_json, ...rest } = v;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content_json);
    } catch {
      parsed = null;
    }
    // Defensively renumber `\w` occurrence/occurrences from document position
    // so the client never sees malformed/colliding occurrence data (which
    // breaks note-quote highlight, chip colors, and the quote builder — all key
    // words by `${text}|${occurrence}`). No-op on clean verses.
    //
    // Source UHB/UGNT is included: our imported source carries NO x-occurrence
    // on `\w` (usfm-js leaves it undefined), so identical surface forms — e.g.
    // the two כָל in ZEC 5:3 — all collapse to `text|1` and a single note quote
    // lights up every copy. Numbering by position matches the source's own
    // occurrence semantics (and the ULT/UST \zaln-s occurrence: ZEC 5:3's
    // second כָל is occ 2 on both sides). This is display-only — D1 storage and
    // the nightly export still emit source verbatim, so round-trip stays exact.
    const vos = (parsed as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (Array.isArray(vos)) recomputeTargetOccurrences(vos);
    verseMap[v.bible_version][v.verse] = { ...rest, content: parsed };
  }

  const payload: ChapterPayload = {
    book,
    chapter,
    verses: verseMap,
    tn: tn.results,
    tq: tq.results,
    twl: twl.results,
    verseStatuses: statuses.results,
  };
  return c.json(payload);
});

// Toggle / set the done flag for a verse.
const StatusPatch = z.object({ done: z.boolean() });
chapters.patch("/:book/:chapter/:verse/status", requireEditor, async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  const verse = parseInt(c.req.param("verse"), 10);
  if (!book || !Number.isFinite(chapter) || !Number.isFinite(verse)) {
    return c.json({ error: "invalid_params" }, 400);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = StatusPatch.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const done = parsed.data.done ? 1 : 0;
  const now = Math.floor(Date.now() / 1000);
  const userId = currentUserId(c);
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO verse_statuses (book, chapter, verse, done, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(book, chapter, verse) DO UPDATE SET done = ?4, updated_at = ?5`,
      )
      .bind(book, chapter, verse, done, now),
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, user_id, prev_version, new_version, action, payload_json)
         VALUES ('verse_status', ?1, ?2, NULL, NULL, 'update', ?3)`,
      )
      .bind(`${book}/${chapter}/${verse}`, userId, JSON.stringify({ done: !!parsed.data.done })),
  ]);
  const row = await c.env.DB.prepare(
    `SELECT * FROM verse_statuses WHERE book = ?1 AND chapter = ?2 AND verse = ?3`,
  )
    .bind(book, chapter, verse)
    .first<VerseStatus>();
  if (row) {
    c.executionCtx.waitUntil(
      broadcastChapter(c.env, row.book, row.chapter, { type: "verse_status.updated", status: row }),
    );
  }
  return c.json(row);
});

// Book-level summary: chapter list + row counts. Useful for the timeline.
chapters.get("/:book", async (c) => {
  const book = c.req.param("book").toUpperCase();
  const db = c.env.DB;
  const summary = await db
    .prepare(
      `SELECT chapter,
              SUM(CASE WHEN kind='verse' THEN 1 ELSE 0 END) AS verses,
              SUM(CASE WHEN kind='tn' THEN 1 ELSE 0 END) AS tn,
              SUM(CASE WHEN kind='tq' THEN 1 ELSE 0 END) AS tq,
              SUM(CASE WHEN kind='twl' THEN 1 ELSE 0 END) AS twl
       FROM (
         SELECT chapter, 'verse' AS kind FROM verses WHERE book = ?1 AND bible_version = 'ULT'
         UNION ALL
         SELECT chapter, 'tn' FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL
         UNION ALL
         SELECT chapter, 'tq' FROM tq_rows WHERE book = ?1 AND deleted_at IS NULL
         UNION ALL
         SELECT chapter, 'twl' FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL
       )
       GROUP BY chapter ORDER BY chapter`,
    )
    .bind(book)
    .all<{ chapter: number; verses: number; tn: number; tq: number; twl: number }>();
  return c.json({ book, chapters: summary.results });
});
